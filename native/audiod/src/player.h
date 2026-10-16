#pragma once

#include <juce_audio_devices/juce_audio_devices.h>
#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_events/juce_events.h>

#include <array>
#include <atomic>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "capture.h"
#include "click.h"
#include "midi_out.h"
#include "dsp/resample.h"

namespace field
{
class LiveSession;
class RingInput;
class CaptureInput;
struct CaptureBlock;
}

// A controller a MIDI take starts from, as `arm` passes it
// (instrument-knobs.md §2.8): channel from 0 to 15, controller from 0 to
// 119, value from 0 to 127.
struct ChaseSeed
{
    int channel = 0;
    int cc = 0;
    int value = 0;
};

// Owns the output device (or the null-output clock used in CI), the loaded
// file, the sample-accurate transport, and — once something arms — the
// input side of the same device (recording.md §5). Artifacts-only by
// design (playback.md §1): the player knows file paths and samples —
// never clips, tracks, or tempo maps. The record target it is handed is
// a name it writes into the take's manifest and nothing more.
//
// Threading contract: every public method is called with the JUCE message
// manager locked (server.cpp and main.cpp both hold it), so this class
// adds no locking of its own beyond the transport's internal locks. The
// audio callback and the null clock only touch the transport, which is
// safe by JUCE's design.
class Player : private juce::AudioIODeviceCallback, private juce::MidiInputCallback
{
public:
    explicit Player (bool useNullOutput);
    ~Player() override;

    // Empty string on success, otherwise the error.
    juce::String initialise();

    juce::var deviceList();
    juce::String selectDevice (const juce::String& name);

    // Whether the platform will *tell* us the hardware moved. Only Core
    // Audio does (the property listeners in player.cpp, #16); everywhere
    // else the heartbeat has to look, so main.cpp reads this instead of
    // branching on the preprocessor itself
    // (linux-portability.md decision 2).
    static constexpr bool hardwareListenersAvailable =
#if JUCE_MAC
        true;
#else
        false;
#endif

    // Re-reads the audio world after a hot-plug or default-output change
    // (message thread; marshalled from the Core Audio listener on macOS,
    // polled from the heartbeat elsewhere). The daemon follows the system
    // default live unless the user explicitly selected a device; a
    // selection whose device vanishes resets to the default. This is what
    // keeps a long-lived daemon's output honest against the `*` in
    // `field devices` (#16).
    void refreshAudioDevice();

    // Returns {error} or {samples, sample_rate, channels}. With loop the
    // reader wraps at end-of-file — gapless, sample-exact — and the
    // stream never finishes: stop is the only way out, which is exactly
    // the blocking-play contract `field play --loop` wants.
    juce::var load (const juce::File& file, bool loop);


    // Live session (realtime.md chunk 2): replaces the loaded file as the
    // audio source; the transport verbs drive the session clock instead.
    // Returns {error} or {samples, sample_rate, channels}. Loading a file
    // afterwards drops the session, and vice versa. Enter WITHOUT the
    // MessageManagerLock: construction instantiates plugins, which
    // marshal to the message thread — a caller holding the lock would
    // wait on itself (minjudd's P1 on #150). The install takes the lock
    // internally, so player state stays message-thread-owned; the
    // replaced session dies on the message thread later, because AU
    // teardown under any held lock is the same deadlock again
    // (retireOnMessageThread in player.cpp).
    juce::var loadSession (const juce::var& session, const juce::File& projectRoot);
    juce::String liveRamp (const juce::String& track, int input, double gainDb, double rampMs);

    // Live inputs (live-supercollider.md §2): the `input` op makes a ring
    // FieldOut writes, under a name a session's input window reads, and
    // answers the ring's number. A session holds the rings it reads, so
    // closing one it still plays only frees the name.
    juce::var openInput (const juce::String& name, const void* owner = nullptr);
    juce::String closeInput (const juce::String& name);
    // Closes every input `owner`, a connection, opened: the server calls
    // it when that connection drops.
    void closeInputsOwnedBy (const void* owner);
    // Retires every ring: they are system-wide objects that outlive the
    // process unless unlinked, and an exit that skips destructors would
    // leave them behind.
    void closeInputs();
    bool liveMode() const { return liveSession != nullptr; }

