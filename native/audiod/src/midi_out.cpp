#include "midi_out.h"

#include "keys.h"
#include "live.h"

#include <juce_audio_devices/juce_audio_devices.h>

#if JUCE_MAC
#include <CoreMIDI/CoreMIDI.h>
#include <mach/mach.h>
#elif JUCE_WINDOWS
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#else
#include <ctime>
#endif

#include <algorithm>
#include <chrono>
#include <cmath>
#include <initializer_list>
#include <limits>
#include <thread>

namespace field
{
namespace
{
constexpr double never = std::numeric_limits<double>::infinity();
constexpr juce::int64 unbounded = std::numeric_limits<juce::int64>::max();
constexpr int queueCapacity = 8192;
constexpr double lateMs = 1.0;
constexpr int noteSlots = 16 * 128;
// A loop much shorter than a block wraps more than once in it; past this
// many wraps the rest of the block's window is left out.
constexpr int maxLaps = 16;
constexpr juce::uint8 sustainPedal = 64; // the control change's number
constexpr juce::uint8 clockPulse = 0xf8, clockStart = 0xfa, clockContinue = 0xfb, clockStop = 0xfc, songPosition = 0xf2;

juce::DynamicObject::Ptr obj() { return new juce::DynamicObject(); }

juce::var failure (const juce::String& message)
{
    auto o = obj();
    o->setProperty ("error", message);
    return juce::var (o.get());
}

bool isNumber (const juce::var& v) { return v.isInt() || v.isInt64() || v.isDouble(); }
bool isWhole (const juce::var& v) { return isNumber (v) && (double) v == std::floor ((double) v); }

// How far the bed moved from `from` to `to`, along the wrap in force, or
// -1 when it could only have got there by a jump.
juce::int64 distance (juce::int64 from, juce::int64 to, const MidiBlock& block)
{
    if (to >= from)
        return to - from;
    if (block.wrapTo > block.wrapFrom && from < block.wrapTo && to >= block.wrapFrom)
        return (block.wrapTo - from) + (to - block.wrapFrom);
    return -1;
}
} // namespace

struct MidiOutputs::Schedule
{
    double rate = 0.0;
    juce::int64 lead = 0;
    std::shared_ptr<const std::vector<Event>> events;
    bool clock = false;
    std::shared_ptr<const std::vector<juce::int64>> pulses;
    std::shared_ptr<LiveInput> leadInput;
};

struct MidiOutputs::Entry
{
    // A message leaves at `ms`. A wrap ends the held notes at `ms`. A cut
    // ends them at once, and what was queued for after it never leaves.
    enum class Kind : juce::uint8
    {
        message,
        wrap,
        cut
    };
    double ms = 0.0;
    Kind kind = Kind::message;
    juce::uint8 size = 0;
    juce::uint8 bytes[3] {};

    static Entry message (double ms, const juce::uint8* bytes, int size)
    {
        Entry entry { ms, Kind::message, (juce::uint8) size, {} };
        std::copy (bytes, bytes + size, entry.bytes);
        return entry;
    }
    static Entry message (double ms, std::initializer_list<juce::uint8> bytes)
    {
        return message (ms, bytes.begin(), (int) bytes.size());
    }
    static Entry wrap (double ms) { return { ms, Kind::wrap, 0, {} }; }
    static Entry cut (double ms) { return { ms, Kind::cut, 0, {} }; }
};

struct MidiOutputs::Output
{
    ~Output()
    {
        delete next.load();
        delete current;
        delete spent.load();
    }

    juce::String name;
    MidiTarget target;
    const void* owner = nullptr;
    int slot = 0;
    std::unique_ptr<MidiSink> sink;
    bool schedules = false;
    // Message thread: the schedule last published, which a new binding of
    // the lead input copies.
    juce::String leadInputName;
    Schedule published;

    // A schedule passes from the message thread to the callback through
    // `next`, and back through `spent` once the callback has let it go.
    std::atomic<Schedule*> next { nullptr };
    Schedule* current = nullptr;
    std::atomic<Schedule*> spent { nullptr };

    // Audio thread: where the last block was, how far it expected to
    // advance, and how far ahead of it the window reached.
    bool rolling = false;
    bool pushed = false;
    juce::int64 lastPosition = 0;
    juce::int64 lastAdvance = 0;
    juce::int64 takenAhead = 0;
    // A new schedule's pulses count the song differently from the ones the
    // gear followed, so the next block moves the gear as a locate does.
    bool pulsesMoved = false;
    // Pulses before this sample wait for the next transport message.
    juce::int64 pulseFloor = 0;

    juce::AbstractFifo fifo { queueCapacity };
    std::vector<Entry> queue = std::vector<Entry> ((size_t) queueCapacity);

    // The sender thread's, and the message thread's once the output is
    // off the sender: the notes it holds, when each one's last note-off
    // was stamped for, and the latest time a scheduling sink was handed.
    std::array<bool, noteSlots> held {};
    std::array<double, noteSlots> offAt {};
    // Each channel's sustain pedal, and when its last release was stamped for.
    std::array<bool, 16> pedalDown {};
    std::array<double, 16> pedalUpAt {};
    double handedUntil = 0.0;

