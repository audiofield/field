#include "keys.h"

#include "keyboard-layout.h"
#include "midi_out.h"

#include <juce_audio_devices/juce_audio_devices.h>
#include <juce_events/juce_events.h>

#if JUCE_MAC
#include <CoreMIDI/CoreMIDI.h>
#endif

#if defined(_WIN32)
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#else
#include <poll.h>
#include <unistd.h>
#endif

#include <atomic>
#include <csignal>
#include <cstdio>
#include <initializer_list>
#include <iostream>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <utility>

namespace field
{
namespace
{
std::mutex stdoutLock;

void printLine (const juce::var& value)
{
    const auto line = juce::JSON::toString (value,
                                            juce::JSON::FormatOptions{}.withSpacing (
                                                juce::JSON::Spacing::none))
                      + "\n";
    const std::scoped_lock lock (stdoutLock);
    std::fputs (line.toRawUTF8(), stdout);
    std::fflush (stdout);
}

juce::var jsonObject (std::initializer_list<std::pair<juce::Identifier, juce::var>> properties)
{
    juce::DynamicObject::Ptr object = new juce::DynamicObject();
    for (const auto& [name, value] : properties)
        object->setProperty (name, value);
    return juce::var (object.get());
}

void printError (const juce::String& message)
{
    printLine (jsonObject ({ { "error", message } }));
}

juce::String fromUtf8 (const std::string& text)
{
    return juce::String::fromUTF8 (text.data(), (int) text.size());
}

void printKeyboardLayout()
{
    const auto layout = readKeyboardLayout();
    if (! layout)
        return;

    juce::DynamicObject::Ptr keys = new juce::DynamicObject();
    for (const auto& [position, typed] : layout->keys)
        keys->setProperty (juce::Identifier (position.c_str()), fromUtf8 (typed));

    juce::Array<juce::var> dead;
    for (const auto& position : layout->dead)
        dead.add (fromUtf8 (position));

    printLine (jsonObject ({ { "keyboard", jsonObject ({ { "name", fromUtf8 (layout->name) },
                                                         { "keys", juce::var (keys.get()) },
                                                         { "dead", dead } }) } }));
}

// Reads one {"midi":[...]} line into message, or returns why it is not one.
juce::String readMidiLine (const juce::String& line, juce::MidiMessage& message)
{
    juce::var parsed;
    if (juce::JSON::parse (line, parsed).failed() || parsed.getDynamicObject() == nullptr
        || parsed.getDynamicObject()->getProperties().size() != 1
        || ! parsed["midi"].isArray())
        return "expected a line like {\"midi\":[144,60,100]}, got " + line;

    juce::uint8 data[3] {};
    int size = 0;
    if (const auto error = readMidiBytes (parsed["midi"], data, size); error.isNotEmpty())
        return error + " in " + line;
    message = juce::MidiMessage (data, size);
    return {};
}

void printMessage (const juce::uint8* data, int size, double hostMs, std::optional<double> timestampMs = {})
{
    juce::Array<juce::var> bytes;
    for (int i = 0; i < size; ++i)
        bytes.add ((int) data[i]);
    auto line = jsonObject ({ { "midi", bytes }, { "host_ms", hostMs } });
    if (timestampMs)
        line.getDynamicObject()->setProperty ("timestamp_ms", *timestampMs);
    printLine (line);
}

class MidiPrinter final : public juce::MidiInputCallback
{
public:
    void handleIncomingMidiMessage (juce::MidiInput*, const juce::MidiMessage& message) override
    {
        // Read here rather than taken from the message, as the daemon's
        // capture does: JUCE's ALSA input stamps with another clock.
        printMessage (message.getRawData(), message.getRawDataSize(), juce::Time::getMillisecondCounterHiRes());
    }
};

#if JUCE_MAC
// A virtual destination through CoreMIDI itself, because JUCE's MidiInput
// stamps each message with its arrival and drops the time it carries.
class TimestampedDestination
{
public:
    explicit TimestampedDestination (const juce::String& name)
    {
        const auto cfName = name.toCFString();
        if (MIDIClientCreate (CFSTR ("field-audiod --midi-monitor"), nullptr, nullptr, &client) == noErr)
            MIDIDestinationCreateWithProtocol (client, cfName, kMIDIProtocol_1_0, &endpoint,
                                               ^(const MIDIEventList* list, void*) { print (list); });
        CFRelease (cfName);
    }
    ~TimestampedDestination()
    {
        if (endpoint != 0)
            MIDIEndpointDispose (endpoint);
        if (client != 0)
            MIDIClientDispose (client);
    }
    bool published() const { return endpoint != 0; }

private:
    static void print (const MIDIEventList* list)
    {
        const double hostMs = juce::Time::getMillisecondCounterHiRes();
        const auto* packet = &list->packet[0];
        for (UInt32 p = 0; p < list->numPackets; ++p, packet = MIDIEventPacketNext (packet))
            for (UInt32 w = 0; w < packet->wordCount;)
            {
                // Universal MIDI Packets, as a MIDI 1.0 destination receives
                // them: type 1 a system message and type 2 a channel voice
                // message, one word each; other types are skipped by their
                // length.
                const UInt32 word = packet->words[w];
                const UInt32 type = word >> 28;
                const juce::uint8 data[3] { (juce::uint8) (word >> 16), (juce::uint8) ((word >> 8) & 0x7f), (juce::uint8) (word & 0x7f) };
                const int status = data[0] & 0xf0;
                if (type == 1)
                    printMessage (data, data[0] == 0xf2 ? 3 : (data[0] == 0xf1 || data[0] == 0xf3) ? 2 : 1, hostMs,
                                  msForHostTime (packet->timeStamp));
                else if (type == 2)
                    printMessage (data, status == 0xc0 || status == 0xd0 ? 2 : 3, hostMs, msForHostTime (packet->timeStamp));
                constexpr UInt32 words[16] { 1, 1, 1, 2, 2, 4, 1, 1, 2, 2, 2, 3, 3, 4, 4, 4 };
                w += words[type];
            }
    }

