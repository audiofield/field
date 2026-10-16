#pragma once

#include <juce_core/juce_core.h>

#include <array>
#include <atomic>
#include <functional>
#include <memory>
#include <string>
#include <vector>

#if JUCE_MAC
#include <mach/semaphore.h>
#elif ! JUCE_WINDOWS
#include <semaphore.h>
#endif

// MIDI outputs (sequencer.md §2.5): schedules of MIDI messages on the
// bed's timeline that the daemon sends on time, from a virtual source it
// publishes or to a port that exists, such as a hardware synth's, with
// MIDI clock beside them. Like the click, a schedule is samples and
// bytes: the CLI projects the tempo map into it, and the daemon never
// learns what a note or a bar is.
//
// Three threads share an output. The message thread opens, replaces, and
// closes it. The audio callback finds the messages due in each block's
// lookahead window and pushes them, each with its time on
// juce::Time::getMillisecondCounterHiRes(), onto the output's lock-free
// queue, with no allocation and no lock. The sender thread sends each
// message at its time, or hands it to CoreMIDI ahead of its time when
// the sink schedules what it is given.

namespace field
{
class LiveInput;

// Where an output's messages go.
class MidiSink
{
public:
    virtual ~MidiSink() = default;
    // True when the sink takes a message ahead of its time and schedules
    // it for the time stamped on it, as CoreMIDI does for a destination;
    // false when it sends each message as it is handed one.
    virtual bool schedules() const = 0;
    virtual void send (const juce::uint8* bytes, int size, double ms) = 0;
    // Unschedules what send handed over for later.
    virtual void flush() {}
    // The identifier MIDI capture lists the sink's virtual source under,
    // or empty when it publishes none.
    virtual juce::String sourceIdentifier() const { return {}; }
};

struct MidiTarget
{
    juce::String name;
    bool source = false; // publish a virtual source of this name, rather than open a destination
};

// What one block of the callback plays, as the player's pull found it.
struct MidiBlock
{
    double startMs = 0.0;
    // The pull missed the live lock, so the block is silence and the bed
    // did not move.
    bool missed = false;
    bool rolling = false;
    juce::int64 position = 0; // where the block starts on the bed's timeline, wrapped
    juce::int64 advance = 0; // the bed samples the block plays
    // How far the next block's position may stray from this one's plus
    // its advance before it counts as a jump: 0 when the bed advances
    // exactly, as an unconverted live session does.
    juce::int64 slack = 0;
    // The wrap in force: the clock jumps from wrapTo back to wrapFrom.
    // None when wrapTo <= wrapFrom.
    juce::int64 wrapFrom = 0;
    juce::int64 wrapTo = 0;
    double bedPerFrame = 1.0; // bed samples per device frame, for an input's margin
};

class MidiOutputs
{
public:
    // Builds the sink an output sends through, or says why it cannot.
    using SinkFactory = std::function<std::unique_ptr<MidiSink> (const MidiTarget&, juce::String& error)>;
    // Finds an open input by name, for `lead_input`.
    using InputFinder = std::function<std::shared_ptr<LiveInput> (const juce::String&)>;

    // `waitOut` returns once the callback and the sender have each
    // finished a pass begun after the call, so an output either of them
    // held can be freed.
    MidiOutputs (SinkFactory makeSink, std::function<void()> wakeSender, std::function<void()> waitOut);
    ~MidiOutputs();

    // ---- Message thread -------------------------------------------------

    // The `midi_out` op: opens an output, or replaces the schedule of the
    // one open under the name, keeping its sink. Returns {error} or
    // {name, events} and, with a clock, {pulses}.
    juce::var open (const juce::var& request, const void* owner, const InputFinder& findInput);
    // Each ends the output's notes, stops its clock, and closes its sink.
    juce::String close (const juce::String& name);
    void closeOwnedBy (const void* owner);
    void closeAll();

    // An input opened under a name an output leads by.
    void bindLeadInput (const juce::String& name, const std::shared_ptr<LiveInput>& input);

    // Frees the schedules the callback has swapped out.
    void reclaim();

    bool publishes (const juce::String& sourceIdentifier) const;
    bool empty() const { return outputs.empty(); }
    // Each output's name, its source or destination, and its counters.
    juce::Array<juce::var> describe() const;

