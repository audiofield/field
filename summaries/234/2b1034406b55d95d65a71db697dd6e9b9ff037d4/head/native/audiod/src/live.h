#pragma once

#include <juce_core/juce_core.h>

#include <map>
#include <memory>
#include <string>
#include <vector>

#include "dsp/biquad.h"
#include "dsp/hall.h"
#include "dsp/limiter.h"
#include "dsp/plate.h"
#include "dsp/resample.h"
#include "dsp/reverb.h"
#include "hosting.h"

// The live session engine (realtime.md §3, chunk 2): evaluates the
// compiled graph the CLI sends — tracks, windows, chains — sample-exactly
// against the offline render, which is the golden-equivalence claim
// --render-live exists to prove.
//
// Evaluation is just-in-time offline rendering rather than a causal
// stream: every source is a committed or built file, so the future
// always exists, and a track's chain (whose limiter wants lookahead) is
// satisfied by producing children slightly ahead of the playback clock.
// Rings are therefore timeline-aligned full buffers — track lengths are
// compiler-computed and finite — and the compiler's comp_delay fields
// stay zero in practice until recording introduces a source whose future
// does not exist yet. Memory over machinery, deliberately: creek is
// ~7 MB of track buffers, the freeze chunk replaces most of them with
// cached stem files, and a streaming ring is an optimization this
// design leaves room for rather than a correctness requirement.
//
// The window arithmetic is mixdown.cpp's sumClips per sample, in clip
// order — same accumulation, same float roundings, same fades and
// balance law — and the loop fold on the output track replicates
// applyDeclaredLength's addition order, computed on read. Chains are the
// chunk-1 streaming classes, so block partitioning cannot move a bit.

namespace field
{

// A source outside the session (live-supercollider.md §2): what an
// `input` window plays, read once per block on the audio thread — the
// voice `field keys` plays. read() must not block, lock, or allocate,
// and fills silence for whatever it does not have.
class LiveInput
{
public:
    virtual ~LiveInput() = default;
    virtual void read (float* left, float* right, int n) = 0;
    // The frames the reader holds back beyond what it plays, which a MIDI
    // output with this input as its `lead_input` leads by too
    // (sequencer.md §2.5). Audio thread, as read() is.
    virtual juce::int64 readerMargin() const { return 0; }
};

// The sources a session's input windows name, by name.
using LiveInputs = std::map<std::string, std::shared_ptr<LiveInput>>;

class LiveSession
{
public:
    // Parses fail-closed (plan.cpp's discipline): any missing field,
    // unknown effect, unknown track ref, or negative live delay throws,
    // and nothing renders under a shape the two sides disagree about.
    // An input window must name a source in `inputs`.
    LiveSession (const juce::var& session, const juce::File& projectRoot,
                 const LiveInputs& inputs = {});

    int sessionRate() const { return rate; }
    juce::int64 lengthSamples() const { return length; } // 0 = unbounded
    bool looping() const { return loop || loopTo > loopFrom; }

    // A region loop (recording.md §10.4, the loop-start realtime.md
    // chunk 4 owed): the clock wraps from `to` back to `from` instead of
    // from the declared length back to zero, chains ringing across the
    // wrap exactly as they do at the extent. `to` must lie within the
    // session's content; equal bounds clear the region. Throws on a
    // region the session does not contain.
    void setLoopRegion (juce::int64 from, juce::int64 to);
    juce::int64 loopRegionFrom() const { return loopFrom; }
    juce::int64 loopRegionTo() const { return loopTo; }
    // Where the ear is on the timeline: the delivered position, wrapped
    // into whichever loop is in force.
    juce::int64 wrappedPosition() const { return wrap (delivered); }
    // The content's extent: the declared length, else the output's
    // natural length.
    juce::int64 extentSamples() const;

    // Fill `n` frames of the output track at the session clock, advancing
    // it; wraps at the declared length when looping (the fold included).
    // Channel counts beyond stereo are zero-filled.
    void renderBlock (float* const* out, int numChannels, int n);