    // MIDI outputs (sequencer.md §2.5): `midi_out` opens an output or
    // replaces its schedule, and answers {error} or {name, events,
    // pulses}. An output closes with the connection that opened it,
    // `owner`, as an input does, and every close ends its notes.
    juce::var openMidiOutput (const juce::var& request, const void* owner);
    juce::String closeMidiOutput (const juce::String& name);
    void closeMidiOutputsOwnedBy (const void* owner);
    void closeMidiOutputs();
    // Heartbeat: frees the schedules the callback has swapped out.
    void serviceMidiOutputs() { midiOutputs.reclaim(); }

    juce::String play();
    void pause();
    void stop(); // pause + rewind to 0
    juce::String locate (juce::int64 sample);

    // consumePeak: the status op passes true, so a client reading the
    // meter gets the peak since the last client read and resets it. The
    // heartbeat reads status four times a second for its own events and
    // must not consume the meter — it did at first, and every client
    // then saw at most a quarter-second window, which on a busy CI runner
    // read a sawtooth that spans ±1 as 0.48.
    juce::var status (bool consumePeak = false);

    // "playing" | "paused" | "stopped"; drives state-change events (main.cpp).
    juce::String transportState();

    // True once the loaded file has played to its end; main.cpp turns this
    // into a stop plus a broadcast state event.
    bool streamFinished() const;

    bool nullOutput() const { return nullMode; }