    MIDIClientRef client = 0;
    MIDIEndpointRef endpoint = 0;
};
#endif

std::unique_ptr<juce::MidiInput> openSource (const juce::String& name, juce::MidiInputCallback& callback)
{
    for (const auto& device : juce::MidiInput::getAvailableDevices())
        if (device.name == name)
            return juce::MidiInput::openDevice (device.identifier, &callback);
    return nullptr;
}

// Drains whatever stdin holds without blocking, and says whether it has
// reached end of input.
bool stdinEnded()
{
#if defined(_WIN32)
    // Windows has no poll on a pipe; PeekNamedPipe is its non-blocking
    // question. The monitor's stdin is the pipe its parent spawned it with,
    // and a closed write end reads as ERROR_BROKEN_PIPE. Any other handle,
    // a console included, is never "ended" here, as poll would say.
    const HANDLE in = GetStdHandle (STD_INPUT_HANDLE);
    for (;;)
    {
        DWORD available = 0;
        if (PeekNamedPipe (in, nullptr, 0, nullptr, &available, nullptr) == 0)
            return GetLastError() == ERROR_BROKEN_PIPE;
        if (available == 0)
            return false;
        char discarded[256];
        DWORD got = 0;
        const DWORD want = available < sizeof (discarded) ? available : (DWORD) sizeof (discarded);
        if (ReadFile (in, discarded, want, &got, nullptr) == 0 || got == 0)
            return true;
    }
#else
    pollfd stdinPoll { STDIN_FILENO, POLLIN, 0 };
    while (poll (&stdinPoll, 1, 0) > 0)
    {
        char discarded[256];
        if (read (STDIN_FILENO, discarded, sizeof (discarded)) <= 0)
            return true;
    }
    return false;
#endif
}

// The system output's name, which the voice host names as scsynth's input
// device too: scsynth on macOS otherwise opens the default input device
// even with no input channels, and blocks on the microphone permission
// (keyboard-instrument.md §10.1).
juce::String defaultOutputDevice()
{
#if JUCE_MAC
    std::unique_ptr<juce::AudioIODeviceType> type (juce::AudioIODeviceType::createAudioIODeviceType_CoreAudio());
    if (type == nullptr)
        return {};
    type->scanForDevices();
    const auto names = type->getDeviceNames (false);
    const auto index = type->getDefaultDeviceIndex (false);
    return juce::isPositiveAndBelow (index, names.size()) ? names[index] : juce::String();
#else
    return {};
#endif
}

std::atomic<bool> stopRequested { false };

void runUntilStopped()
{
    while (! stopRequested && ! stdinEnded())
        juce::MessageManager::getInstance()->runDispatchLoopUntil (100);
}
} // namespace

juce::String readMidiBytes (const juce::var& value, juce::uint8 (&data)[3], int& size)
{
    const auto* bytes = value.getArray();
    if (bytes == nullptr || bytes->isEmpty() || bytes->size() > 3)
        return "a MIDI message is 1 to 3 bytes, got " + juce::String (bytes == nullptr ? 0 : bytes->size());
    for (int i = 0; i < bytes->size(); ++i)
    {
        const auto& byte = bytes->getReference (i);
        if (! (byte.isInt() || byte.isInt64()) || (juce::int64) byte < 0 || (juce::int64) byte > 255)
            return "a MIDI byte is an integer from 0 to 255, got " + juce::JSON::toString (byte, true);
        data[i] = (juce::uint8) (int) byte;
    }
    if (data[0] < 0x80)
        return "a MIDI message starts with a status byte, 128 or above, got " + juce::String (data[0]);
    size = bytes->size();
    return {};
}

std::unique_ptr<juce::MidiOutput> createVirtualSource (const juce::String& name)
{
    // JUCE declares createNewDevice only where the OS lets a process
    // publish a MIDI port (macOS, Linux); Windows has no virtual ports.
#if JUCE_WINDOWS
    juce::ignoreUnused (name);
    return nullptr;
#else
    return juce::MidiOutput::createNewDevice (name);
#endif
}

int runKeys (const juce::String& name)
{
    juce::ScopedJuceInitialiser_GUI juceInit;

    // Watching starts before the first report, so a switch between the two
    // still produces a report.
    const KeyboardLayoutWatcher watcher (printKeyboardLayout);
    printKeyboardLayout();

    // Windows has no virtual ports, so there the helper refuses below
    // with the same message as a failure.
    auto source = createVirtualSource (name);
    if (source == nullptr)
    {
        printError ("cannot create a virtual MIDI source named " + name + " on this system");
        return 1;
    }
    auto ready = jsonObject ({ { "ready", true }, { "name", name } });
    const auto output = defaultOutputDevice();
    if (output.isNotEmpty())
        ready.getDynamicObject()->setProperty ("output", output);
    printLine (ready);

    // Lines are read off the main thread, whose run loop delivers the
    // keyboard layout changes, and each message is sent as its line
    // arrives.
    std::atomic<int> exitCode { -1 };
    std::thread reader ([&]
    {
        std::string line;
        while (std::getline (std::cin, line))
        {
            const auto text = fromUtf8 (line).trim();
            if (text.isEmpty())
                continue;

            juce::MidiMessage message;
            if (const auto error = readMidiLine (text, message); error.isNotEmpty())
            {
                printError (error);
                exitCode = 1;
                return;
            }
            source->sendMessageNow (message);
        }
        exitCode = 0;
    });

    while (exitCode < 0)
        juce::MessageManager::getInstance()->runDispatchLoopUntil (50);
    reader.join();
    source.reset();
    return exitCode;
}

int runMidiMonitor (const juce::String& name, bool destination)
{
    juce::ScopedJuceInitialiser_GUI juceInit;
    auto* messageManager = juce::MessageManager::getInstance();
    std::signal (SIGTERM, [] (int) { stopRequested = true; });
    std::signal (SIGINT, [] (int) { stopRequested = true; });

    if (destination)
    {
#if JUCE_MAC
        TimestampedDestination published (name);
        const bool ready = published.published();
#elif JUCE_WINDOWS
        const bool ready = false; // no virtual ports
#else
        // JUCE's virtual destination (ALSA), with the arrival time alone:
        // the time a message carries is CoreMIDI's.
        MidiPrinter printer;
        auto published = juce::MidiInput::createNewDevice (name, &printer);
        if (published != nullptr)
            published->start();
        const bool ready = published != nullptr;
#endif
        if (! ready)
        {
            printError ("cannot create a virtual MIDI destination named " + name + " on this system");
            return 1;
        }
        printLine (jsonObject ({ { "ready", true }, { "name", name } }));
        runUntilStopped();
        return 0;
    }

    MidiPrinter printer;
    const auto giveUpAt = juce::Time::currentTimeMillis() + 5000;
    auto input = openSource (name, printer);
    while (input == nullptr && juce::Time::currentTimeMillis() < giveUpAt)
    {
        messageManager->runDispatchLoopUntil (100);
        input = openSource (name, printer);
    }
    if (input == nullptr)
    {
        printError ("no MIDI source named " + name);
        return 1;
    }

    input->start();
    printLine (jsonObject ({ { "ready", true }, { "name", name } }));
    runUntilStopped();
    input->stop();
    return 0;
}
} // namespace field