    // Stopped, with an input (live-supercollider.md §7 question 2): the
    // overlay alone, through a second instance of the output's chain, so
    // what you play is heard over silence while the song's clock and
    // chains stay where they are.
    void renderIdle (float* const* out, int numChannels, int n);
    bool hasInputs() const { return ! inputSources.empty(); }
    // Clears renderIdle's chain and its delay, so playing over silence
    // after a stop or a pause carries nothing from before play. Message
    // thread, under the player's lock: it rebuilds stages, which
    // allocates.
    void resetIdle();

    void locate (juce::int64 sample);
    // What has been delivered to the device — the honest transport
    // position; the input clock runs ahead of it by any limiter window.
    juce::int64 position() const { return delivered; }

    // A window gain glide (session.ts rampRequestSchema): dB-linear over
    // rampMs, applied to contributions produced after the call. Throws on
    // an unknown track or input index.
    void ramp (const std::string& track, int input, double gainDb, double rampMs);

private:
    struct ChainStage
    {
        // Exactly one is set; a tiny variant without the ceremony.
        std::unique_ptr<dsp::Eq> eq;
        std::unique_ptr<dsp::Limiter> limiter;
        std::unique_ptr<dsp::Reverb> reverb;
        std::unique_ptr<dsp::Plate> plate;
        std::unique_ptr<dsp::Hall> hall;
        std::unique_ptr<LivePluginStage> plugin;
        // A limiter's output, reserved at build, so running the chain in
        // the callback never allocates for it.
        std::vector<std::vector<float>> scratch;
    };
    // Everything needed to rebuild a stage: locate discards chain state
    // (a seek does not inherit the previous position's tails) and
    // reconstructs from these.
    struct ChainSpec
    {
        int kind = 0; // 0 eq, 1 limit, 2 reverb, 3 plate, 4 hall, 5 plugin
        std::vector<dsp::Band> bands;
        bool normalize = false;
        dsp::LimiterSettings limiter;
        double horizonDb = 0.0;
        dsp::ReverbSettings reverb;
        dsp::PlateSettings plate;
        dsp::HallSettings hall;
        // A hosted insert (plugin-hosting.md chunk 2): everything the
        // stage needs to instantiate at load. A locate does not
        // reinstantiate — buildChain hands the surviving instance back
        // reset, because a rebuild under liveLock is dropped audio
        // (minjudd's P2 on #150).
        LivePluginStage::Spec plugin;
    };

    struct Window
    {
        enum Kind { file, track, receivePre, input } kind = file;
        int source = 0; // files[], tracks[], or inputSources[] index by kind
        juce::int64 start = 0;
        juce::int64 duration = 0;
        juce::int64 readOffset = 0;
        double gainDb = 0.0;
        double pan = 0.0;
        juce::int64 fadeIn = 0;
        juce::int64 fadeOut = 0;
        juce::int64 compDelay = 0;
        // Ramp state: gain glides from rampFromDb to gainDb across
        // [rampStart, rampStart + rampLength) on this track's input
        // timeline; produceUntil evaluates it per sample.
        double rampFromDb = 0.0;
        juce::int64 rampStart = -1;
        // Where the same glide starts on the overlay's clock, which keeps
        // moving while the transport is stopped (live-supercollider.md §9).
        juce::int64 overlayRampStart = -1;
        juce::int64 rampLength = 0;
    };

    struct Track
    {
        // Move-only, and said so: the chain holds unique_ptrs and
        // nothing ever copies a Track. MSVC's std::map move constructor
        // is not noexcept, so the two maps below make Track's implicit
        // move constructor not noexcept either, and vector<Track>
        // reallocation falls back through move_if_noexcept to the
        // implicit copy constructor, which cannot copy the chain.
        // libstdc++ and libc++ maps move noexcept, which is why this
        // only surfaced on Windows.
        Track() = default;
        Track (const Track&) = delete;
        Track& operator= (const Track&) = delete;
        Track (Track&&) = default;
        Track& operator= (Track&&) = default;