    // ---- Audio thread ---------------------------------------------------

    void play (const MidiBlock& block) noexcept;

    // ---- Sender thread --------------------------------------------------

    // Sends or hands over what is due by `nowMs`. Returns when the next
    // queued message is due, or infinity when nothing waits.
    double service (double nowMs);

    static constexpr int maxOutputs = 64;

private:
    struct Event
    {
        juce::int64 sample = 0;
        juce::uint8 bytes[3] {};
        juce::uint8 size = 0;
    };
    struct Schedule;
    struct Entry;
    struct Output;

    void play (Output& output, const MidiBlock& block) noexcept;
    // Pushes what lies `from` to `to` samples ahead of the block's
    // position, continuing at the wrap's start past its end.
    void take (Output& output, const MidiBlock& block, juce::int64 from, juce::int64 to, juce::int64 lead) noexcept;
    void push (Output& output, const Entry& entry) noexcept;
    // The clock's transport messages when the output starts rolling at
    // `position`, or jumps there while rolling.
    void resumeClock (Output& output, juce::int64 position, double ms, bool jump) noexcept;
    // Song Position Pointer for pulse `pulse`, then Continue, and the
    // pulse the clock resumes at.
    void positionClock (Output& output, size_t pulse, double ms) noexcept;
    double service (Output& output, double nowMs);
    void deliver (Output& output, const Entry& entry, double nowMs);
    void send (Output& output, const juce::uint8* bytes, int size, double ms, double nowMs);
    // Sends a note-off for every note the output holds. With `flush`,
    // first unschedules what a scheduling sink still holds.
    void endHeldNotes (Output& output, double ms, double nowMs, bool flush);
    Output* find (const juce::String& name) const;
    void closeWhere (const std::function<bool (const Output&)>& match);

    SinkFactory makeSink;
    std::function<void()> wakeSender;
    std::function<void()> waitOut;
    // Owned here, on the message thread; the callback and the sender
    // reach them through their own slots.
    std::vector<std::unique_ptr<Output>> outputs;
    std::array<std::atomic<Output*>, maxOutputs> blockSlots {};
    std::array<std::atomic<Output*>, maxOutputs> senderSlots {};
    std::atomic<int> slotsUsed { 0 }; // one past the highest slot ever filled
};

// Wakes a thread without a lock, which the audio callback can do, and
// sleeps one until a time on the high-resolution clock or a wakeup.
class Wakeup
{
public:
    Wakeup();
    ~Wakeup();
    Wakeup (const Wakeup&) = delete;
    Wakeup& operator= (const Wakeup&) = delete;
    void signal() noexcept;
    void waitUntil (double deadlineMs) noexcept;

private:
#if JUCE_MAC
    semaphore_t semaphore {};
#elif JUCE_WINDOWS
    void* semaphore = nullptr; // HANDLE, spelled void* to keep windows.h out of this header
#else
    sem_t semaphore {};
#endif
};

// The thread that sends each output's messages, at realtime priority so
// it wakes on time.
class MidiSender final : private juce::Thread
{
public:
    explicit MidiSender (MidiOutputs& outputs);
    ~MidiSender() override;
    void start();
    void wake() noexcept { wakeup.signal(); }
    // Returns once the thread has finished a pass begun after the call,
    // or at once when it is not running. Message thread.
    void waitOutPass();

private:
    void run() override;

    MidiOutputs& outputs;
    Wakeup wakeup;
    std::atomic<juce::uint64> passes { 0 };
};

// The sinks the daemon sends through: a virtual source it publishes, or
// an existing destination, which on macOS goes through CoreMIDI with
// each message stamped with its host time.
std::unique_ptr<MidiSink> makeMidiSink (const MidiTarget& target, juce::String& error);

#if JUCE_MAC
// CoreMIDI's host time and getMillisecondCounterHiRes() both count
// mach_absolute_time().
juce::uint64 hostTimeForMs (double ms);
double msForHostTime (juce::uint64 hostTime);
#endif

// --midi-out-selftest: the callback's selection, the lead and an input's
// margin, held notes, the clock's transport messages, and a stop with
// messages handed over early, against a fake clock and fake sinks.
// Empty string when every scenario holds.
std::string runMidiOutSelfTest();

} // namespace field
