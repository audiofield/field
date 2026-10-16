// The native half of `field keys` (keyboard-instrument.md §2.5): a
// virtual MIDI source driven by NDJSON on stdin, and a monitor that
// prints what a named source sends, or what a virtual destination it
// publishes receives. Both are short-lived subprocesses,
// apart from the daemon's transport and socket, and both speak NDJSON on
// stdout and nothing else.
#pragma once

#include <juce_core/juce_core.h>

#include <memory>

namespace juce
{
class MidiOutput;
}

namespace field
{
// Reports the keyboard layout (macOS), publishes the source, sends each
// {"midi":[...]} line from stdin, and closes the source at end of input.
int runKeys (const juce::String& name);

// Prints each message from the source named `name`, with the host time
// it arrived at, until end of input, SIGTERM, or SIGINT. With
// `destination`, publishes a virtual destination of that name instead
// and prints each message sent to it, with the time stamped on it too.
int runMidiMonitor (const juce::String& name, bool destination);

// Publishes a virtual MIDI source, as `--keys` does and a MIDI output
// does (sequencer.md §2.5), or returns null where the system cannot.
std::unique_ptr<juce::MidiOutput> createVirtualSource (const juce::String& name);

// Reads a MIDI message of 1 to 3 bytes, starting with a status byte,
// into `data`. Returns why it is not one, or empty.
juce::String readMidiBytes (const juce::var& bytes, juce::uint8 (&data)[3], int& size);
} // namespace field