    // Recording (recording.md §5–6). arm opens the input side — the
    // duplex open happens here, not at spawn, so a playback-only session
    // never triggers the microphone prompt — and names the track and the
    // 1-based input channel the take will record. Returns {error} or the
    // device facts: {device, input, channels, sample_rate, input_latency,
    // output_latency}. Re-arming while armed moves the input; arming
    // while recording is refused.
    juce::var arm (const juce::String& track, const juce::String& device, int input);
    // Arming for MIDI (keyboard-instrument.md §12.4) opens every MIDI
    // input the system lists but the daemon's own outputs' sources, and
    // no audio input, so it never asks for the microphone. Returns {error} or {kind, sources, sample_rate,
    // output_latency}. Like arm, it moves an existing arm of either kind.
    juce::var armMidi (const juce::String& track, const std::vector<ChaseSeed>& seeds = {});
    // Arms several tracks at once (arming.md §2.2): each entry is
    // {track, kind: "audio", input} or {track, kind: "midi"}. An audio
    // entry takes its own input channel on `device`; a MIDI entry hears
    // every MIDI source. An audio entry with `monitor`, a name, also opens
    // a capture input under that name for a session's input window to
    // read (live-supercollider.md §12), owned by `owner`, the connection,
    // and closed at disarm or when that connection drops. The first audio entry, or the first entry when
    // none is audio, is the primary that every capture rule runs on; the
    // rest are companions that start on its latch and end with its pass.
    // arm and armMidi are this with one entry. Returns {error} or
    // {armed, sample_rate, output_latency}, plus the audio side's
    // {device, input, channels, input_latency} and the MIDI side's
    // {sources}, and {kind: "midi"} when the one entry is MIDI.
    // `seeds` are the controllers a MIDI take starts from (below).
    juce::var armSet (const juce::Array<juce::var>& tracks, const juce::String& device,
                      const std::vector<ChaseSeed>& seeds = {}, const void* owner = nullptr);
    // Closes the input side again. Empty string on success.
    juce::String disarm();
    // Start a take: locate to `at` when given (a source must be loaded
    // for that), start the transport if it is not running, and capture
    // from the next block. The callback latches the transport position
    // of that block as started_at_samples; the response waits for the
    // latch so it can report it. Returns {error} or {transaction,
    // started_at_samples}.
    //
    // With `start` (recording.md §7's count-in, and the punch-in it
    // amounts to): locate to `start` instead, play, and capture from the
    // first sample at or after `at` — mid-block, so started_at_samples
    // is `at` exactly — while status reports the take as pending. The
    // response then returns at once with started_at_samples -1.
    //
    // With `until` (§10.4's punch-out): the take ends on that exact
    // sample and finalizes from the heartbeat (serviceCapture); the
    // transport keeps going. With `loop` too, the live session loops the
    // region [at, until) and every pass is a take: the next transaction
    // is opened ahead of the wrap, so the pass that ends and the pass
    // that begins hand off inside one block with no sample lost.
    //
    // Armed for MIDI, the take is a MidiCapture and the same latch starts
    // it; loop takes stay audio only.
    juce::var record (const juce::var& at, const juce::var& start, const juce::var& until, bool loop);
    // Heartbeat: finalize each take the callback ended at its `until`,
    // hand it to onTake, and when looping, keep the next pass's take
    // open ahead of its wrap.
    void serviceCapture();
    // The live session's region loop (recording.md §10.4): the clock
    // wraps from `to` back to `from`. Equal bounds clear it. Empty
    // string on success.
    juce::String setLoopRegion (juce::int64 from, juce::int64 to);
    // The metronome (recording.md §7): a schedule the CLI projected from
    // the tempo map, rendered into the output by the callback (click.h).
    // A load or a fresh session clears it — a schedule belongs to a bed.
    juce::String setClick (const juce::var& schedule);
    int clickTicks() const { return click.tickCount(); }
    // Finalize the take in progress: the callback stops pushing, the
    // writer drains, the header is patched, the manifest is final.
    // Returns every armed track's manifest, the primary's first, or none
    // when nothing was recording. stop() and pause() call this first; a
    // natural end of stream reaches it through stop() too.
    juce::Array<juce::var> stopRecording();
    // "idle" | "armed" | "recording" — drives record events (main.cpp).
    juce::String recordState() const;
    // An armed or recording daemon must not idle-exit (recording.md §5):
    // a take would die to a timeout.
    bool recordingPinned() const { return armed.load() || capture != nullptr; }
    // The transactions under .field/recording/, and recovery of one a
    // dead daemon left behind (capture.h).
    juce::var recordings() const;
    juce::var recover (const juce::String& id) const;
    // Set by main.cpp: a finalized take's manifest, however the take
    // ended (a stop op, a remote stop, end of stream), so every client
    // hears about it.
    std::function<void (const juce::var&)> onTake;

private:
    void audioDeviceIOCallbackWithContext (const float* const* inputChannelData,
                                           int numInputChannels,
                                           float* const* outputChannelData,
                                           int numOutputChannels,
                                           int numSamples,
                                           const juce::AudioIODeviceCallbackContext& context) override;
    void audioDeviceAboutToStart (juce::AudioIODevice* device) override;
    void audioDeviceStopped() override;
    // JUCE's MIDI thread: queue the message for the callback to stamp.
    void handleIncomingMidiMessage (juce::MidiInput* source, const juce::MidiMessage& message) override;

    juce::int64 positionSamples() const;
    void maybeMatchDeviceRate (double fileRate);