    std::atomic<juce::int64> sent { 0 };
    std::atomic<juce::int64> late { 0 };
    std::atomic<juce::int64> early { 0 };
    std::atomic<juce::int64> dropped { 0 };
};

MidiOutputs::MidiOutputs (SinkFactory sinks, std::function<void()> wake, std::function<void()> wait)
    : makeSink (std::move (sinks)), wakeSender (std::move (wake)), waitOut (std::move (wait))
{
}

MidiOutputs::~MidiOutputs() { closeAll(); }

juce::var MidiOutputs::open (const juce::var& request, const void* owner, const InputFinder& findInput)
{
    const auto name = request.getProperty ("name", juce::var());
    if (! name.isString() || name.toString().isEmpty())
        return failure ("midi_out needs a name");
    const auto source = request.getProperty ("source", juce::var());
    const auto destination = request.getProperty ("destination", juce::var());
    if (source.isVoid() == destination.isVoid())
        return failure ("midi_out takes a source or a destination, and not both");
    const auto port = source.isVoid() ? destination : source;
    if (! port.isString() || port.toString().isEmpty())
        return failure ("midi_out's source or destination is a MIDI port's name");
    const MidiTarget target { port.toString(), ! source.isVoid() };

    const auto rate = request.getProperty ("rate", juce::var());
    if (! isNumber (rate) || (double) rate <= 0.0)
        return failure ("midi_out needs a positive rate");
    const auto lead = request.getProperty ("lead", juce::var());
    if (! isWhole (lead) || (double) lead < 0.0)
        return failure ("midi_out's lead is a whole number of samples, 0 or more");
    const auto leadInput = request.getProperty ("lead_input", juce::var());
    if (! leadInput.isVoid() && (! leadInput.isString() || leadInput.toString().isEmpty()))
        return failure ("midi_out's lead_input is an input's name");

    const auto* list = request.getProperty ("events", juce::var()).getArray();
    if (list == nullptr)
        return failure ("midi_out needs an events array");
    auto events = std::make_shared<std::vector<Event>>();
    events->reserve ((size_t) list->size());
    for (int i = 0; i < list->size(); ++i)
    {
        const auto& item = list->getReference (i);
        const auto where = "midi_out's events[" + juce::String (i) + "]";
        const auto sample = item.getProperty ("sample", juce::var());
        if (! isWhole (sample) || (double) sample < 0.0)
            return failure (where + " needs a sample, a whole number 0 or more");
        Event event { (juce::int64) (double) sample, {}, 0 };
        int size = 0;
        if (auto error = readMidiBytes (item.getProperty ("midi", juce::var()), event.bytes, size); error.isNotEmpty())
            return failure (where + ": " + error);
        if (event.bytes[0] == 0xf0 || event.bytes[0] == 0xf7)
            return failure (where + ": SysEx is not a message an output schedules");
        event.size = (juce::uint8) size;
        if (! events->empty() && event.sample < events->back().sample)
            return failure (where + " comes before the event ahead of it: events are in time order");
        events->push_back (event);
    }

    auto pulses = std::make_shared<std::vector<juce::int64>>();
    const auto clock = request.getProperty ("clock", juce::var());
    if (! clock.isVoid())
    {
        const auto* samples = clock.getProperty ("pulses", juce::var()).getArray();
        const juce::String shape = "midi_out's clock is {pulses}, its samples in order, each a whole number 0 or more";
        if (samples == nullptr)
            return failure (shape);
        pulses->reserve ((size_t) samples->size());
        for (const auto& sample : *samples)
        {
            if (! isWhole (sample) || (double) sample < 0.0 || (! pulses->empty() && (juce::int64) (double) sample < pulses->back()))
                return failure (shape);
            pulses->push_back ((juce::int64) (double) sample);
        }
    }

    Schedule schedule;
    schedule.rate = (double) rate;
    schedule.lead = (juce::int64) (double) lead;
    schedule.events = events;
    schedule.clock = ! clock.isVoid();
    schedule.pulses = pulses;
    const auto leadInputName = leadInput.toString();
    if (leadInputName.isNotEmpty())
        schedule.leadInput = findInput (leadInputName);

    if (auto* existing = find (name.toString()))
    {
        if (existing->target.name != target.name || existing->target.source != target.source)
            return failure ("output \"" + existing->name + "\" sends " + (existing->target.source ? "from source " : "to destination ")
                            + existing->target.name + ": close it before naming another port");
        // The same pulses keep their pointer, which is how the callback
        // tells that the gear's count still holds.
        if (*schedule.pulses == *existing->published.pulses)
            schedule.pulses = existing->published.pulses;
        existing->leadInputName = leadInputName;
        existing->published = schedule;
        delete existing->spent.exchange (nullptr);
        delete existing->next.exchange (new Schedule (schedule));
    }
    else
    {
        for (const auto& output : outputs)
            if (output->target.name == target.name && output->target.source == target.source)
                return failure ("output \"" + output->name + "\" already sends " + (target.source ? "from source " : "to destination ")
                                + target.name);
        int slot = 0;
        while (slot < maxOutputs && blockSlots[(size_t) slot].load() != nullptr)
            ++slot;
        if (slot == maxOutputs)
            return failure ("the daemon has " + juce::String (maxOutputs) + " MIDI outputs open already");
        juce::String error;
        auto sink = makeSink (target, error);
        if (sink == nullptr)
            return failure (error);
        auto output = std::make_unique<Output>();
        output->name = name.toString();
        output->target = target;
        output->owner = owner;
        output->slot = slot;
        output->schedules = sink->schedules();
        output->sink = std::move (sink);
        output->leadInputName = leadInputName;
        output->published = schedule;
        output->current = new Schedule (schedule);
        senderSlots[(size_t) slot] = output.get();
        blockSlots[(size_t) slot] = output.get();
        slotsUsed = std::max (slotsUsed.load(), slot + 1);
        outputs.push_back (std::move (output));
    }

    auto result = obj();
    result->setProperty ("name", name);
    result->setProperty ("events", (int) events->size());
    if (schedule.clock)
        result->setProperty ("pulses", (int) pulses->size());
    return juce::var (result.get());
}

juce::String MidiOutputs::close (const juce::String& name)
{
    auto* output = find (name);
    if (output == nullptr)
        return "no MIDI output named \"" + name + "\"";
    closeWhere ([output] (const Output& o) { return &o == output; });
    return {};
}

void MidiOutputs::closeOwnedBy (const void* owner)
{
    if (owner != nullptr)
        closeWhere ([owner] (const Output& o) { return o.owner == owner; });
}

void MidiOutputs::closeAll()
{
    closeWhere ([] (const Output&) { return true; });
}

void MidiOutputs::closeWhere (const std::function<bool (const Output&)>& match)
{
    std::vector<std::unique_ptr<Output>> closing;
    for (auto it = outputs.begin(); it != outputs.end();)
    {
        if (match (**it))
        {
            blockSlots[(size_t) (*it)->slot] = nullptr;
            senderSlots[(size_t) (*it)->slot] = nullptr;
            closing.push_back (std::move (*it));
            it = outputs.erase (it);
        }
        else
        {
            ++it;
        }
    }
    if (closing.empty())
        return;
    waitOut();
    const double now = juce::Time::getMillisecondCounterHiRes();
    for (auto& output : closing)
    {
        // What the callback queued and the sender never took was for a
        // bed this output no longer follows.
        output->fifo.reset();
        endHeldNotes (*output, now, now, true);
        if (output->rolling && output->current->clock)
            send (*output, &clockStop, 1, now, now);
    }
}

void MidiOutputs::bindLeadInput (const juce::String& name, const std::shared_ptr<LiveInput>& input)
{
    for (auto& output : outputs)
    {
        if (output->leadInputName != name || output->published.leadInput == input)
            continue;
        output->published.leadInput = input;
        delete output->spent.exchange (nullptr);
        delete output->next.exchange (new Schedule (output->published));
    }
}

void MidiOutputs::reclaim()
{
    for (auto& output : outputs)
        delete output->spent.exchange (nullptr);
}

bool MidiOutputs::publishes (const juce::String& sourceIdentifier) const
{
    return sourceIdentifier.isNotEmpty()
           && std::any_of (outputs.begin(), outputs.end(), [&] (const std::unique_ptr<Output>& output)
                           { return output->sink->sourceIdentifier() == sourceIdentifier; });
}

juce::Array<juce::var> MidiOutputs::describe() const
{
    juce::Array<juce::var> list;
    for (const auto& output : outputs)
    {
        auto entry = obj();
        entry->setProperty ("name", output->name);
        entry->setProperty (output->target.source ? "source" : "destination", output->target.name);
        entry->setProperty ("sent", output->sent.load());
        entry->setProperty ("late", output->late.load());
        if (output->schedules)
            entry->setProperty ("early", output->early.load());
        entry->setProperty ("dropped", output->dropped.load());
        list.add (juce::var (entry.get()));
    }
    return list;
}

MidiOutputs::Output* MidiOutputs::find (const juce::String& name) const
{
    for (const auto& output : outputs)
        if (output->name == name)
            return output.get();
    return nullptr;
}

// ---- Audio thread -----------------------------------------------------------

void MidiOutputs::play (const MidiBlock& block) noexcept
{
    bool pushed = false;
    for (int i = 0, used = slotsUsed.load(); i < used; ++i)
        if (auto* output = blockSlots[(size_t) i].load())
        {
            output->pushed = false;
            play (*output, block);
            pushed = pushed || output->pushed;
        }
    if (pushed)
        wakeSender();
}

void MidiOutputs::play (Output& output, const MidiBlock& block) noexcept
{
    if (output.spent.load() == nullptr)
        if (auto* incoming = output.next.exchange (nullptr))
        {
            auto* outgoing = output.current;
            output.current = incoming;
            // Read before `spent` hands `outgoing` to the thread that frees it.
            const bool newEvents = incoming->events != outgoing->events;
            const bool newPulses = incoming->clock && incoming->pulses != outgoing->pulses;
            const bool clockEnded = outgoing->clock && ! incoming->clock;
            output.spent.store (outgoing);
            if (output.rolling)
            {
                output.pulsesMoved = output.pulsesMoved || newPulses;
                // A new binding of the lead input keeps the notes; new notes
                // end the old ones'. Moving the gear ends them on its own.
                if (newEvents && ! output.pulsesMoved)
                    push (output, Entry::cut (block.startMs));
                if (clockEnded)
                    push (output, Entry::message (block.startMs, { clockStop }));
            }
        }
    if (block.missed)
        return;
    const auto& schedule = *output.current;
    if (! block.rolling)
    {
        if (output.rolling)
        {
            push (output, Entry::cut (block.startMs));
            if (schedule.clock)
                push (output, Entry::message (block.startMs, { clockStop }));
        }
        output.rolling = false;
        output.pulsesMoved = false;
        return;
    }

    juce::int64 lead = schedule.lead;
    if (schedule.leadInput != nullptr)
        lead += (juce::int64) std::llround ((double) schedule.leadInput->readerMargin() * block.bedPerFrame);
    juce::int64 from = 0;
    if (! output.rolling)
    {
        if (schedule.clock)
            resumeClock (output, block.position, block.startMs, false);
    }
    else if (const auto moved = distance (output.lastPosition, block.position, block);
             ! output.pulsesMoved && moved >= 0 && std::abs (moved - output.lastAdvance) <= block.slack)
    {
        // Negative when the position landed past the last window's end.
        from = output.takenAhead - moved;
    }
    else
    {
        push (output, Entry::cut (block.startMs));
        if (schedule.clock)
            resumeClock (output, block.position, block.startMs, true);
    }
    const juce::int64 to = lead + block.advance;
    take (output, block, from, to, lead);
    output.takenAhead = std::max (from, to);
    output.lastPosition = block.position;
    output.lastAdvance = block.advance;
    output.rolling = true;
    output.pulsesMoved = false;
}

void MidiOutputs::take (Output& output, const MidiBlock& block, juce::int64 from, juce::int64 to, juce::int64 lead) noexcept
{
    const auto& schedule = *output.current;
    const auto& events = *schedule.events;
    const auto& pulses = *schedule.pulses;
    // An event `offset` samples ahead of the block's position leaves the
    // lead before it would sound, and no earlier than the block's start.
    const auto msAt = [&] (juce::int64 offset)
    { return block.startMs + (double) std::max<juce::int64> (0, offset - lead) * 1000.0 / schedule.rate; };
    const bool wraps = block.wrapTo > block.wrapFrom;
    juce::int64 offset = std::min<juce::int64> (0, from); // how far ahead of the block's position this stretch starts
    juce::int64 segment = block.position + offset; // where this stretch of the timeline starts
    // A window behind the position starts before the wrap the bed crossed.
    if (from < 0 && wraps && block.position < output.lastPosition && segment < block.wrapFrom)
        segment += block.wrapTo - block.wrapFrom;
    for (int lap = 0; lap < maxLaps; ++lap)
    {
        const juce::int64 end = wraps && segment < block.wrapTo ? block.wrapTo : unbounded;
        const juce::int64 lo = segment + std::max<juce::int64> (0, from - offset);
        const juce::int64 hi = end == unbounded || to - offset < end - segment ? segment + (to - offset) : end;
        auto event = std::lower_bound (events.begin(), events.end(), lo,
                                       [] (const Event& e, juce::int64 s) { return e.sample < s; });
        auto pulse = std::lower_bound (pulses.begin(), pulses.end(), std::max (lo, output.pulseFloor));
        for (;;)
        {
            const bool haveEvent = event != events.end() && event->sample < hi;
            const bool havePulse = schedule.clock && pulse != pulses.end() && *pulse < hi;
            if (havePulse && (! haveEvent || *pulse <= event->sample))
            {
                push (output, Entry::message (msAt (offset + *pulse - segment), { clockPulse }));
                ++pulse;
            }
            else if (haveEvent)
            {
                push (output, Entry::message (msAt (offset + event->sample - segment), event->bytes, event->size));
                ++event;
            }
            else
                break;
        }
        if (end == unbounded)
            return;
        offset += end - segment;
        if (offset > to)
            return;
        // A window holds a wrap at its end and not one at its start, so a
        // wrap where one block's window meets the next is pushed once.
        if (offset > from)
        {
            const double ms = msAt (offset);
            push (output, Entry::wrap (ms));
            if (schedule.clock)
            {
                push (output, Entry::message (ms, { clockStop }));
                positionClock (output, (size_t) (std::lower_bound (pulses.begin(), pulses.end(), block.wrapFrom) - pulses.begin()), ms);
            }
        }
        segment = block.wrapFrom;
    }
}

void MidiOutputs::resumeClock (Output& output, juce::int64 position, double ms, bool jump) noexcept
{
    const auto& pulses = *output.current->pulses;
    const auto next = (size_t) (std::lower_bound (pulses.begin(), pulses.end(), position) - pulses.begin());
    if (jump)
        push (output, Entry::message (ms, { clockStop }));
    if (! jump && next == 0)
    {
        push (output, Entry::message (ms, { clockStart }));
        output.pulseFloor = 0;
        return;
    }
    positionClock (output, next, ms);
}

void MidiOutputs::positionClock (Output& output, size_t pulse, double ms) noexcept
{
    // Song Position Pointer counts sixteenth notes, six pulses each, in
    // 14 bits. It names the first sixteenth at or after the pulse, and the
    // clock resumes on that sixteenth's pulse, so the gear's count and
    // the song's agree.
    const int sixteenth = (int) std::min<size_t> (16383, (pulse + 5) / 6);
    push (output, Entry::message (ms, { songPosition, (juce::uint8) (sixteenth & 0x7f), (juce::uint8) (sixteenth >> 7) }));
    push (output, Entry::message (ms, { clockContinue }));
    const auto& pulses = *output.current->pulses;
    const auto resumeAt = (size_t) sixteenth * 6;
    output.pulseFloor = resumeAt < pulses.size() ? pulses[resumeAt] : unbounded;
}

void MidiOutputs::push (Output& output, const Entry& entry) noexcept
{
    int start1, size1, start2, size2;
    output.fifo.prepareToWrite (1, start1, size1, start2, size2);
    if (size1 + size2 == 0)
    {
        output.dropped.fetch_add (1);
        return;
    }
    output.queue[(size_t) (size1 > 0 ? start1 : start2)] = entry;
    output.fifo.finishedWrite (1);
    output.pushed = true;
}

// ---- Sender thread ----------------------------------------------------------

double MidiOutputs::service (double nowMs)
{
    double next = never;
    for (int i = 0, used = slotsUsed.load(); i < used; ++i)
        if (auto* output = senderSlots[(size_t) i].load())
            next = std::min (next, service (*output, nowMs));
    return next;
}

double MidiOutputs::service (Output& output, double nowMs)
{
    const int ready = output.fifo.getNumReady();
    if (ready == 0)
        return never;
    int start1, size1, start2, size2;
    output.fifo.prepareToRead (ready, start1, size1, start2, size2);
    const auto at = [&] (int k) -> const Entry&
    { return output.queue[(size_t) (k < size1 ? start1 + k : start2 + k - size1)]; };

    int done = 0;
    int lastCut = -1;
    for (int k = 0; k < ready; ++k)
        if (at (k).kind == Entry::Kind::cut)
            lastCut = k;
    if (lastCut >= 0)
    {
        // What was due before the cut leaves, late if it must; what was
        // queued for after it was for a bed that stopped or jumped.
        const double cutMs = at (lastCut).ms;
        for (; done < lastCut; ++done)
            if (at (done).ms <= cutMs)
                deliver (output, at (done), nowMs);
        endHeldNotes (output, cutMs, nowMs, true);
        ++done;
    }
    double next = never;
    for (; done < ready; ++done)
    {
        const auto& entry = at (done);
        if (! output.schedules && entry.ms > nowMs)
        {
            next = entry.ms;
            break;
        }
        deliver (output, entry, nowMs);
    }
    output.fifo.finishedRead (done);
    return next;
}

void MidiOutputs::deliver (Output& output, const Entry& entry, double nowMs)
{
    switch (entry.kind)
    {
        case Entry::Kind::message:
            send (output, entry.bytes, entry.size, entry.ms, nowMs);
            break;
        case Entry::Kind::wrap:
            endHeldNotes (output, entry.ms, nowMs, false);
            break;
        case Entry::Kind::cut:
            endHeldNotes (output, entry.ms, nowMs, true);
            break;
    }
}

void MidiOutputs::send (Output& output, const juce::uint8* bytes, int size, double ms, double nowMs)
{
    output.sink->send (bytes, size, ms);
    output.sent.fetch_add (1);
    if (nowMs - ms > lateMs)
        output.late.fetch_add (1);
    if (output.schedules)
    {
        output.handedUntil = std::max (output.handedUntil, ms);
        if (ms > nowMs)
            output.early.fetch_add (1);
    }
    if (size < 3)
        return;
    const int kind = bytes[0] & 0xf0;
    if (kind == 0xb0 && bytes[1] == sustainPedal)
    {
        const auto channel = (size_t) (bytes[0] & 0x0f);
        output.pedalDown[channel] = bytes[2] >= 64;
        if (! output.pedalDown[channel])
            output.pedalUpAt[channel] = ms;
        return;
    }
    const auto note = (size_t) ((bytes[0] & 0x0f) * 128 + (bytes[1] & 0x7f));
    if (kind == 0x90 && bytes[2] > 0)
        output.held[note] = true;
    else if (kind == 0x80 || kind == 0x90)
    {
        output.held[note] = false;
        output.offAt[note] = ms;
    }
}

void MidiOutputs::endHeldNotes (Output& output, double ms, double nowMs, bool flush)
{
    // A flush reaches a virtual destination as a System Reset (0xFF), so
    // the daemon flushes only when CoreMIDI still holds what it handed
    // over. Then a note whose note-off it unscheduled is held again.
    const bool flushing = flush && output.schedules && output.handedUntil > nowMs;
    if (flushing)
        output.sink->flush();
    for (size_t note = 0; note < output.held.size(); ++note)
    {
        if (! output.held[note] && ! (flushing && output.offAt[note] > nowMs))
            continue;
        const juce::uint8 off[3] { (juce::uint8) (0x80 | (note / 128)), (juce::uint8) (note % 128), 0 };
        send (output, off, 3, ms, nowMs);
    }
    // A note the pedal sustains sounds on after its note-off.
    for (size_t channel = 0; channel < output.pedalDown.size(); ++channel)
    {
        if (! output.pedalDown[channel] && ! (flushing && output.pedalUpAt[channel] > nowMs))
            continue;
        const juce::uint8 up[3] { (juce::uint8) (0xb0 | channel), sustainPedal, 0 };
        send (output, up, 3, ms, nowMs);
    }
}

// ---- Wakeup and the sender thread -------------------------------------------

#if JUCE_MAC
Wakeup::Wakeup() { semaphore_create (mach_task_self(), &semaphore, SYNC_POLICY_FIFO, 0); }
Wakeup::~Wakeup() { semaphore_destroy (mach_task_self(), semaphore); }
void Wakeup::signal() noexcept { semaphore_signal (semaphore); }
void Wakeup::waitUntil (double deadlineMs) noexcept
{
    if (std::isinf (deadlineMs))
    {
        semaphore_wait (semaphore);
        return;
    }
    const double wait = deadlineMs - juce::Time::getMillisecondCounterHiRes();
    if (wait <= 0.0)
        return;
    const mach_timespec_t span { (unsigned int) (wait / 1000.0), (clock_res_t) (std::fmod (wait, 1000.0) * 1.0e6) };
    semaphore_timedwait (semaphore, span);
}
#elif JUCE_WINDOWS
Wakeup::Wakeup() { semaphore = CreateSemaphoreW (nullptr, 0, 0x7fffffff, nullptr); }
Wakeup::~Wakeup() { CloseHandle ((HANDLE) semaphore); }
void Wakeup::signal() noexcept { ReleaseSemaphore ((HANDLE) semaphore, 1, nullptr); }
void Wakeup::waitUntil (double deadlineMs) noexcept
{
    if (std::isinf (deadlineMs))
    {
        WaitForSingleObject ((HANDLE) semaphore, INFINITE);
        return;
    }
    const double wait = deadlineMs - juce::Time::getMillisecondCounterHiRes();
    if (wait > 0.0)
        WaitForSingleObject ((HANDLE) semaphore, (DWORD) std::ceil (wait));
}
#else
Wakeup::Wakeup() { sem_init (&semaphore, 0, 0); }
Wakeup::~Wakeup() { sem_destroy (&semaphore); }
void Wakeup::signal() noexcept { sem_post (&semaphore); }
void Wakeup::waitUntil (double deadlineMs) noexcept
{
    if (std::isinf (deadlineMs))
    {
        sem_wait (&semaphore);
        return;
    }
    const double wait = deadlineMs - juce::Time::getMillisecondCounterHiRes();
    if (wait <= 0.0)
        return;
    // sem_timedwait takes a time on the realtime clock.
    timespec until {};
    clock_gettime (CLOCK_REALTIME, &until);
    const auto nanoseconds = (long long) until.tv_nsec + (long long) (wait * 1.0e6);
    until.tv_sec += (time_t) (nanoseconds / 1'000'000'000);
    until.tv_nsec = (long) (nanoseconds % 1'000'000'000);
    sem_timedwait (&semaphore, &until);
}
#endif

MidiSender::MidiSender (MidiOutputs& o) : juce::Thread ("audiod MIDI sender"), outputs (o) {}

MidiSender::~MidiSender()
{
    signalThreadShouldExit();
    wakeup.signal();
    stopThread (2000);
}

void MidiSender::start()
{
    if (isThreadRunning())
        return;
    if (! startRealtimeThread (RealtimeOptions {}.withMaximumProcessingTimeMs (1.0)))
        startThread (Priority::highest);
}

void MidiSender::waitOutPass()
{
    if (! isThreadRunning())
        return;
    const auto seen = passes.load();
    for (int i = 0; i < 300 && passes.load() < seen + 2; ++i)
    {
        wakeup.signal();
        std::this_thread::sleep_for (std::chrono::milliseconds (1));
    }
}

void MidiSender::run()
{
    while (! threadShouldExit())
    {
        const double next = outputs.service (juce::Time::getMillisecondCounterHiRes());
        passes.fetch_add (1);
        wakeup.waitUntil (next);
    }
}

// ---- Sinks ------------------------------------------------------------------

namespace
{
// A virtual source the daemon publishes, or a destination JUCE opens,
// which sends each message as it is handed one.
class PortSink final : public MidiSink
{
public:
    PortSink (std::unique_ptr<juce::MidiOutput> port, bool published) : output (std::move (port)), source (published) {}
    bool schedules() const override { return false; }
    void send (const juce::uint8* bytes, int size, double) override { output->sendMessageNow (juce::MidiMessage (bytes, size)); }
    juce::String sourceIdentifier() const override { return source ? output->getIdentifier() : juce::String(); }

private:
    std::unique_ptr<juce::MidiOutput> output;
    bool source;
};

#if JUCE_MAC
MIDIClientRef daemonClient()
{
    static const MIDIClientRef client = []
    {
        MIDIClientRef created = 0;
        MIDIClientCreate (CFSTR ("field-audiod"), nullptr, nullptr, &created);
        return created;
    }();
    return client;
}

// A destination through CoreMIDI itself, because JUCE's MidiOutput stamps
// every message with the time it is sent: CoreMIDI schedules each message
// for the host time stamped on it.
class CoreMidiSink final : public MidiSink
{
public:
    CoreMidiSink (MIDIPortRef p, MIDIEndpointRef e) : port (p), endpoint (e) {}
    ~CoreMidiSink() override { MIDIPortDispose (port); }
    bool schedules() const override { return true; }
    void send (const juce::uint8* bytes, int size, double ms) override
    {
        // One MIDI 1.0 message as a 32-bit Universal MIDI Packet: type 1
        // for a system message, type 2 for a channel voice message.
        const UInt32 word = ((bytes[0] >= 0xf0 ? 0x1u : 0x2u) << 28) | ((UInt32) bytes[0] << 16)
                            | ((UInt32) (size > 1 ? bytes[1] : 0) << 8) | (UInt32) (size > 2 ? bytes[2] : 0);
        MIDIEventList list {};
        auto* packet = MIDIEventListInit (&list, kMIDIProtocol_1_0);
        MIDIEventListAdd (&list, sizeof (list), packet, hostTimeForMs (ms), 1, &word);
        MIDISendEventList (port, endpoint, &list);
    }
    void flush() override { MIDIFlushOutput (endpoint); }

private:
    MIDIPortRef port;
    MIDIEndpointRef endpoint;
};
#endif
} // namespace

std::unique_ptr<MidiSink> makeMidiSink (const MidiTarget& target, juce::String& error)
{
    if (target.source)
    {
        if (auto port = createVirtualSource (target.name))
            return std::make_unique<PortSink> (std::move (port), true);
        error = "cannot create a virtual MIDI source named " + target.name + " on this system";
        return nullptr;
    }
    const auto devices = juce::MidiOutput::getAvailableDevices();
    for (int i = 0; i < devices.size(); ++i)
    {
        if (devices[i].name != target.name)
            continue;
#if JUCE_MAC
        // JUCE lists one device per CoreMIDI destination, in CoreMIDI's
        // order, so the index is the endpoint's; listing again makes sure
        // none came or went in between.
        const auto endpoint = MIDIGetDestination ((ItemCount) i);
        MIDIPortRef port = 0;
        if (endpoint != 0 && juce::MidiOutput::getAvailableDevices() == devices
            && MIDIOutputPortCreate (daemonClient(), CFSTR ("field-audiod"), &port) == noErr)
            return std::make_unique<CoreMidiSink> (port, endpoint);
#else
        if (auto port = juce::MidiOutput::openDevice (devices[i].identifier))
            return std::make_unique<PortSink> (std::move (port), false);
#endif
        error = "cannot open the MIDI destination " + target.name;
        return nullptr;
    }
    error = "no MIDI destination named " + target.name;
    return nullptr;
}

#if JUCE_MAC
juce::uint64 hostTimeForMs (double ms) { return (juce::uint64) juce::Time::secondsToHighResolutionTicks (ms / 1000.0); }
double msForHostTime (juce::uint64 hostTime) { return juce::Time::highResolutionTicksToSeconds ((juce::int64) hostTime) * 1000.0; }
#endif

// ---- --midi-out-selftest ----------------------------------------------------

namespace
{
struct Logged
{
    std::vector<juce::uint8> bytes;
    double ms = 0.0;
    double handedAt = 0.0;
};

// Records what it is handed. A scheduling one plays CoreMIDI: a flush
// drops what was stamped for after the clock.
class FakeSink final : public MidiSink
{
public:
    FakeSink (bool schedulesAhead, const double& now, std::vector<Logged>& sent, int& flushed)
        : scheduling (schedulesAhead), clock (now), log (sent), flushes (flushed)
    {
    }
    bool schedules() const override { return scheduling; }
    void send (const juce::uint8* bytes, int size, double ms) override { log.push_back ({ { bytes, bytes + size }, ms, clock }); }
    void flush() override
    {
        ++flushes;
        log.erase (std::remove_if (log.begin(), log.end(), [this] (const Logged& l) { return l.ms > clock; }), log.end());
    }

private:
    const bool scheduling;
    const double& clock;
    std::vector<Logged>& log;
    int& flushes;
};

class FakeInput final : public LiveInput
{
public:
    void read (float* left, float* right, int n) override
    {
        std::fill (left, left + n, 0.0f);
        std::fill (right, right + n, 0.0f);
    }
    juce::int64 readerMargin() const override { return margin; }
    juce::int64 margin = 0;
};

constexpr double testRate = 48000.0;
constexpr int testBlock = 512;
double msOf (juce::int64 sample) { return (double) sample * 1000.0 / testRate; }
bool closeTo (double a, double b) { return std::abs (a - b) < 1.0e-6; }

struct Harness
{
    explicit Harness (bool schedulesAhead = false) : scheduling (schedulesAhead) {}

    juce::String open (const juce::String& json)
    {
        const auto result = outputs.open (juce::JSON::parse (json), nullptr,
                                          [this] (const juce::String&) { return std::static_pointer_cast<LiveInput> (input); });
        return result.getProperty ("error", juce::var()).toString();
    }
    void block (juce::int64 position, double ms, bool rolling = true, juce::int64 wrapFrom = 0, juce::int64 wrapTo = 0)
    {
        MidiBlock b;
        b.startMs = ms;
        b.rolling = rolling;
        b.position = position;
        b.advance = advance;
        b.slack = slack;
        b.wrapFrom = wrapFrom;
        b.wrapTo = wrapTo;
        outputs.play (b);
    }
    void serve (double now)
    {
        clock = now;
        outputs.service (now);
    }
    std::vector<std::vector<juce::uint8>> sent (size_t from = 0) const
    {
        std::vector<std::vector<juce::uint8>> bytes;
        for (size_t i = from; i < log.size(); ++i)
            bytes.push_back (log[i].bytes);
        return bytes;
    }

    const bool scheduling;
    juce::int64 advance = testBlock;
    juce::int64 slack = 0;
    double clock = 0.0;
    std::vector<Logged> log;
    int flushes = 0;
    std::shared_ptr<FakeInput> input = std::make_shared<FakeInput>();
    MidiOutputs outputs { [this] (const MidiTarget&, juce::String&) { return std::make_unique<FakeSink> (scheduling, clock, log, flushes); },
                          [] {},
                          [] {} };
};

using Bytes = std::vector<std::vector<juce::uint8>>;

// One long note on channel 16, from sample 0 to 4000.
const juce::String heldNote = R"({"name":"held","source":"Held","rate":48000,"lead":0,"events":[
    {"sample":0,"midi":[159,60,100]},{"sample":4000,"midi":[143,60,0]}]})";
const Bytes on60 { { 0x9f, 60, 100 } };

std::string checkLead()
{
    // Each event leaves the lead plus the input's margin before its time,
    // in the block whose window, the block's span moved later by both,
    // holds it.
    Harness h;
    h.input->margin = 768;
    if (auto error = h.open (R"({"name":"lead","source":"Lead","rate":48000,"lead":192,"lead_input":"seq:lead","events":[
            {"sample":10000,"midi":[159,60,100]},{"sample":10500,"midi":[143,60,0]},
            {"sample":11000,"midi":[159,61,100]},{"sample":11400,"midi":[143,61,0]}]})");
        error.isNotEmpty())
        return "lead: " + error.toStdString();
    const juce::int64 samples[] { 10000, 10500, 11000, 11400 };
    for (juce::int64 p = 0; p < 12800; p += testBlock)
    {
        const auto before = h.log.size();
        h.block (p, msOf (p));
        h.serve (1.0e9);
        for (auto i = before; i < h.log.size(); ++i)
        {
            const auto s = samples[i];
            if (s - 960 < p || s - 960 >= p + testBlock)
                return "lead: the event at " + std::to_string (s) + " left in the block at " + std::to_string (p);
            if (! closeTo (h.log[i].ms, msOf (s - 960)))
                return "lead: the event at " + std::to_string (s) + " left at " + std::to_string (h.log[i].ms) + " ms";
        }
    }
    if (h.log.size() != 4)
        return "lead: " + std::to_string (h.log.size()) + " events left, not 4";

    // The margin grows with the block: nothing leaves twice, and nothing
    // is skipped.
    Harness grows;
    grows.input->margin = 768;
    grows.open (R"({"name":"lead","source":"Lead","rate":48000,"lead":192,"lead_input":"seq:lead","events":[
        {"sample":10000,"midi":[159,60,100]},{"sample":10500,"midi":[143,60,0]},
        {"sample":11000,"midi":[159,61,100]},{"sample":11400,"midi":[143,61,0]}]})");
    for (juce::int64 p = 0; p < 12800; p += testBlock)
    {
        if (p == 9216)
            grows.input->margin = 1280;
        grows.block (p, msOf (p));
    }
    grows.serve (1.0e9);
    if (grows.sent() != Bytes { { 0x9f, 60, 100 }, { 0x8f, 60, 0 }, { 0x9f, 61, 100 }, { 0x8f, 61, 0 } })
        return "lead: a growing margin sent " + std::to_string (grows.log.size()) + " messages, not the 4 events once each";
    return {};
}