        std::string name;
        int rate = 0;
        std::vector<Window> windows;
        std::vector<ChainStage> chain;
        std::vector<ChainSpec> chainSpecs;
        juce::int64 preLength = 0; // content end (before the chain grows it)
        juce::int64 postLength = 0;
        bool needPre = false; // some cable taps pre
        // Timeline-aligned buffers; produced counts post-chain samples
        // emitted so far (the limiter's stream lag makes produced trail
        // fed), fed counts input samples pushed through the chain.
        std::vector<std::vector<float>> post; // [2][postLength]
        std::vector<std::vector<float>> pre; // [2][preLength], when needed
        // Materialized edge conversions (cross-rate-live.md decision 1):
        // this track's buffer converted wholesale to a consumer's rate
        // through the offline wrapper — the same kernel on the same
        // samples the offline convert node runs, so bit-identity with
        // the offline render is by construction. Keyed by consumer
        // rate; built off the audio thread at load.
        std::map<int, std::vector<std::vector<float>>> postConverted;
        std::map<int, std::vector<std::vector<float>>> preConverted;
        juce::int64 produced = 0;
        juce::int64 fed = 0;
    };

    void produceUntil (int trackIndex, juce::int64 outputSamples);
    // Produce the child in full and convert its buffer to targetRate,
    // once per (track, rate). Runs on the message thread — during the
    // load's pre-render recursion or the constructor's eager pass — so
    // the callback only ever finds the map populated.
    void ensureConverted (int trackIndex, int targetRate, bool pre);
    // startClock is where the rebuilt chain starts rendering on the
    // unwrapped timeline: zero at load, the warmup start at a locate —
    // the plate's LFO phase is a pure function of it (reverbs.md
    // decision 4).
    void buildChain (Track& track, juce::int64 startClock = 0) const;
    // The stages for `specs` at `trackRate`, reusing any hosted instance
    // already in `chain` (buildChain's rule) — the song's chain for a
    // track, or the overlay's second instance of it.
    void buildStages (std::vector<ChainStage>& chain,
                      const std::vector<ChainSpec>& specs,
                      int trackRate,
                      juce::int64 startClock) const;
    // The samples a chain withholds before its first output: its limiters'
    // lookahead and its hosted plugins' reported latency.
    static juce::int64 chainLatency (const std::vector<ChainStage>& chain);
    // The history the output chain must hear for its state at a
    // position to be right within the design's audibility threshold —
    // what locate renders and discards after a rebuild.
    juce::int64 chainWarmup (const Track& track) const;
    // Render forward to `sample`, discarding the audio: the chain hears
    // exactly what it would have, so its state afterwards is not an
    // approximation.
    void discardUntil (juce::int64 sample);
    // `absoluteFrom` is the unwrapped timeline position of `from` — the
    // output track mixes in wrapped time but ramps glide on real time,
    // so a fader move never reverses after a loop wrap.
    void mixInputBlock (Track& track,
                        juce::int64 from,
                        int n,
                        std::vector<std::vector<float>>& block,
                        juce::int64 absoluteFrom);
    // A window's linear gain at a position on the unwrapped timeline:
    // `baseGain` unless a ramp is gliding it.
    static double rampedGain (const Window& window, juce::int64 absoluteAt, double baseGain);
    // The glide itself, `into` samples after it started.
    static double glide (const Window& window, juce::int64 into);
    // Runs `working` through the chain from `fromStage`; a limiter stage
    // re-points working at what it emitted (which may be shorter while
    // its window primes).
    static void runChain (Track& track, std::vector<std::vector<float>>& working, size_t fromStage);
    static void runStages (std::vector<ChainStage>& chain,
                           std::vector<std::vector<float>>& working,
                           size_t fromStage);
    // End of input: flush each limiter and cascade what emerges through
    // the stages after it, appending to `working`.
    static void flushChain (Track& track, std::vector<std::vector<float>>& working);

    int rate = 0;
    juce::int64 length = 0;
    bool loop = false;
    juce::int64 loopFrom = 0; // region loop bounds; loopTo <= loopFrom means none
    juce::int64 loopTo = 0;
    juce::int64 wrap (juce::int64 unwrapped) const;
    int outputTrack = 0;
    juce::int64 clock = 0; // input timeline consumed
    juce::int64 delivered = 0; // output delivered (lags clock by chain latency)

    // Callback scratch, allocated at load so the audio thread never
    // touches the heap in steady state (children pre-render at load for
    // the same reason).
    std::vector<std::vector<float>> scratchBlock;
    std::vector<std::vector<float>> scratchMixed;