    // The one block both the device callback and the null clock go
    // through: the output pull, then the capture tap over the input.
    // Pulling first is what yields the transport position the tap
    // latches; the pull is handed the input too, for the capture inputs
    // a monitored session reads (live-supercollider.md §12).
    void processBlock (const float* const* in, int numInputs, float* const* out, int numOutputs, int n);
    // The output pull: the live session when one is loaded (behind a
    // try-lock — a missed block during a message-thread edit is silence,
    // not a glitch), the file transport otherwise. Returns the transport
    // position at the start of the block, or -1 when the lock was missed
    // and the block is silence — a capture start defers to the next
    // block then, which keeps the latch and the first pushed samples
    // describing the same instant.
    juce::int64 pullAudio (const float* const* in, int numInputs, float* const* out, int numChannels, int n);
    // The MIDI take's share of a block (keyboard-instrument.md §12.4):
    // the start latch, stamping each queued arrival against the instant
    // the block began, the samples elapsed, and the end at `until`.
    void recordMidiBlock (field::MidiCapture& take, juce::int64 position, juce::int64 freeBefore, int n,
                          double blockStartMs);
    // The audio take's share of a block: the start latch, the push of the
    // primary's input and each audio companion's, punch-out, and the loop
    // hand-off.
    void recordAudioBlock (const float* const* in, int numInputs, const float* input, juce::int64 position,
                           juce::int64 freeBefore, int n);
    // The MIDI clock's share of a block, for whichever takes `push` hands
    // the messages to: stamp what arrived since the last block, advance
    // the clock, and count the samples. Returns the block's start on the
    // clock, which the end at `until` is tested against.
    template <typename Push, typename Frames>
    juce::int64 stampMidiBlock (juce::int64 untilFrames, int n, double blockStartMs, Push&& push, Frames&& frames);
    // An audio primary's MIDI companions: the shared stamping, and their
    // end a block after the audio's, as a MIDI take ends.
    void recordMidiCompanions (int n, double blockStartMs);
    // The span the MIDI clock runs to: `until` on the bed's timeline,
    // converted to the device's samples from `take`'s start.
    juce::int64 midiUntilFrames (const field::Transaction& take) const;
    // The callback array index of a 1-based device input, given the armed
    // inputs: the array holds only active channels, in channel order.
    int channelIndex (int input) const;
    // armSet's duplex open of the armed inputs. Returns an error, empty on
    // success, and leaves the device as it was on one.
    juce::String openAudioInputs (const juce::String& device, const juce::Array<int>& inputs, juce::String& name,
                                  int& channels, int& inputLatency, int& outputLatency);
    // A take's final manifest, or {error} when finalize threw.
    juce::var finalizeTake (field::Transaction& take);
    // Hands each manifest that is not an error to onTake, in order.
    void announceTakes (const juce::Array<juce::var>& manifests);
    // Hands each queued arrival to `handle` in arrival order and empties
    // the queue; audio thread only.
    template <typename Handle>
    void drainMidiArrivals (Handle&& handle);
    juce::String closeAudioInput(); // empty on success
    void closeMidiInputs();


    void registerHardwareListeners();
    void removeHardwareListeners();

    const bool nullMode;
    // A test seam, honoured only with null output: how long the heartbeat
    // stalls between taking over a finished take and finalizing it, from
    // FIELD_AUDIOD_SERVICE_STALL_MS. It makes a slow disk or a loaded
    // runner exact, so a test can land a loop's wrap inside a finalize.
    const int serviceStallMs;
    // The same, for `record`: how long it stalls after opening a take's
    // transactions, from FIELD_AUDIOD_OPEN_STALL_MS, so a test can make
    // the open outlast the blocks a rolling bed plays meanwhile.
    const int openStallMs;
    // And between a block's pull and its latch, from
    // FIELD_AUDIOD_LATCH_STALL_MS, so a test can land record's hold
    // between the two.
    const int latchStallMs;
    // And whether MIDI capture hears the daemon's own outputs, from
    // FIELD_AUDIOD_CAPTURE_OUTPUTS=1, so a test can record a schedule in
    // the daemon that sends it.
    const bool captureOwnOutputs;
    // locate without its refusal under a take: record jumps to `at` once
    // its transactions are open.
    juce::String seek (juce::int64 sample);
    // True once device.select succeeds; cleared if that device vanishes.
    bool explicitSelection = false;
#if JUCE_MAC
    bool hardwareListenersRegistered = false;
#endif
    juce::AudioDeviceManager deviceManager;
    juce::AudioFormatManager formatManager;
    juce::TimeSliceThread readThread { "audiod file reader" };
    std::unique_ptr<juce::AudioFormatReaderSource> readerSource;
    juce::AudioTransportSource transport;

    juce::String loadedPath;
    double fileSampleRate = 0.0;
    juce::int64 fileLengthSamples = 0;
    int fileChannels = 0;
    bool everStarted = false; // distinguishes "stopped at 0" from "never played"
    bool looping = false;