std::string checkFlush()
{
    // A destination's events go to CoreMIDI as soon as they are queued.
    // A stop that comes while CoreMIDI still holds some, as when the
    // callback runs blocks back to back, unschedules them before the
    // note-offs, and none of them reaches the destination after it.
    Harness h (true);
    if (auto error = h.open (R"({"name":"dest","destination":"Synth","rate":48000,"lead":0,"events":[
            {"sample":100,"midi":[159,60,100]},{"sample":200,"midi":[159,62,100]},
            {"sample":300,"midi":[143,60,0]},{"sample":400,"midi":[143,62,0]}]})");
        error.isNotEmpty())
        return "flush: " + error.toStdString();
    h.block (0, 1000.0);
    h.serve (1000.01);
    if (h.log.size() != 4 || std::any_of (h.log.begin(), h.log.end(), [] (const Logged& l) { return l.handedAt >= l.ms; }))
        return "flush: the events were not handed over ahead of their times";
    h.block (testBlock, 1003.0, false);
    h.serve (1003.0);
    if (h.flushes != 1)
        return "flush: a stop with events still scheduled did not flush";
    if (std::any_of (h.log.begin(), h.log.end(), [] (const Logged& l) { return l.ms > 1003.0; }))
        return "flush: an event handed over early reached the destination after the stop";
    if (h.sent() != Bytes { { 0x9f, 60, 100 }, { 0x8f, 60, 0 }, { 0x8f, 62, 0 } })
        return "flush: after the stop, the destination did not get the first note-on, then a note-off for both notes";

    // A stop after everything it handed over has sounded flushes nothing.
    h.log.clear();
    h.block (0, 2000.0);
    h.serve (2000.01);
    h.block (testBlock, 2000.0 + msOf (testBlock), false);
    h.serve (2000.0 + msOf (testBlock));
    if (h.flushes != 1 || h.log.size() != 4)
        return "flush: a stop with nothing still scheduled flushed, or sent more than the 4 events";
    return {};
}