    // A hosted master stage's latency window is consumed at load, off
    // the callback (primeOutput): the first `latency` input samples run
    // through the chain there, and whatever emerged waits here for the
    // first callback to drain — otherwise a high-latency plugin would
    // make the first pull synchronously process its whole window
    // (#150 review).
    void primeOutput();
    std::vector<std::vector<float>> outputPending;
    size_t pendingRead = 0;

    std::vector<std::vector<std::vector<float>>> files; // preloaded, 1–2 ch
    std::vector<Track> tracks;
    std::map<std::string, int> trackIndex;

    // The overlay (live-supercollider.md §9): what an input reaches. A
    // track with an input window, and every track that places or
    // receives one, carries the input up through a second instance of
    // its chain, beside the song it pre-renders as before; the output
    // track adds what reaches it to its own mix before its own chain,
    // so the output's inserts hear the true sum. An input has no place
    // on the timeline, so it passes through each window's gain and pan
    // but not its start, duration, or fades, and reaches each consumer
    // once however often the arrangement places its track.
    //
    // Every path into a track is aligned to the longest: each feed waits
    // in a delay line for the difference, so an input reaching a track
    // two ways never meets itself offset.
    struct DelayLine
    {
        juce::int64 samples = 0;
        std::vector<std::vector<float>> line; // in flight
        std::vector<std::vector<float>> out; // this block, once through
    };
    struct OverlayInput
    {
        int window = 0; // the track's input window
        DelayLine delay;
    };
    struct OverlayEdge
    {
        int child = 0; // tracks[] index of the live track read
        int window = 0; // the consumer's first window reading it
        bool pre = false; // a pre-tap cable reads the child's pre-chain block
        DelayLine delay;
    };
    struct OverlayTrack
    {
        int track = 0;
        std::vector<OverlayInput> inputs;
        std::vector<OverlayEdge> edges;
        std::vector<ChainStage> chain; // empty for the output track
        // How late what reaches this track is, against its input, and
        // how late it leaves this track's chain.
        juce::int64 inLatency = 0;
        juce::int64 outLatency = 0;
        // This block: the mix before the chain, and after it. The chain's
        // emission runs through `delayed`, preloaded with the chain's
        // latency in zeros, so `post` is always exactly one block, late
        // by that latency — a limiter's lag varies block to block.
        std::vector<std::vector<float>> pre, post, delayed;
    };
    void buildOverlay();
    // Glides on the overlay's own clock, which advances with every block
    // the overlay renders, playing or stopped, so a ramp issued while the
    // transport is stopped finishes in real time instead of restarting
    // with every block.
    void renderOverlay (int n);
    juce::int64 overlayClock = 0;
    std::vector<std::shared_ptr<LiveInput>> inputSources;
    std::vector<OverlayTrack> overlay; // children before the tracks that read them
    std::vector<int> overlayIndex; // tracks[] → overlay[], -1 off the overlay
    std::vector<std::vector<float>> inputScratch;
    // renderIdle's instance of the output chain, its block, and the delay
    // that keeps each block whole across a limiter's varying lag.
    std::vector<ChainStage> idleChain;
    std::vector<std::vector<float>> idleBlock, idleDelayed;
    // Off while locate renders into the void: a source read there is
    // consumed off the audio thread and heard by nobody.
    bool overlayReadsInputs = true;
};

// --render-live: run a session offline, faster than realtime, into a
// float32 WAV — the graph-level golden instrument realtime.md decision 3
// requires. Not a render strategy (decision 1 keeps the build on stems);
// it exists so a live evaluation can be byte-compared against the
// offline artifact for the same graph. Empty string on success.
//
// With a click schedule (recording.md §7), the same Click layer the
// callback runs is added block by block at the session rate — never for
// a golden, only so a test can prove where the ticks land.
//
// Each of `inputFiles`, as `name=path.wav`, feeds the input window of
// that name from the file and then silence — the synthetic source
// live-supercollider.md chunk 1's goldens use.
std::string runRenderLive (const std::string& sessionPath,
                           const std::string& outputPath,
                           const std::string& rootPath,
                           const std::string& clickPath = {},
                           const std::vector<std::string>& inputFiles = {});

} // namespace field