    // The live session and its transport-facing facts. livePlaying is
    // read in the audio callback; the lock covers session access.
    std::unique_ptr<field::LiveSession> liveSession;
    juce::CriticalSection liveLock;
    // The rings by input name; the session op reads it outside the
    // message lock, so it has its own.
    std::mutex inputsLock;
    struct OpenInput
    {
        std::shared_ptr<field::RingInput> ring;
        const void* owner = nullptr; // the connection that opened it
    };
    std::map<std::string, OpenInput> rings;
    // The armed inputs a session can hear (live-supercollider.md §12), by
    // input name, under inputsLock with the rings; the callback presents
    // its input block to them through captureBlock.
    struct OpenCapture
    {
        std::shared_ptr<field::CaptureInput> input;
        const void* owner = nullptr;
    };
    std::map<std::string, OpenCapture> captures;
    std::shared_ptr<field::CaptureBlock> captureBlock;
    // Closes every capture input, or those `owner` opened. Takes inputsLock.
    void closeCaptures (const void* owner = nullptr);
    std::atomic<bool> livePlaying { false };
    juce::int64 liveLength = 0;
    juce::String liveSong;
    // The track soloed in the loaded session, when its compile had one,
    // so a command reloading the song can keep it.
    juce::String liveSolo;
    bool liveLoop = false;
    int liveRate = 0;
    bool liveEverStarted = false;

    // Delivery conversion (cross-rate-live.md decision 3): when the
    // device cannot switch to the session's rate, the output stream
    // runs through the streaming resampler instead of refusing.
    // Rebuilt — which is also the reset the plan specifies — under
    // liveLock at locate, stop, and device start; null when the rates
    // agree. A session swap keeps the converter and its FIFO when the
    // (session, device) rate pair is unchanged — the queued audio is
    // exactly what the ear should hear next, and dropping it skipped
    // 10–20 ms on every live-watch edit (minjudd's finding on #143) —
    // so loadSession installs prepared state instead of calling this.
    // convOut is the converted FIFO the callback drains; convQueued
    // mirrors its unread frame count for status (the in-flight skew
    // decision 3 bounds); completion is checked under liveLock in
    // streamFinished, where the mirror would race the final callback.
    void rebuildLiveConverter();
    double currentDeviceRate() const;
    std::unique_ptr<field::dsp::Resampler> liveConverter;
    std::vector<std::vector<float>> convIn;
    std::vector<std::vector<float>> convOut;
    size_t convOutRead = 0;
    bool convFlushed = false;
    std::atomic<juce::int64> convQueued { 0 };
    // The rate pair the conversion state was built for, so a swap can
    // tell a same-pair edit (keep everything) from a real change.
    double convLiveRate = 0.0;
    double convDeviceRate = 0.0;

    // Null-output mode: a thread pulls the transport at real-time pace so
    // transport, position, and end-of-stream all behave exactly as with a
    // device — CI runs the full protocol with no audio hardware. Armed,
    // the same thread presents an input: two channels, a sawtooth
    // encoding the input clock on the first and a constant on the second
    // (nullInputBlock), so a test can prove a take is gapless and that
    // channel selection picked the channel it named.
    std::thread nullClock;
    std::atomic<bool> nullClockRunning { false };