std::string checkHeld()
{
    {
        Harness h;
        h.open (heldNote);
        h.block (0, 0.0);
        h.serve (0.0);
        h.block (testBlock, msOf (testBlock), false);
        h.serve (msOf (testBlock));
        if (h.sent() != Bytes { { 0x9f, 60, 100 }, { 0x8f, 60, 0 } })
            return "held: a stop did not end the note";
    }
    {
        // A locate lands inside the note: it ends, and does not start again.
        Harness h;
        h.open (heldNote);
        h.block (0, 0.0);
        h.serve (0.0);
        for (juce::int64 p = 2048; p < 4608; p += testBlock)
        {
            h.block (p, msOf (p - 1536));
            h.serve (msOf (p - 1536));
        }
        h.serve (1.0e9);
        if (h.sent() != Bytes { { 0x9f, 60, 100 }, { 0x8f, 60, 0 }, { 0x8f, 60, 0 } })
            return "held: a locate did not end the note, or started it again";
    }
    {
        // A wrap ends the note, and the loop's start begins it again, at
        // the wrap's time.
        Harness h;
        h.open (heldNote);
        for (juce::int64 p = 0; p < 3000; p += testBlock)
            h.block (p, msOf (p), true, 0, 3000);
        h.serve (1.0e9);
        if (h.sent() != Bytes { { 0x9f, 60, 100 }, { 0x8f, 60, 0 }, { 0x9f, 60, 100 } })
            return "held: a wrap did not end the note and start it again";
        if (! closeTo (h.log[1].ms, msOf (3000)) || ! closeTo (h.log[2].ms, msOf (3000)))
            return "held: the wrap's note-off and note-on did not leave at the wrap";
    }
    {
        // A loop two blocks long wraps where one block's window ends and
        // the next one's starts: each wrap still ends the note, once.
        Harness h;
        h.open (heldNote);
        for (juce::int64 p = 0; p < 6 * testBlock; p += testBlock)
            h.block (p % 1024, msOf (p), true, 0, 1024);
        h.serve (1.0e9);
        const Bytes onOff { { 0x9f, 60, 100 }, { 0x8f, 60, 0 } };
        if (h.sent() != Bytes { onOff[0], onOff[1], onOff[0], onOff[1], onOff[0], onOff[1] })
            return "held: a wrap at a block's end did not end the note before the loop's start began it again";
        if (! closeTo (h.log[1].ms, msOf (1024)) || ! closeTo (h.log[3].ms, msOf (2048)) || ! closeTo (h.log[5].ms, msOf (3072)))
            return "held: a wrap at a block's end did not end the note at the wrap";

        // With a lead the same wrap falls inside a window, and still ends
        // the note once.
        Harness led;
        led.open (heldNote.replace ("\"lead\":0", "\"lead\":192"));
        for (juce::int64 p = 0; p < 6 * testBlock; p += testBlock)
            led.block (p % 1024, msOf (p), true, 0, 1024);
        led.serve (1.0e9);
        if (led.sent() != Bytes { onOff[0], onOff[1], onOff[0], onOff[1], onOff[0], onOff[1], onOff[0] })
            return "held: with a lead, a wrap at a block's end did not end the note exactly once";
    }
    {
        Harness h;
        h.open (heldNote);
        h.block (0, 0.0);
        h.serve (0.0);
        h.open (R"({"name":"held","source":"Held","rate":48000,"lead":0,"events":[{"sample":1000,"midi":[159,62,100]}]})");
        h.block (testBlock, msOf (testBlock));
        h.serve (1.0e9);
        if (h.sent() != Bytes { { 0x9f, 60, 100 }, { 0x8f, 60, 0 }, { 0x9f, 62, 100 } })
            return "held: a replaced schedule did not end the old one's note before the new one's";
        if (auto error = h.open (R"({"name":"held","destination":"Held","rate":48000,"lead":0,"events":[]})"); error.isEmpty())
            return "held: a replacement naming another port was accepted";
    }
    {
        Harness h;
        h.open (heldNote);
        h.block (0, 0.0);
        h.serve (0.0);
        h.outputs.close ("held");
        if (h.sent() != Bytes { { 0x9f, 60, 100 }, { 0x8f, 60, 0 } })
            return "held: closing the output did not end the note";
    }
    {
        // A note the pedal sustains still sounds after its note-off, so
        // whatever ends the notes also lifts the pedal.
        const juce::String pedalled = R"({"name":"pedal","source":"Pedal","rate":48000,"lead":0,"events":[
            {"sample":0,"midi":[191,64,127]},{"sample":100,"midi":[159,60,100]},{"sample":200,"midi":[143,60,0]}]})";
        const Bytes lifted { { 0xbf, 64, 127 }, { 0x9f, 60, 100 }, { 0x8f, 60, 0 }, { 0xbf, 64, 0 } };

        Harness stops;
        stops.open (pedalled);
        stops.block (0, 0.0);
        stops.serve (0.0);
        stops.block (testBlock, msOf (testBlock), false);
        stops.serve (1.0e9);
        if (stops.sent() != lifted)
            return "held: a stop did not lift the sustain pedal";

        Harness locates;
        locates.open (pedalled);
        locates.block (0, 0.0);
        locates.serve (0.0);
        locates.block (48000, msOf (testBlock));
        locates.serve (1.0e9);
        if (locates.sent() != lifted)
            return "held: a locate did not lift the sustain pedal";

        Harness closes;
        closes.open (pedalled);
        closes.block (0, 0.0);
        closes.serve (1.0e9);
        closes.outputs.close ("pedal");
        if (closes.sent() != lifted)
            return "held: closing the output did not lift the sustain pedal";

        Harness wraps;
        wraps.open (pedalled);
        wraps.block (0, 0.0, true, 0, 1024);
        wraps.block (testBlock, msOf (testBlock), true, 0, 1024);
        wraps.serve (1.0e9);
        if (wraps.sent() != lifted)
            return "held: a wrap did not lift the sustain pedal";

        // A pedal the schedule lifted itself stays as it is.
        Harness liftedBySchedule;
        liftedBySchedule.open (R"({"name":"pedal","source":"Pedal","rate":48000,"lead":0,"events":[
            {"sample":0,"midi":[191,64,127]},{"sample":200,"midi":[191,64,0]}]})");
        liftedBySchedule.block (0, 0.0);
        liftedBySchedule.serve (0.0);
        liftedBySchedule.block (testBlock, msOf (testBlock), false);
        liftedBySchedule.serve (1.0e9);
        if (liftedBySchedule.sent() != Bytes { { 0xbf, 64, 127 }, { 0xbf, 64, 0 } })
            return "held: a stop lifted a pedal the schedule had already lifted";

        // CoreMIDI still holds the schedule's own release, which the flush
        // unschedules, so the daemon sends it again.
        Harness flushed (true);
        flushed.open (R"({"name":"pedal","destination":"Pedal","rate":48000,"lead":0,"events":[
            {"sample":0,"midi":[191,64,127]},{"sample":400,"midi":[191,64,0]}]})");
        flushed.block (0, 1000.0);
        flushed.serve (1000.01);
        flushed.block (testBlock, 1003.0, false);
        flushed.serve (1003.0);
        if (flushed.flushes != 1 || flushed.sent() != Bytes { { 0xbf, 64, 127 }, { 0xbf, 64, 0 } } || ! closeTo (flushed.log[1].ms, 1003.0))
            return "held: a flush that unscheduled the pedal's release did not lift the pedal";
    }
    return {};
}

