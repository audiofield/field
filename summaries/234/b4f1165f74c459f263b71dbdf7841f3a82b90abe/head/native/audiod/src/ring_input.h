#pragma once

#include <juce_core/juce_core.h>

#include <atomic>
#include <cstdint>
#include <string>

#include "live.h"

namespace field
{

// A ring the daemon owns and reads (live-supercollider.md §2): made by
// the `input` op, written by FieldOut in the voice host's scsynth
// (native/ring/field_ring.h), and read once per block by the session
// input window of the same name.
class RingInput final : public LiveInput
{
public:
    // Makes the shared-memory ring at a number nothing else holds. Throws
    // when the system refuses, and on Windows, which has no POSIX shared
    // memory.
    explicit RingInput (uint32_t sampleRate, uint32_t capacity = 8192);
    ~RingInput() override;
    RingInput (const RingInput&) = delete;
    RingInput& operator= (const RingInput&) = delete;

    uint32_t id() const { return ringId; }
    uint32_t capacity() const { return frames; }
    // The rate the ring is read at, for FieldOut to check its server's
    // against: the device's, set again once a session has settled it.
    void setSampleRate (uint32_t sampleRate);

    // Unlinks the name, so a later ring may take the number; a session
    // still holding this one keeps reading what it maps until it lets go.
    void retire();

    // The jitter buffer: it waits until it holds a block plus one writer
    // burst before it plays, the block being the largest any call has
    // asked for, so a block the session splits at a loop wrap reads
    // against the same margin as a whole one. When the writer runs fast
    // enough to hold twice that, the oldest frames go; when it runs dry,
    // the reader plays what it has, then waits to fill again. When the
    // writer dropped frames because nothing read for longer than the ring
    // holds, what is held is stale, and the reader starts at the present.
    void read (float* left, float* right, int n) override;
    juce::int64 readerMargin() const override { return (juce::int64) (block + writerBurst); }

    // For `status`: frames written, read, and dropped by the writer, how
    // often the reader ran dry, the frames it skipped for drift, and the
    // loudest sample it read since a client last read the peak, which
    // `consumePeak` resets, as the armed input's meter does.
    juce::var stats (bool consumePeak = false);

    // What the reader keeps in hand beyond its block: one burst of the
    // writer's, which the voice host runs at a 128-frame hardware buffer,
    // doubled for scheduling slack.
    static constexpr uint64_t writerBurst = 256;

private:
    uint32_t ringId = 0;
    uint32_t frames = 0;
    void* mapped = nullptr;
    size_t bytes = 0;
    bool linked = false;
    uint64_t at = 0; // frames read, the reader's own copy of the header's
    uint64_t block = 0; // the largest call so far
    uint64_t droppedSeen = 0; // the writer's dropped count at the last read
    bool primed = false;
    std::atomic<uint64_t> underruns { 0 };
    std::atomic<uint64_t> skipped { 0 };
    std::atomic<float> peak { 0.0f };
};

// --ring-selftest: a RingInput and a writer through field_ring.h, the
// code FieldOut runs, interleaved the way two callbacks are, in steady
// state, through a writer that stops, one that runs fast, and one with
// nothing reading. Empty string when every scenario holds.
std::string runRingSelfTest();

// --ring-feed: write a WAV into ring `id` as FieldOut would, in 128-frame
// bursts at the ring's rate in real time, so a test or a person can hear
// an input without SuperCollider. Empty string when the file went in.
std::string runRingFeed (uint32_t id, const std::string& wavPath);

} // namespace field