    // Recording state. The message thread owns armed*, capture and the
    // Facts; the callback reads activeCapture, captureChannel and the
    // start request. activeCapture is cleared before finalize, and
    // finalize waits for callbackEpoch to advance twice — the block in
    // flight and one more — so no push can be running when the Capture
    // dies (the same discipline as the live session's try-lock, in the
    // other direction).
    std::atomic<bool> armed { false }; // read by the null clock to present its input
    // Armed for MIDI rather than audio: the null clock presents no input
    // then, and a take is a MidiCapture.
    std::atomic<bool> armedMidi { false };
    juce::String armedTrack;
    juce::String armedDevice;
    int armedInput = 0;
    std::unique_ptr<field::Transaction> capture;
    std::atomic<field::Capture*> activeCapture { nullptr };
    std::atomic<field::MidiCapture*> activeMidiCapture { nullptr };
    // Which of the callback's input channels to capture. A real device
    // is opened with exactly one input channel active, and the callback
    // array holds only active channels, so this is 0 there; the null
    // clock presents the selected null channel the same way.
    std::atomic<int> captureChannel { 0 };
    // Null mode only: which of the null input's two channels the clock
    // presents, a bit per 1-based input, in channel order, as a real
    // duplex open presents the active ones.
    std::atomic<int> nullInputMask { 0 };
    // The 1-based inputs open on the device, ascending (message thread).
    juce::Array<int> armedInputs;
    std::atomic<bool> captureStartRequested { false };
    // Audio thread: whether this block's pull saw captureStartRequested
    // set, under liveLock. record arms the request and jumps to `at` in one
    // hold of that lock, so a block that saw it pulled after the jump, and
    // one that did not may have read the position from before it.
    bool blockSawRequest = false;
    // Audio thread: what the MIDI outputs need to know of the bed this
    // block's pull played, read under liveLock with its position.
    struct BedFacts
    {
        bool missed = false; // the pull missed liveLock
        double rate = 0.0;
        bool exact = true; // the bed advances by the block's frames exactly
        juce::int64 wrapFrom = 0;
        juce::int64 wrapTo = 0;
    };
    BedFacts blockBed;
    std::atomic<bool> captureStarted { false };
    // The position the requested take waits for (record's `at` when a
    // `start` was given); -1 means the next block, whatever its position.
    std::atomic<juce::int64> captureStartAt { -1 };
    // Punch-out and loop takes (recording.md §10.4). captureUntil is
    // where the callback ends the active take (-1: never); captureLoop
    // says the next pass is a take too, read from standbyCapture — the
    // transaction the message thread opened ahead of the wrap, which the
    // callback takes over only at a wrap — and capturesEnded counts the
    // takes the callback has ended that the heartbeat has not finalized
    // yet: a loop can end two between ticks. captureMissed counts passes
    // that began with no standby ready, each skipped whole.
    //
    // Under a loop, `capture` is the oldest take not yet finalized: the
    // one recording, one the callback has ended, or the next pass's,
    // waiting in standbyCapture for the wrap that begins it. `standby`
    // is the one after it, if any. The callback begins and ends takes
    // in the order they were opened, so the heartbeat hands ownership
    // over by counting ends, never by reading the slot the callback can
    // empty at any moment.
    std::atomic<juce::int64> captureUntil { -1 };
    std::atomic<bool> captureLoop { false };
    std::atomic<int> capturesEnded { 0 };
    std::atomic<field::Capture*> standbyCapture { nullptr };
    std::atomic<int> captureMissed { 0 };
    std::unique_ptr<field::Capture> standby;
    int loopTakes = 0; // takes finalized in the current loop
    // A loop take's region is the take itself, so a session swap carries
    // it onto the incoming session as it carries the transport; without
    // it the clock would run on past `until` and every block would end a
    // pass. Outside a loop take it clears the incoming session's region.
    // Returns an error, empty on success, when the region does not fit.
    juce::String carryTakeRegion (field::LiveSession& session) const;
    // Everything a new transaction needs, kept for the standbys a loop
    // opens after the first.
    field::Transaction::Facts takeFacts() const;
    field::Transaction::Facts takeFacts (const juce::String& track, int input) const;
    std::unique_ptr<field::Capture> openCapture();