std::string checkClock()
{
    // Pulses every 1000 samples, 24 to the quarter note at 120 bpm.
    juce::String pulses;
    for (int i = 0; i < 1200; ++i)
        pulses << (i > 0 ? "," : "") << juce::String (i * 1000);
    Harness h;
    if (auto error = h.open (R"({"name":"clock","source":"Clock","rate":48000,"lead":0,"events":[],"clock":{"pulses":[)" + pulses + "]}}");
        error.isNotEmpty())
        return "clock: " + error.toStdString();
    double ms = 0.0;
    const auto play = [&] (juce::int64 position, int blocks, bool rolling = true, juce::int64 wrapFrom = 0, juce::int64 wrapTo = 0)
    {
        const auto first = h.log.size();
        for (int i = 0; i < blocks; ++i)
        {
            h.block (position, ms, rolling, wrapFrom, wrapTo);
            position = wrapTo > wrapFrom && position + testBlock >= wrapTo ? wrapFrom + (position + testBlock - wrapTo) : position + testBlock;
            ms += msOf (testBlock);
        }
        h.serve (1.0e9);
        return first;
    };
    // The messages from `first` on that are not pulses, and the time of
    // the first pulse among them.
    const auto transport = [&] (size_t first)
    {
        Bytes messages;
        for (auto i = first; i < h.log.size(); ++i)
            if (h.log[i].bytes != std::vector<juce::uint8> { clockPulse })
                messages.push_back (h.log[i].bytes);
        return messages;
    };
    const auto firstPulseMs = [&] (size_t first)
    {
        for (auto i = first; i < h.log.size(); ++i)
            if (h.log[i].bytes == std::vector<juce::uint8> { clockPulse })
                return h.log[i].ms;
        return -1.0;
    };

    auto at = play (0, 4);
    if (transport (at) != Bytes { { clockStart } } || ! closeTo (firstPulseMs (at), 0.0))
        return "clock: playing from the top did not send Start, then pulse 0";
    at = play (4 * testBlock, 3, false);
    if (h.sent (at) != Bytes { { clockStop } })
        return "clock: a stop did not send Stop alone, or a pulse went out while stopped";

    const double bar3 = ms;
    at = play (192000, 2);
    if (transport (at) != Bytes { { songPosition, 32, 0 }, { clockContinue } } || ! closeTo (firstPulseMs (at), bar3))
        return "clock: playing from bar 3 did not send Song Position Pointer 32 and Continue, then pulse 192 at once";

    const double beat2 = ms;
    at = play (792000, 2);
    if (transport (at) != Bytes { { clockStop }, { songPosition, 4, 1 }, { clockContinue } } || ! closeTo (firstPulseMs (at), beat2))
        return "clock: a locate to beat 2 of bar 9 did not send Stop, Song Position Pointer 132, and Continue, then pulse 792";

    play (792000 + 2 * testBlock, 1, false);
    const double between = ms;
    at = play (193500, 10);
    if (transport (at) != Bytes { { songPosition, 33, 0 }, { clockContinue } } || ! closeTo (firstPulseMs (at), between + msOf (4500)))
        return "clock: playing from between sixteenths did not resume on the next one's pulse";

    play (193500 + 10 * testBlock, 1, false);
    const double wrapStart = ms;
    at = play (815000, 3, true, 768000, 816000);
    const double wrapMs = wrapStart + msOf (1000);
    if (transport (at) != Bytes { { songPosition, 8, 1 }, { clockContinue }, { clockStop }, { songPosition, 0, 1 }, { clockContinue } })
        return "clock: a wrap did not send Stop, the loop start's Song Position Pointer, and Continue";
    if (! closeTo (firstPulseMs (at), wrapMs))
        return "clock: after the wrap, the first pulse was not the loop start's, at the wrap";

    at = play (768000 + 2 * testBlock - 1000, 2, false);
    if (h.sent (at) != Bytes { { clockStop } })
        return "clock: a pause did not send Stop alone";

    const double alignedStart = ms;
    at = play (816000 - testBlock, 2, true, 768000, 816000);
    if (transport (at) != Bytes { { songPosition, 8, 1 }, { clockContinue }, { clockStop }, { songPosition, 0, 1 }, { clockContinue } })
        return "clock: a wrap at a block's end did not send Stop, the loop start's Song Position Pointer, and Continue";
    if (! closeTo (firstPulseMs (at), alignedStart + msOf (testBlock)))
        return "clock: after a wrap at a block's end, the first pulse was not the loop start's, at the wrap";
    return {};
}

std::string checkReplacedClock()
{
    const auto schedule = [] (int every)
    {
        juce::String pulses;
        for (int i = 0; i < 100; ++i)
            pulses << (i > 0 ? "," : "") << juce::String (i * every);
        return R"({"name":"clock","source":"Clock","rate":48000,"lead":0,"events":[],"clock":{"pulses":[)" + pulses + "]}}";
    };
    Harness h;
    if (auto error = h.open (schedule (1000)); error.isNotEmpty())
        return "replaced clock: " + error.toStdString();
    juce::int64 position = 0;
    const auto play = [&] (int blocks)
    {
        const auto first = h.log.size();
        for (int i = 0; i < blocks; ++i, position += testBlock)
            h.block (position, msOf (position));
        h.serve (1.0e9);
        return first;
    };
    const auto transport = [&] (size_t first)
    {
        Bytes messages;
        for (auto i = first; i < h.log.size(); ++i)
            if (h.log[i].bytes != std::vector<juce::uint8> { clockPulse })
                messages.push_back (h.log[i].bytes);
        return messages;
    };

    play (94);

    // The same pulses in a new schedule keep the gear's count.
    h.open (schedule (1000));
    auto at = play (2);
    if (! transport (at).empty() || at == h.log.size())
        return "replaced clock: the same pulses in a new schedule stopped the clock or moved the gear";

    // Pulses half as fast put sample 49152 at pulse 25, and the next
    // sixteenth is pulse 30, at sample 60000.
    h.open (schedule (2000));
    at = play (2);
    if (h.sent (at) != Bytes { { clockStop }, { songPosition, 5, 0 }, { clockContinue } })
        return "replaced clock: new pulses did not send Stop, the new position, and Continue alone";
    at = play (20);
    if (h.sent (at) != Bytes { { clockPulse } } || ! closeTo (h.log[at].ms, msOf (60000)))
        return "replaced clock: the pulses did not resume on the new position's sixteenth";

    // A schedule with no clock ends the clock.
    h.open (R"({"name":"clock","source":"Clock","rate":48000,"lead":0,"events":[]})");
    at = play (2);
    if (h.sent (at) != Bytes { { clockStop } })
        return "replaced clock: a schedule with no clock did not send Stop";
    return {};
}