    // Arming several tracks (arming.md §2.2). The companions are the armed
    // tracks after the primary; they start on its latch and end with its
    // pass, and loop takes refuse them. The callback reads the first
    // liveCompanions slots, and only through atomics, so the message
    // thread can set a slot's other fields while it is not live. Slots
    // never move.
    struct Companion
    {
        juce::String track;
        int input = 0; // audio: the 1-based device input
        std::unique_ptr<field::Transaction> take; // message thread
        std::atomic<bool> midi { false };
        std::atomic<int> channel { 0 }; // audio: the callback array index
        std::atomic<field::Capture*> audio { nullptr };
        std::atomic<field::MidiCapture*> midiTake { nullptr };
        std::atomic<float> peak { 0.0f };
    };
    static constexpr int maxCompanions = 15;
    std::array<Companion, maxCompanions> companions;
    int companionCount = 0;
    std::atomic<int> liveCompanions { 0 };
    // An audio primary's MIDI companions are taking: set by the latch,
    // cleared when they end a block after the audio, or by a stop.
    std::atomic<bool> companionMidiRunning { false };
    field::Click click;
    std::atomic<juce::uint64> callbackEpoch { 0 };
    // Returns once a block begun after the call has finished, or after
    // 300 ms when the device is not running, where nothing is in a block.
    void waitOutBlocks() const;
    // Largest |sample| on the armed input since status last read it; the
    // V1 meter (recording.md §11's meters question, resolved in §12).
    std::atomic<float> inputPeak { 0.0f };
    // The capture position when nothing is loaded: a free clock from
    // arm, so a take with no bed still has a definite, if arbitrary,
    // placement.
    std::atomic<juce::int64> freeClock { 0 };
    // Zeros the tap pushes when a take is running and the callback
    // arrived with no input channel (the device restarted without one):
    // the take stays gapless and its placement stays right. Sized for
    // the device's block on start.
    std::vector<float> silence;

    // MIDI capture (keyboard-instrument.md §12.4). The inputs and their
    // names belong to the message thread. Arrivals cross from JUCE's MIDI
    // thread to the callback through a FIFO of fixed-size records, each
    // stamped with its arrival on getMillisecondCounterHiRes()'s clock;
    // the write lock serializes MIDI threads only (JUCE does not promise
    // one thread for every input), and the callback never takes it.
    struct MidiArrival
    {
        double ms = 0.0;
        int size = 0;
        juce::uint8 bytes[field::MidiCapture::maxMessageBytes] {};
    };
    static constexpr int midiArrivalCapacity = 4096;
    std::vector<std::unique_ptr<juce::MidiInput>> midiInputs;
    juce::StringArray midiSources;
    juce::AbstractFifo midiArrivals { midiArrivalCapacity };
    std::vector<MidiArrival> midiArrivalRing = std::vector<MidiArrival> ((size_t) midiArrivalCapacity);
    juce::SpinLock midiArrivalWrite;
    std::atomic<int> midiArrivalsLost { 0 }; // the queue was full
    // Audio thread only: the MIDI take's position at the start of the
    // current block and of the one before it, in samples from its start,
    // and the last `at` it wrote, which keeps the take's messages in
    // order.
    juce::int64 midiTakeClock = 0;
    juce::int64 midiFloor = 0;
    juce::int64 midiLastAt = 0;

    // The chase (instrument-knobs.md §2.8): from the arm, the latest value
    // of each controller from 0 to 119 on each channel, first those `arm`
    // seeds, then each control change that arrives before the take
    // starts. The take's first sample gets one line per controller, in
    // the order the values last arrived, ahead of every other line. The
    // audio thread owns the table; an arm hands it the seeds under a lock
    // the callback only ever tries.
    void takeChaseSeeds();
    void chaseArrival (const MidiArrival& arrival);
    template <typename Push>
    void writeChase (Push&& push);
    static constexpr int chasedControllers = 120;
    static constexpr int chaseSlots = 16 * chasedControllers;
    struct Chased
    {
        juce::uint32 order = 0; // 0: no value yet
        juce::uint8 value = 0;
    };
    std::array<Chased, chaseSlots> chase {};
    std::array<int, chaseSlots> chaseSorted {}; // writeChase's scratch
    juce::uint32 chaseNext = 1;
    // Set where the MIDI clock starts; the lines go in before the take's
    // first stamped message, so an arrival in the start block that falls
    // before the start sample is chased first.
    bool chasePending = false;
    std::array<ChaseSeed, chaseSlots> chaseSeeds {};
    int chaseSeedCount = 0;
    std::atomic<bool> chaseSeeded { false };
    juce::SpinLock chaseSeedLock;

    field::MidiOutputs midiOutputs;
    field::MidiSender midiSender { midiOutputs };
};