// Converted delivery moves the bed in steps of its own, so a block's
// position can land past the end of the last block's window.
std::string checkSteps()
{
    constexpr int steps = 512;
    constexpr int blockAdvance = 470;
    const auto schedule = [] (juce::int64 length)
    {
        juce::String events;
        for (juce::int64 s = 0; s < length; s += 100)
            events << (s > 0 ? "," : "") << "{\"sample\":" << juce::String (s) << ",\"midi\":[159," << juce::String ((s / 100) % 128) << ",100]}";
        return R"({"name":"steps","source":"Steps","rate":44100,"lead":0,"events":[)" + events + "]}";
    };
    {
        Harness h;
        h.advance = blockAdvance;
        h.slack = 8192;
        if (auto error = h.open (schedule (10000)); error.isNotEmpty())
            return "steps: " + error.toStdString();
        juce::int64 position = 0;
        double ms = 0.0;
        for (int i = 0; i < 30; ++i)
        {
            h.block (position, ms);
            position += i % 3 == 2 ? 0 : (i % 3 + 1) * steps;
            ms += 10.0;
        }
        h.serve (1.0e9);
        if (h.log.size() != 100)
            return "steps: " + std::to_string (h.log.size()) + " of the 100 notes left";
        for (size_t i = 0; i < h.log.size(); ++i)
            if (h.log[i].bytes[1] != (juce::uint8) i)
                return "steps: the notes left out of order at note " + std::to_string (i);
    }
    {
        // A step that carries the bed over the loop's end sends what it
        // skipped and the wrap, once, at the block's start, and then what
        // lies from the loop's start to the block's position.
        Harness h;
        h.advance = blockAdvance;
        h.slack = 8192;
        h.open (R"({"name":"steps","source":"Steps","rate":44100,"lead":0,"events":[
            {"sample":100,"midi":[159,60,100]},{"sample":4800,"midi":[159,61,100]}],"clock":{"pulses":[0,4900]}})");
        h.block (0, 0.0, true, 0, 5000);
        h.block (4096, 10.0, true, 0, 5000);
        const double stepped = 20.0;
        h.block (120, stepped, true, 0, 5000);
        h.serve (1.0e9);
        const Bytes wanted { { clockStart }, { clockPulse }, { 0x9f, 60, 100 }, { 0x9f, 61, 100 }, { clockPulse }, { 0x8f, 60, 0 }, { 0x8f, 61, 0 },
                             { clockStop }, { songPosition, 0, 0 }, { clockContinue }, { clockPulse }, { 0x9f, 60, 100 } };
        if (h.sent() != wanted)
            return "steps: a step over the loop's end did not send what it skipped, the wrap, and the loop's start";
        if (! closeTo (h.log[5].ms, stepped))
            return "steps: the wrap a step skipped over did not leave at the block's start";
    }
    {
        // A locate back before the loop's start is a jump, not a step over
        // the loop's end, and sends what lies from there.
        Harness h;
        h.open (R"({"name":"steps","source":"Steps","rate":48000,"lead":0,"events":[
            {"sample":1100,"midi":[159,60,100]},{"sample":8100,"midi":[159,61,100]}]})");
        h.block (8000, 0.0, true, 5000, 9000);
        h.block (1000, 10.0, true, 5000, 9000);
        h.serve (1.0e9);
        if (h.sent() != Bytes { { 0x9f, 61, 100 }, { 0x8f, 61, 0 }, { 0x9f, 60, 100 } })
            return "steps: a locate before the loop's start did not send what lies from there";
    }
    return {};
}

std::string checkRequests()
{
    Harness h;
    const char* refused[] {
        R"({"source":"A","rate":48000,"lead":0,"events":[]})",
        R"({"name":"a","rate":48000,"lead":0,"events":[]})",
        R"({"name":"a","source":"A","destination":"B","rate":48000,"lead":0,"events":[]})",
        R"({"name":"a","source":"A","rate":0,"lead":0,"events":[]})",
        R"({"name":"a","source":"A","rate":48000,"lead":-1,"events":[]})",
        R"({"name":"a","source":"A","rate":48000,"lead":0})",
        R"({"name":"a","source":"A","rate":48000,"lead":0,"events":[{"sample":10,"midi":[144,60,1]},{"sample":5,"midi":[128,60,0]}]})",
        R"({"name":"a","source":"A","rate":48000,"lead":0,"events":[{"sample":0,"midi":[60,1]}]})",
        R"({"name":"a","source":"A","rate":48000,"lead":0,"events":[{"sample":0,"midi":[240,1,247]}]})",
        R"({"name":"a","source":"A","rate":48000,"lead":0,"events":[],"clock":{"pulses":[10,5]}})",
    };
    for (const auto* request : refused)
        if (h.open (request).isEmpty())
            return std::string ("requests: accepted ") + request;
    if (auto error = h.open (R"({"name":"a","source":"A","rate":48000,"lead":0,"events":[]})"); error.isNotEmpty())
        return "requests: " + error.toStdString();
    if (h.open (R"({"name":"b","source":"A","rate":48000,"lead":0,"events":[]})").isEmpty())
        return "requests: a second output from the same source was accepted";
    return {};
}
} // namespace

std::string runMidiOutSelfTest()
{
    for (auto* check : { checkLead, checkFlush, checkHeld, checkClock, checkReplacedClock, checkSteps, checkRequests })
        if (auto error = check(); ! error.empty())
            return error;
    return {};
}

} // namespace field
