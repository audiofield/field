#include "player.h"

#include "capture.h"
#include "capture_input.h"
#include "live.h"
#include "ring_input.h"
#include "version.h"

#if JUCE_MAC
#include <CoreAudio/CoreAudio.h>
#include <mach/mach.h>
#include <mach/thread_policy.h>
#endif

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstring>
#include <limits>
#include <thread>
#include <utility>

#if JUCE_MAC
namespace
{
// Core Audio calls property listeners on its own thread; the handler
// marshals onto the message thread, where all Player state lives. The
// Player outlives the dispatch loop (main.cpp destroys it after the
// drain), so a lambda landing during shutdown still finds it alive, and
// listeners are removed in the destructor before that.
OSStatus hardwareChanged (AudioObjectID, UInt32, const AudioObjectPropertyAddress*, void* clientData)
{
    auto* player = static_cast<Player*> (clientData);
    juce::MessageManager::callAsync ([player] { player->refreshAudioDevice(); });
    return noErr;
}

constexpr AudioObjectPropertyAddress kDefaultOutputAddress {
    kAudioHardwarePropertyDefaultOutputDevice,
    kAudioObjectPropertyScopeGlobal,
    kAudioObjectPropertyElementMain,
};
constexpr AudioObjectPropertyAddress kDeviceListAddress {
    kAudioHardwarePropertyDevices,
    kAudioObjectPropertyScopeGlobal,
    kAudioObjectPropertyElementMain,
};
} // namespace
#endif

namespace
{
juce::DynamicObject::Ptr obj() { return new juce::DynamicObject(); }

constexpr int nullBlockSize = 512;
constexpr double nullSampleRate = 48000.0;

// The null clock stands in for a device, whose callback Core Audio runs
// on a realtime thread, so it wakes on time on a loaded machine as a
// device's does: MIDI outputs and MIDI capture time each message from
// the start of its block. Elsewhere it keeps the priority it starts
// with, since raising it takes privileges a CI runner does not have.
void scheduleAsAudioThread()
{
#if JUCE_MAC
    const auto ticks = [] (double seconds) { return (uint32_t) juce::Time::secondsToHighResolutionTicks (seconds); };
    const double block = nullBlockSize / nullSampleRate;
    thread_time_constraint_policy_data_t policy { ticks (block), ticks (block / 2), ticks (block), 1 };
    thread_policy_set (pthread_mach_thread_np (pthread_self()), THREAD_TIME_CONSTRAINT_POLICY, (thread_policy_t) &policy,
                       THREAD_TIME_CONSTRAINT_POLICY_COUNT);
#endif
}

// Hosted teardown needs a free message thread, exactly like hosted
// construction: ~AudioUnitPluginInstance posts its dispose to the
// message thread and waits for it unconditionally, so a caller holding
// the MessageManagerLock waits on a message that can never run — the
// message thread is parked in that lock's handshake. Measured live on
// a creek AUDelay swap (#150 follow-up): the retired session died
// under loadSession's lock, the daemon deadlocked with the callback
// still streaming, and every later request — stop, quit, ctrl-c's
// stop — blocked on the blanket lock behind it. So a replaced session
// is handed to the message thread and dies there asynchronously:
// disposal lands on the one thread every plugin format accepts, and
// the request that retired it never waits for teardown. The callback
// is already off this session — the install moved liveSession under
// liveLock before the corpse gets here.
void retireOnMessageThread (std::unique_ptr<field::LiveSession> retired)
{
    if (retired == nullptr)
        return;
    // shared_ptr because callAsync copies its callable; the last copy
    // destroyed on the message thread carries the actual teardown.
    std::shared_ptr<field::LiveSession> keep (std::move (retired));
    juce::MessageManager::callAsync ([keep]() mutable { keep.reset(); });
}
} // namespace

Player::Player (bool useNullOutput)
    : nullMode (useNullOutput),
      serviceStallMs (useNullOutput
                          ? juce::SystemStats::getEnvironmentVariable ("FIELD_AUDIOD_SERVICE_STALL_MS", "0").getIntValue()
                          : 0),
      openStallMs (useNullOutput
                       ? juce::SystemStats::getEnvironmentVariable ("FIELD_AUDIOD_OPEN_STALL_MS", "0").getIntValue()
                       : 0),
      latchStallMs (useNullOutput
                        ? juce::SystemStats::getEnvironmentVariable ("FIELD_AUDIOD_LATCH_STALL_MS", "0").getIntValue()
                        : 0),
      captureOwnOutputs (useNullOutput && juce::SystemStats::getEnvironmentVariable ("FIELD_AUDIOD_CAPTURE_OUTPUTS", "0") == "1"),
      captureBlock (std::make_shared<field::CaptureBlock>()),
      midiOutputs (field::makeMidiSink, [this] { midiSender.wake(); },
                   [this]
                   {
                       waitOutBlocks();
                       midiSender.waitOutPass();
                   })
{
    formatManager.registerBasicFormats();
}

Player::~Player()
{
    // A take still running at shutdown (a quit mid-take) finalizes while
    // the callback can still acknowledge; what it cannot reach is left
    // as a recoverable transaction by ~Capture.
    stopRecording();
    // Here, not in the outputs' destructor: closing waits out the sender,
    // a member destroyed before them.
    closeMidiOutputs();
    closeMidiInputs();
    removeHardwareListeners();
    if (nullClockRunning.exchange (false) && nullClock.joinable())
        nullClock.join();
    if (! nullMode)
        deviceManager.removeAudioCallback (this);
    transport.setSource (nullptr);
}

// Core Audio is the only backend that will tell us. Everywhere else these
// are no-ops and the heartbeat polls instead — see
// `hardwareListenersAvailable` in player.h.
void Player::registerHardwareListeners()
{
#if JUCE_MAC
    if (nullMode || hardwareListenersRegistered)
        return;
    AudioObjectAddPropertyListener (kAudioObjectSystemObject, &kDefaultOutputAddress,
                                    hardwareChanged, this);
    AudioObjectAddPropertyListener (kAudioObjectSystemObject, &kDeviceListAddress,
                                    hardwareChanged, this);
    hardwareListenersRegistered = true;
#endif
}

void Player::removeHardwareListeners()
{
#if JUCE_MAC
    if (! hardwareListenersRegistered)
        return;
    AudioObjectRemovePropertyListener (kAudioObjectSystemObject, &kDefaultOutputAddress,
                                       hardwareChanged, this);
    AudioObjectRemovePropertyListener (kAudioObjectSystemObject, &kDeviceListAddress,
                                       hardwareChanged, this);
    hardwareListenersRegistered = false;
#endif
}

void Player::refreshAudioDevice()
{
    if (nullMode)
        return;
    // A device restart under a take is a gap in the callback and so a
    // gap in the audio, with no record of how long. Following the
    // default waits until the take ends: stopRecording calls back here.
    if (capture != nullptr)
        return;
    auto* type = deviceManager.getCurrentDeviceTypeObject();
    if (type == nullptr)
        return;
    type->scanForDevices();
    auto names = type->getDeviceNames (false);
    if (names.isEmpty())
        return;

    auto* current = deviceManager.getCurrentAudioDevice();
    const bool currentGone = current == nullptr || ! names.contains (current->getName());
    // An explicit selection stands as long as its device exists.
    if (explicitSelection && ! currentGone)
        return;
    if (currentGone)
        explicitSelection = false;

    auto defaultName = names[juce::jmax (0, type->getDefaultDeviceIndex (false))];
    if (! currentGone && current->getName() == defaultName)
        return;

    auto setup = deviceManager.getAudioDeviceSetup();
    setup.outputDeviceName = defaultName;
    deviceManager.setAudioDeviceSetup (setup, false);
    // A loaded file still prefers a device rate that matches it (§3.5).
    if (fileSampleRate > 0)
        maybeMatchDeviceRate (fileSampleRate);
}

juce::String Player::initialise()
{
    readThread.startThread();

    if (nullMode)
    {
        transport.prepareToPlay (nullBlockSize, nullSampleRate);
        silence.assign ((size_t) nullBlockSize, 0.0f);
        nullClockRunning = true;
        nullClock = std::thread ([this]
        {
            scheduleAsAudioThread();
            juce::AudioBuffer<float> scratch (2, nullBlockSize);
            // The null input (recording.md §5): channel 1 is a sawtooth
            // over one second of the input clock — consecutive samples
            // differ by exactly 2/48000 except at the wrap — so a test
            // reading a take back can prove no block was lost or
            // duplicated anywhere in it; channel 2 is a constant, so the
            // same test can prove arm picked the channel it named.
            std::vector<float> saw ((size_t) nullBlockSize);
            std::vector<float> flat ((size_t) nullBlockSize, 0.25f);
            juce::int64 inputClock = 0;
            auto next = std::chrono::steady_clock::now();
            while (nullClockRunning)
            {
                for (int i = 0; i < nullBlockSize; ++i)
                    saw[(size_t) i] = (float) ((double) ((inputClock + i) % 48000) / 48000.0 * 2.0 - 1.0);
                inputClock += nullBlockSize;
                // Presented the way a real duplex open presents it: only
                // the armed channels, in channel order, only while armed.
                const int mask = nullInputMask.load();
                const float* ins[2] {};
                int count = 0;
                if ((mask & 1) != 0)
                    ins[count++] = saw.data();
                if ((mask & 2) != 0)
                    ins[count++] = flat.data();
                processBlock (ins, count, scratch.getArrayOfWritePointers(), 2, nullBlockSize);
                // Real-time pace, so position and end-of-stream behave as
                // they would against a device. Against an absolute
                // deadline rather than a relative sleep: the relative
                // form added each block's processing time to its sleep
                // and ran a tenth slow, which a take's frame count
                // measures where a position readout never noticed.
                next += std::chrono::microseconds (
                    (long long) (1'000'000.0 * nullBlockSize / nullSampleRate));
                std::this_thread::sleep_until (next);
            }
        });
        return {};
    }

    auto error = deviceManager.initialiseWithDefaultDevices (0, 2);
    if (error.isNotEmpty())
        return error;
    deviceManager.addAudioCallback (this);
    registerHardwareListeners();
    return {};
}

juce::var Player::deviceList()
{
    auto result = obj();
    juce::Array<juce::var> devices;
    if (! nullMode)
    {
        if (auto* type = deviceManager.getCurrentDeviceTypeObject())
        {
            type->scanForDevices();
            auto names = type->getDeviceNames (false);
            auto defaultIndex = type->getDefaultDeviceIndex (false);
            for (int i = 0; i < names.size(); ++i)
            {
                auto d = obj();
                d->setProperty ("name", names[i]);
                d->setProperty ("default", i == defaultIndex);
                devices.add (juce::var (d.get()));
            }
        }
    }
    result->setProperty ("devices", devices);
    // The input side (recording.md §6): every input device, with how many
    // channels arm may name on it. The count comes from a device object
    // built and never opened, which is the only way to ask a device that
    // is not the current one.
    juce::Array<juce::var> inputs;
    if (! nullMode)
    {
        if (auto* type = deviceManager.getCurrentDeviceTypeObject())
        {
            auto names = type->getDeviceNames (true);
            auto defaultIndex = type->getDefaultDeviceIndex (true);
            for (int i = 0; i < names.size(); ++i)
            {
                auto d = obj();
                d->setProperty ("name", names[i]);
                d->setProperty ("default", i == defaultIndex);
                int channels = 0;
                if (auto* current = deviceManager.getCurrentAudioDevice();
                    current != nullptr && current->getName() == names[i])
                    channels = current->getInputChannelNames().size();
                else if (std::unique_ptr<juce::AudioIODevice> probe (type->createDevice ({}, names[i]));
                         probe != nullptr)
                    channels = probe->getInputChannelNames().size();
                d->setProperty ("channels", channels);
                inputs.add (juce::var (d.get()));
            }
        }
    }
    result->setProperty ("inputs", inputs);
    result->setProperty ("null_output", nullMode);
    return juce::var (result.get());
}

juce::String Player::selectDevice (const juce::String& name)
{
    if (nullMode)
        return "no devices in null-output mode";
    if (capture != nullptr)
        return "cannot change devices while recording (stop first)";
    auto setup = deviceManager.getAudioDeviceSetup();
    setup.outputDeviceName = name;
    auto error = deviceManager.setAudioDeviceSetup (setup, true);
    // Only a successful selection pins the device against default-follow.
    if (error.isEmpty())
        explicitSelection = true;
    return error;
}

void Player::maybeMatchDeviceRate (double fileRate)
{
    // Decision (playback.md §3.5): prefer running the device at the file's
    // rate; if the device refuses, the transport resamples and status says
    // so. Best-effort by design — failure here is not an error.
    if (nullMode)
        return;
    // Under a take the device stays put: a rate switch restarts it and
    // gaps the capture. Delivery converts instead (cross-rate-live.md
    // decision 3), which is the same answer as a device that cannot
    // switch.
    if (capture != nullptr)
        return;
    auto* device = deviceManager.getCurrentAudioDevice();
    if (device == nullptr || juce::exactlyEqual (device->getCurrentSampleRate(), fileRate))
        return;
    if (! device->getAvailableSampleRates().contains (fileRate))
        return;
    auto setup = deviceManager.getAudioDeviceSetup();
    setup.sampleRate = fileRate;
    deviceManager.setAudioDeviceSetup (setup, false);
}

juce::var Player::load (const juce::File& file, bool loop)
{
    auto result = obj();
    // A load rewinds to zero and drops the bed the take is placed
    // against; a session swap carries the transport and is allowed.
    if (capture != nullptr)
    {
        result->setProperty ("error", "cannot load while recording (stop first)");
        return juce::var (result.get());
    }
    std::unique_ptr<juce::AudioFormatReader> reader (formatManager.createReaderFor (file));
    if (reader == nullptr)
    {
        result->setProperty ("error", "cannot read audio file: " + file.getFullPathName());
        return juce::var (result.get());
    }
    // One source of audio at a time: a *valid* file load drops any live
    // session — an unreadable path must not leave the player empty
    // (Codex's finding on this PR). Retired outside liveLock (the
    // teardown would starve the callback) and off this thread entirely:
    // load dispatches under the blanket MessageManagerLock, where a
    // hosted session's AU teardown deadlocks (retireOnMessageThread).
    std::unique_ptr<field::LiveSession> retired;
    {
        const juce::ScopedLock guard (liveLock);
        livePlaying = false;
        liveEverStarted = false;
        retired = std::move (liveSession);
    }
    retireOnMessageThread (std::move (retired));

    transport.stop();
    transport.setSource (nullptr);
    readerSource.reset();
    click.clear(); // a schedule belongs to a bed

    fileSampleRate = reader->sampleRate;
    fileLengthSamples = reader->lengthInSamples;
    fileChannels = (int) reader->numChannels;
    loadedPath = file.getFullPathName();
    everStarted = false;

    maybeMatchDeviceRate (fileSampleRate);

    looping = loop;
    readerSource = std::make_unique<juce::AudioFormatReaderSource> (reader.release(), true);
    readerSource->setLooping (loop);
    // Handing the transport the file's rate is what makes it resample when
    // the device runs at a different one.
    transport.setSource (readerSource.get(), 1 << 15, &readThread, fileSampleRate);
    transport.setPosition (0.0);

    result->setProperty ("samples", fileLengthSamples);
    result->setProperty ("sample_rate", fileSampleRate);
    result->setProperty ("channels", fileChannels);
    return juce::var (result.get());
}

juce::var Player::loadSession (const juce::var& session, const juce::File& projectRoot)
{
    auto result = obj();
    try
    {
        // Construction — parsing, preloading, pre-rendering children,
        // instantiating plugins — happens before any lock: the old
        // session keeps playing through the whole compile, and the swap
        // itself is one pointer move at a block boundary (realtime.md
        // decision 5, chunk 3). Instantiation is why this method must
        // be entered without the MessageManagerLock (the session op is
        // the one request server.cpp dispatches outside its blanket
        // lock): JUCE's create posts to the message thread and waits,
        // so a caller holding the lock waits on itself — minjudd hung
        // `field play` with exactly that (#150). The hosting guard
        // turns that mistake into a load error instead of a hang.
        field::LiveInputs inputs;
        {
            std::lock_guard<std::mutex> hold (inputsLock);
            for (const auto& [name, input] : rings)
                inputs[name] = input.ring;
            for (const auto& [name, open] : captures)
                inputs[name] = open.input;
        }
        auto next = std::make_unique<field::LiveSession> (session, projectRoot, inputs);
        // Pre-roll outside the lock too: a swap lands at the old
        // session's position, and warming the replacement's chain there
        // (LiveSession::locate) renders seconds of discarded audio —
        // under the lock, that long a hold is a silent gap. The drift
        // between this prediction and the transport read again below is
        // a few blocks, which the second locate rolls forward through a
        // chain that keeps its state.
        {
            juce::int64 predicted = -1;
            {
                const juce::ScopedLock guard (liveLock);
                if (liveSession != nullptr)
                    predicted = liveSession->position();
            }
            // A loop take's region goes on first, so the chain warms on
            // it. The take can start or stop while this runs, so the
            // check under the lock below is the one that decides.
            carryTakeRegion (*next);
            if (predicted >= 0)
            {
                // The position counts every pass of a region, which wraps
                // it itself; a session's own loop wraps at its length.
                const bool region = next->loopRegionTo() > next->loopRegionFrom();
                if (! region && next->looping() && next->lengthSamples() > 0)
                    predicted %= next->lengthSamples();
                else if (! region && next->lengthSamples() > 0)
                    predicted = std::min (predicted, next->lengthSamples());
                next->locate (predicted);
            }
        }
        // Player state belongs to the message thread (server.cpp's
        // blanket lock, which the session op alone forgoes): from here
        // to the end of the install this thread holds its lock, exactly
        // what every other request gets from handleLine.
        const juce::MessageManagerLock mml;
        if (auto error = carryTakeRegion (*next); error.isNotEmpty())
        {
            // Refused: the session dies on the message thread, as a
            // retired one does (retireOnMessageThread).
            retireOnMessageThread (std::move (next));
            result->setProperty ("error", error);
            return juce::var (result.get());
        }
        // Prefer running the device at the session's rate (bit-perfect
        // delivery); when it cannot switch, the prepared converter below
        // sets up converted delivery instead of refusing
        // (cross-rate-live.md decision 3). Outside the lock: a switch
        // restarts the device, and the callback keeps pulling the old
        // session while it happens.
        maybeMatchDeviceRate ((double) next->sessionRate());
        // Conversion state is prepared out here too (Codex's finding on
        // this PR): the kernel design and the FIFO reservation are
        // exactly the work pullAudio's try-lock would wait out as a
        // silent block. Whether to *install* it is decided under the
        // lock — a swap that keeps the rate pair keeps the converter
        // and its queued audio outright (minjudd's finding: the FIFO
        // holds the next thing the ear should hear, and dropping it
        // skipped 10–20 ms on every live-watch edit). Decision 3's
        // reset cases stay: locate, stop, device start, and a swap
        // that actually moves the pair.
        const double nextRate = (double) next->sessionRate();
        const double devRate = currentDeviceRate();
        const bool wantConverter = devRate > 0.0 && ! juce::exactlyEqual (devRate, nextRate);
        std::unique_ptr<field::dsp::Resampler> prepared;
        std::vector<std::vector<float>> preparedIn (2), preparedOut (2);
        if (wantConverter)
        {
            prepared = std::make_unique<field::dsp::Resampler> (nextRate, devRate, 2);
            for (auto& ch : preparedIn)
                ch.reserve (512);
            for (auto& ch : preparedOut)
                ch.reserve (1 << 16);
        }
        // Never destroyed here: a session owns preloaded files,
        // full-length child buffers, and hosted instances. Under
        // liveLock that teardown hands the callback silent blocks
        // (pullAudio try-locks and pads on a miss — Codex's finding),
        // and under the MessageManagerLock this function holds, an AU
        // instance's dispose deadlocks the daemon (measured — see
        // retireOnMessageThread). The corpse is handed off below.
        std::unique_ptr<field::LiveSession> retired;
        {
            const juce::ScopedLock guard (liveLock);
            // A swap mid-play carries the transport: latest compile wins
            // and the play never stops. A fresh load (no session before)
            // starts stopped at zero, as ever.
            const bool hadSession = liveSession != nullptr;
            const bool wasPlaying = livePlaying.load();
            juce::int64 carry = hadSession ? liveSession->position() : 0;
            // The session replaces whatever file was loaded — one source
            // of audio at a time, whichever arrived last.
            transport.stop();
            transport.setSource (nullptr);
            readerSource.reset();
            loadedPath.clear();
            everStarted = false;
            livePlaying = false;
            if (! hadSession)
            {
                liveEverStarted = false;
                click.clear(); // a fresh bed; a swap keeps the schedule, the CLI re-sends on a map change
            }
            liveRate = next->sessionRate();
            liveLength = next->lengthSamples();
            liveLoop = next->looping();
            liveSong = session.getProperty ("song", juce::var()).toString();
            liveSolo = session.getProperty ("solo", juce::var()).toString();
            retired = std::move (liveSession);
            liveSession = std::move (next);
            if (hadSession)
            {
                // As at the pre-roll: a carried region wraps the position.
                const bool region = liveSession->loopRegionTo() > liveSession->loopRegionFrom();
                if (! region && liveLoop && liveLength > 0)
                    carry %= liveLength;
                else if (! region && liveLength > 0)
                    carry = std::min (carry, liveLength);
                liveSession->locate (carry);
                livePlaying = wasPlaying;
            }
            // Install the prepared conversion only when the state cannot
            // carry: a fresh start, a moved rate pair, or a stream
            // already flushed (a natural end racing the swap — the old
            // converter cannot take more input). Otherwise the converter,
            // its FIFO, and its filter history all survive — the
            // delivered stream really is continuous across a same-pair
            // swap.
            if (! hadSession || convFlushed
                || ! juce::exactlyEqual (nextRate, convLiveRate)
                || ! juce::exactlyEqual (devRate, convDeviceRate))
            {
                liveConverter = std::move (prepared);
                convIn = std::move (preparedIn);
                convOut = std::move (preparedOut);
                convOutRead = 0;
                convFlushed = false;
                convQueued.store (0);
                convLiveRate = nextRate;
                convDeviceRate = devRate;
            }
        }
        retireOnMessageThread (std::move (retired));
        {
            // The device is settled now: each ring says the rate it is
            // read at, for a FieldOut started from here on to check.
            std::lock_guard<std::mutex> hold (inputsLock);
            for (auto& [name, input] : rings)
                input.ring->setSampleRate ((uint32_t) std::lround (currentDeviceRate()));
        }
        result->setProperty ("samples", liveLength);
        result->setProperty ("sample_rate", liveRate);
        result->setProperty ("channels", 2);
    }
    catch (const std::exception& e)
    {
        result->setProperty ("error", juce::String (e.what()));
    }
    return juce::var (result.get());
}

juce::String Player::liveRamp (const juce::String& track, int input, double gainDb, double rampMs)
{
    if (liveSession == nullptr)
        return "no live session";
    const juce::ScopedLock guard (liveLock);
    try
    {
        liveSession->ramp (track.toStdString(), input, gainDb, rampMs);
    }
    catch (const std::exception& e)
    {
        return e.what();
    }
    return {};
}

juce::String Player::play()
{
    if (liveSession != nullptr)
    {
        liveEverStarted = true;
        livePlaying = true;
        return {};
    }
    if (readerSource == nullptr)
        return "nothing loaded";
    if (streamFinished())
        transport.setPosition (0.0); // play after natural end restarts
    everStarted = true;
    transport.start();
    return {};
}

void Player::pause()
{
    // Pausing ends the take: the bed stops, and a capture that kept
    // running against a still transport would be a take placed at a
    // position the performer was no longer hearing.
    stopRecording();
    if (liveSession != nullptr)
    {
        livePlaying = false;
        // What you play next over silence starts clean.
        const juce::ScopedLock guard (liveLock);
        liveSession->resetIdle();
        return;
    }
    transport.stop();
}

void Player::stop()
{
    // First, while the transport still says where the take ended.
    stopRecording();
    if (liveSession != nullptr)
    {
        livePlaying = false;
        liveEverStarted = false;
        const juce::ScopedLock guard (liveLock);
        liveSession->locate (0);
        liveSession->resetIdle();
        // A transport discontinuity resets delivery conversion to its
        // primed starting state and drops queued output — pre-seek
        // audio never leaks (cross-rate-live.md decision 3).
        rebuildLiveConverter();
        return;
    }
    transport.stop();
    transport.setPosition (0.0);
    everStarted = false;
}

juce::String Player::locate (juce::int64 sample)
{
    // A seek under a take would put later samples of the take against
    // an earlier or later bed than the ones before them; the take's one
    // placement could not describe that.
    if (capture != nullptr)
        return "cannot locate while recording (stop first)";
    return seek (sample);
}

juce::String Player::seek (juce::int64 sample)
{
    if (liveSession != nullptr)
    {
        if (sample < 0 || (! liveSession->looping() && liveLength > 0 && sample > liveLength))
            return "locate out of range";
        const juce::ScopedLock guard (liveLock);
        try
        {
            liveSession->locate (sample);
        }
        catch (const std::exception& e)
        {
            // An op error, not a dead reader thread — nothing above
            // dispatch catches (liveRamp's shape).
            return juce::String (e.what());
        }
        rebuildLiveConverter();
        return {};
    }
    if (readerSource == nullptr)
        return "nothing loaded";
    if (sample < 0 || sample > fileLengthSamples)
        return "locate out of range";
    transport.setPosition ((double) sample / fileSampleRate);
    return {};
}

juce::int64 Player::positionSamples() const
{
    if (fileSampleRate <= 0.0)
        return 0;
    return (juce::int64) std::llround (transport.getCurrentPosition() * fileSampleRate);
}

bool Player::streamFinished() const
{
    if (liveSession != nullptr)
    {
        // The session position runs ahead of the ear when delivery
        // converts (it counts what entered the converter), so finished
        // also waits for the flush and the converted FIFO's drain —
        // the last taps/2 of tail are heard before the transport
        // reports done (cross-rate-live.md decision 3). Checked under
        // liveLock: the callback that crosses the extent updates
        // position, flushes, and queues the tail while holding it, so
        // the heartbeat sees that callback's state whole or not at
        // all — a lockless read could catch position past the extent
        // with the tail not yet counted, and stop() would drop it
        // (Codex's finding on this PR).
        const juce::ScopedLock guard (liveLock);
        const bool drained = liveConverter == nullptr
                             || (convFlushed && convOut[0].size() == convOutRead);
        return liveEverStarted && ! liveSession->looping() && liveLength > 0
               && liveSession->position() >= liveLength && drained;
    }
    // A looping stream never finishes; stop is the only way out.
    return readerSource != nullptr && everStarted && ! looping && transport.hasStreamFinished();
}

juce::String Player::transportState()
{
    if (liveSession != nullptr)
    {
        if (livePlaying.load() && ! streamFinished())
            return "playing";
        if (liveEverStarted && liveSession->position() > 0 && ! streamFinished())
            return "paused";
        return "stopped";
    }
    if (transport.isPlaying())
        return "playing";
    if (readerSource != nullptr && everStarted && positionSamples() > 0 && ! streamFinished())
        return "paused";
    return "stopped";
}

juce::var Player::openInput (const juce::String& name, const void* owner)
{
    auto result = obj();
    if (name.isEmpty())
    {
        result->setProperty ("error", "input needs a name");
        return juce::var (result.get());
    }
    std::shared_ptr<field::RingInput> ring;
    {
        std::lock_guard<std::mutex> hold (inputsLock);
        if (rings.count (name.toStdString()) > 0 || captures.count (name.toStdString()) > 0)
        {
            result->setProperty ("error", "input \"" + name + "\" is already open");
            return juce::var (result.get());
        }
        try
        {
            ring = std::make_shared<field::RingInput> ((uint32_t) std::lround (currentDeviceRate()));
            result->setProperty ("name", name);
            result->setProperty ("ring", (int) ring->id());
            result->setProperty ("capacity", (int) ring->capacity());
            result->setProperty ("channels", 2);
            result->setProperty ("sample_rate", currentDeviceRate());
            rings[name.toStdString()] = { ring, owner };
        }
        catch (const std::exception& e)
        {
            result->setProperty ("error", juce::String (e.what()));
            return juce::var (result.get());
        }
    }
    // An output can name its lead input before the input opens, as
    // `field seq` does before its voice connects.
    midiOutputs.bindLeadInput (name, ring);
    return juce::var (result.get());
}

void Player::closeInputs()
{
    std::lock_guard<std::mutex> hold (inputsLock);
    for (auto& [name, input] : rings)
        input.ring->retire();
    rings.clear();
    for (auto& [name, open] : captures)
        open.input->close();
    captures.clear();
}

void Player::closeCaptures (const void* owner)
{
    std::lock_guard<std::mutex> hold (inputsLock);
    for (auto it = captures.begin(); it != captures.end();)
    {
        if (owner == nullptr || it->second.owner == owner)
        {
            it->second.input->close();
            it = captures.erase (it);
        }
        else
        {
            ++it;
        }
    }
}

void Player::closeInputsOwnedBy (const void* owner)
{
    if (owner == nullptr)
        return;
    // A monitored arm whose `field record` died stops being heard with
    // its connection; the arm itself stays, as it always has.
    closeCaptures (owner);
    std::lock_guard<std::mutex> hold (inputsLock);
    for (auto it = rings.begin(); it != rings.end();)
    {
        if (it->second.owner == owner)
        {
            it->second.ring->retire();
            it = rings.erase (it);
        }
        else
        {
            ++it;
        }
    }
}

juce::String Player::closeInput (const juce::String& name)
{
    std::lock_guard<std::mutex> hold (inputsLock);
    const auto found = rings.find (name.toStdString());
    if (found == rings.end())
        return "no input named \"" + name + "\"";
    found->second.ring->retire();
    rings.erase (found);
    return {};
}

juce::var Player::status (bool consumePeak)
{
    auto result = obj();
    result->setProperty ("state", transportState());
    {
        // Each open input's ring and its counters (live-supercollider.md
        // §2): whether FieldOut is writing, and whether the reader keeps up.
        std::lock_guard<std::mutex> hold (inputsLock);
        if (! rings.empty() || ! captures.empty())
        {
            juce::Array<juce::var> list;
            for (const auto& [name, input] : rings)
            {
                auto stats = input.ring->stats (consumePeak);
                stats.getDynamicObject()->setProperty ("name", juce::String (name));
                list.add (stats);
            }
            // The armed inputs a session hears (live-supercollider.md §12).
            for (const auto& [name, open] : captures)
            {
                auto stats = open.input->stats (consumePeak);
                stats.getDynamicObject()->setProperty ("name", juce::String (name));
                list.add (stats);
            }
            result->setProperty ("inputs", list);
        }
    }
    if (liveSession != nullptr)
    {
        result->setProperty ("sample", liveSession->wrappedPosition());
        result->setProperty ("samples", liveLength);
        result->setProperty ("looping", liveSession->looping());
        if (liveSession->loopRegionTo() > liveSession->loopRegionFrom())
        {
            result->setProperty ("loop_from", liveSession->loopRegionFrom());
            result->setProperty ("loop_to", liveSession->loopRegionTo());
        }
        result->setProperty ("path", juce::var());
        result->setProperty ("live", true);
        if (liveSong.isNotEmpty())
            result->setProperty ("song", liveSong);
        if (liveSolo.isNotEmpty())
            result->setProperty ("solo", liveSolo);
        result->setProperty ("sample_rate", liveRate);
        // The in-flight converted audio decision 3's skew bound talks
        // about: already-converted frames the ear has not heard yet.
        // Zero when delivery is not converting.
        result->setProperty ("conv_queued", convQueued.load());
    }
    else
    {
        result->setProperty ("sample", positionSamples());
        result->setProperty ("samples", fileLengthSamples);
        result->setProperty ("looping", looping);
        result->setProperty ("path", loadedPath.isEmpty() ? juce::var() : juce::var (loadedPath));
    }
    result->setProperty ("null_output", nullMode);

    // The input side (recording.md §6): what is armed, what is being
    // taken, and the one meter V1 carries — the peak since the last
    // client read, which that read resets. One reader is the blocking
    // `field record`; two readers would each see half the peaks, which
    // is the widget's problem to solve when it becomes a reader. The
    // heartbeat's own reads never consume it (player.h).
    {
        auto rec = obj();
        rec->setProperty ("state", recordState());
        if (armed.load() && armedMidi.load())
        {
            rec->setProperty ("track", armedTrack);
            rec->setProperty ("kind", "midi");
            juce::Array<juce::var> sources;
            for (const auto& source : midiSources)
                sources.add (source);
            rec->setProperty ("sources", sources);
            rec->setProperty ("input_peak", 0.0);
        }
        else if (armed.load())
        {
            rec->setProperty ("track", armedTrack);
            rec->setProperty ("device", armedDevice);
            rec->setProperty ("input", armedInput);
            rec->setProperty ("input_peak",
                              (double) (consumePeak ? inputPeak.exchange (0.0f) : inputPeak.load()));
        }
        if (capture != nullptr)
        {
            rec->setProperty ("transaction", capture->id());
            rec->setProperty ("file", capture->file());
            rec->setProperty ("started_at_samples", capture->startedAt());
            // Counting in: the take exists and has not reached its position.
            // A loop's take is pending too while the pass before it is
            // skipped, until the wrap that begins it.
            rec->setProperty ("pending", ! captureStarted.load() || capture->startedAt() < 0);
            if (captureUntil.load() >= 0)
                rec->setProperty ("until", captureUntil.load());
            if (captureLoop.load())
            {
                rec->setProperty ("loop", true);
                rec->setProperty ("loop_takes", loopTakes);
                rec->setProperty ("missed", captureMissed.load());
            }
            capture->describeProgress (*rec);
        }
        // With more than one track armed (arming.md §2.2), every one, the
        // primary first: its kind, its input and meter, and its take's
        // progress. One armed track reports as it always has.
        if (armed.load() && companionCount > 0)
        {
            juce::Array<juce::var> list;
            const auto item = [&] (const juce::String& track, bool midi, int input, double peak,
                                   const field::Transaction* take)
            {
                auto entry = obj();
                entry->setProperty ("track", track);
                entry->setProperty ("kind", midi ? "midi" : "audio");
                if (! midi)
                {
                    entry->setProperty ("input", input);
                    entry->setProperty ("input_peak", peak);
                }
                if (take != nullptr)
                {
                    entry->setProperty ("transaction", take->id());
                    take->describeProgress (*entry);
                }
                list.add (juce::var (entry.get()));
            };
            item (armedTrack, armedMidi.load(), armedInput,
                  (double) rec->getProperty ("input_peak").operator double(), capture.get());
            for (int c = 0; c < companionCount; ++c)
            {
                auto& companion = companions[(size_t) c];
                const double peak = consumePeak ? companion.peak.exchange (0.0f) : companion.peak.load();
                item (companion.track, companion.midi.load(), companion.input, peak, companion.take.get());
            }
            rec->setProperty ("armed", list);
            // An audio primary's MIDI companions listen to the arm's
            // sources, named here as a MIDI primary's are above.
            if (! armedMidi.load() && ! midiSources.isEmpty())
            {
                juce::Array<juce::var> sources;
                for (const auto& source : midiSources)
                    sources.add (source);
                rec->setProperty ("sources", sources);
            }
        }
        result->setProperty ("record", juce::var (rec.get()));
    }
    result->setProperty ("click_ticks", click.tickCount());
    if (! midiOutputs.empty())
        result->setProperty ("outputs", midiOutputs.describe());

    double deviceRate = nullMode ? nullSampleRate : 0.0;
    if (! nullMode)
        if (auto* device = deviceManager.getCurrentAudioDevice())
        {
            deviceRate = device->getCurrentSampleRate();
            auto d = obj();
            d->setProperty ("name", device->getName());
            d->setProperty ("sample_rate", deviceRate);
            result->setProperty ("device", juce::var (d.get()));
        }
    const double sourceRate = liveSession != nullptr ? (double) liveRate : fileSampleRate;
    result->setProperty ("resampling",
                         (liveSession != nullptr || readerSource != nullptr) && deviceRate > 0.0
                             && ! juce::exactlyEqual (deviceRate, sourceRate));
    return juce::var (result.get());
}

double Player::currentDeviceRate() const
{
    return nullMode ? nullSampleRate
                    : (deviceManager.getCurrentAudioDevice() != nullptr
                           ? deviceManager.getCurrentAudioDevice()->getCurrentSampleRate()
                           : 0.0);
}

// Reset-and-rebuild for delivery conversion; callers hold liveLock.
// Building fresh *is* the reset the plan specifies: the resampler's
// primed-with-zeros starting state, an empty FIFO, nothing queued.
void Player::rebuildLiveConverter()
{
    liveConverter.reset();
    convOut.assign (2, std::vector<float>());
    convOutRead = 0;
    convFlushed = false;
    convQueued.store (0);
    convLiveRate = liveSession != nullptr ? (double) liveRate : 0.0;
    convDeviceRate = currentDeviceRate();
    if (liveSession == nullptr || liveRate <= 0)
        return;
    const double deviceRate = convDeviceRate;
    if (deviceRate <= 0.0 || juce::exactlyEqual (deviceRate, (double) liveRate))
        return;
    liveConverter = std::make_unique<field::dsp::Resampler> ((double) liveRate, deviceRate, 2);
    convIn.assign (2, std::vector<float>());
    // Reserved so the callback's process/push_back stays off the heap
    // in steady state; the compaction below keeps the FIFO inside this.
    for (auto& ch : convIn)
        ch.reserve (512);
    for (auto& ch : convOut)
        ch.reserve (1 << 16);
}

juce::int64 Player::pullAudio (const float* const* in, int numInputs, float* const* out, int numChannels, int n)
{
    blockSawRequest = false;
    blockBed = {};
    {
        // The pointer is only readable under the lock (cursor's finding:
        // checking it first races a message-thread load). A missed lock
        // is one silent block during a rare edit, not a glitch.
        const juce::ScopedTryLock guard (liveLock);
        if (! guard.isLocked())
        {
            for (int c = 0; c < numChannels; ++c)
                std::fill (out[c], out[c] + n, 0.0f);
            blockBed.missed = true;
            return -1;
        }
        // What the latch may act on: a request this pull saw, so the
        // position it returns is from after record's jump to `at`.
        blockSawRequest = captureStartRequested.load();
        if (liveSession != nullptr)
        {
            // The armed input, for the capture inputs a monitored session
            // reads (live-supercollider.md §12), until the render is done.
            // Converted delivery renders session-rate steps that are not
            // this block's frames, so it hears nothing: the CLI refuses
            // host monitoring there.
            captureBlock->present (liveConverter == nullptr ? in : nullptr, numInputs, n);
            struct Cleared
            {
                field::CaptureBlock& block;
                ~Cleared() { block.clear(); }
            } cleared { *captureBlock };
            // The song-timeline position this block starts at — wrapped
            // into whichever loop is in force, as status reports it —
            // which is where a take beginning here is placed.
            const juce::int64 position = liveSession->wrappedPosition();
            const bool region = liveSession->loopRegionTo() > liveSession->loopRegionFrom();
            blockBed = { false, (double) liveRate, liveConverter == nullptr, region ? liveSession->loopRegionFrom() : 0,
                         region ? liveSession->loopRegionTo() : liveLoop ? liveLength : 0 };
            if (livePlaying.load())
            {
                if (liveConverter == nullptr)
                {
                    liveSession->renderBlock (out, numChannels, n);
                    return position;
                }
                // Converted delivery: render session-rate blocks into
                // the resampler until n device frames wait in the FIFO.
                // Past the session's extent the input is silence, which
                // pushes the kernel's tail through; the final remainder
                // arrives via one flush, after which the FIFO drains to
                // empty and streamFinished may fire.
                const int step = 512;
                while ((juce::int64) (convOut[0].size() - convOutRead) < (juce::int64) n
                       && ! convFlushed)
                {
                    // The final block stops at the extent: the input
                    // past it is padding the flush already provides,
                    // and converting it too would deliver frames
                    // beyond the declared conversion — a late natural
                    // stop by up to a block (Codex's finding on this
                    // PR). Total input is then exactly the extent, so
                    // total output is exactly its convertedLength.
                    juce::int64 render = step;
                    if (! liveLoop && liveLength > 0)
                        render = std::min (render,
                                           std::max<juce::int64> (0, liveLength
                                                                         - liveSession->position()));
                    if (render > 0)
                    {
                        for (auto& ch : convIn)
                            ch.assign ((size_t) render, 0.0f);
                        float* ins[2] = { convIn[0].data(), convIn[1].data() };
                        liveSession->renderBlock (ins, 2, (int) render);
                        liveConverter->process (convIn, convOut);
                    }
                    if (! liveLoop && liveLength > 0
                        && liveSession->position() >= liveLength)
                    {
                        liveConverter->flush (convOut);
                        convFlushed = true;
                    }
                }
                const juce::int64 have = (juce::int64) (convOut[0].size() - convOutRead);
                const int give = (int) std::min<juce::int64> (n, have);
                for (int c = 0; c < numChannels; ++c)
                {
                    const auto& src = convOut[(size_t) std::min (c, 1)];
                    for (int i = 0; i < n; ++i)
                        out[c][i] = c < 2 && i < give ? src[convOutRead + (size_t) i] : 0.0f;
                }
                convOutRead += (size_t) give;
                convQueued.store ((juce::int64) (convOut[0].size() - convOutRead));
                if (convOutRead > (size_t) (1 << 15))
                {
                    // memmove, not allocation: capacity stays put.
                    for (auto& ch : convOut)
                        ch.erase (ch.begin(), ch.begin() + (std::ptrdiff_t) convOutRead);
                    convOutRead = 0;
                }
                return position;
            }
            // Stopped with a live input (live-supercollider.md §7
            // question 2): what you play is heard over silence. Converted
            // delivery has no idle path, because an input plays at the
            // device's rate, which is then not the session's.
            if (liveConverter == nullptr && liveSession->hasInputs())
                liveSession->renderIdle (out, numChannels, n);
            else
                for (int c = 0; c < numChannels; ++c)
                    std::fill (out[c], out[c] + n, 0.0f);
            // A bed that is not rolling has no position to latch a take
            // or a tick on: the first playing block is where both start.
            return -1;
        }
        if (readerSource == nullptr)
        {
            for (int c = 0; c < numChannels; ++c)
                std::fill (out[c], out[c] + n, 0.0f);
            return -2; // no bed: the tap places against the free clock
        }
        // A file bed's position and pull under the same lock as a live
        // one's, so record's jump falls wholly before or after them.
        const juce::int64 position = transport.isPlaying() ? positionSamples() : -1;
        blockBed = { false, fileSampleRate, juce::exactlyEqual (fileSampleRate, currentDeviceRate()), 0,
                     looping ? fileLengthSamples : 0 };
        juce::AudioBuffer<float> buffer (const_cast<float**> (out), numChannels, n);
        juce::AudioSourceChannelInfo info (&buffer, 0, n);
        transport.getNextAudioBlock (info);
        return position;
    }
}

void Player::processBlock (const float* const* in, int numInputs, float* const* out, int numOutputs, int n)
{
    const double blockStartMs = juce::Time::getMillisecondCounterHiRes();
    takeChaseSeeds();
    const juce::int64 position = pullAudio (in, numInputs, out, numOutputs, n);
    if (latchStallMs > 0)
        std::this_thread::sleep_for (std::chrono::milliseconds (latchStallMs));
    const juce::int64 freeBefore = freeClock.fetch_add (n);
    // The metronome rides the output after the pull, positioned by the
    // same block-start position the capture latches on; with no bed it
    // counts on the free clock, which is a metronome by itself.
    click.render (position == -2 ? freeBefore : position, currentDeviceRate(), out, numOutputs, n);
    {
        const double deviceRate = currentDeviceRate();
        field::MidiBlock midi;
        midi.startMs = blockStartMs;
        midi.missed = blockBed.missed;
        midi.rolling = position >= 0;
        midi.position = position;
        midi.bedPerFrame = blockBed.rate > 0.0 && deviceRate > 0.0 ? blockBed.rate / deviceRate : 1.0;
        midi.advance = std::llround (n * midi.bedPerFrame);
        // Converted delivery renders the bed in steps of its own, and a
        // resampled file through a buffer, so their advance only
        // approximates a block's.
        midi.slack = blockBed.exact ? 0 : n + 1024;
        midi.wrapFrom = blockBed.wrapFrom;
        midi.wrapTo = blockBed.wrapTo;
        midiOutputs.play (midi);
    }
    // Counted after the pull: a finalize that has seen two more epochs
    // knows the block that was in flight when it cleared activeCapture
    // has fully passed through here.
    callbackEpoch.fetch_add (1);

    const int channel = captureChannel.load();
    const float* input = (in != nullptr && channel >= 0 && channel < numInputs) ? in[channel] : nullptr;
    if (input != nullptr)
    {
        float peak = 0.0f;
        for (int i = 0; i < n; ++i)
            peak = std::max (peak, std::fabs (input[i]));
        // One writer (this thread); status exchanges it back to zero.
        if (peak > inputPeak.load())
            inputPeak.store (peak);
    }

    // Each armed companion's input has its own meter.
    const int live = liveCompanions.load();
    for (int c = 0; c < live; ++c)
    {
        auto& companion = companions[(size_t) c];
        const int own = companion.channel.load();
        if (companion.midi.load() || in == nullptr || own < 0 || own >= numInputs)
            continue;
        float peak = 0.0f;
        for (int i = 0; i < n; ++i)
            peak = std::max (peak, std::fabs (in[own][i]));
        if (peak > companion.peak.load())
            companion.peak.store (peak);
    }

    if (auto* midiTake = activeMidiCapture.load())
    {
        recordMidiBlock (*midiTake, position, freeBefore, n, blockStartMs);
        return;
    }
    recordAudioBlock (in, numInputs, input, position, freeBefore, n);
    // An audio primary's MIDI companions stamp what arrived on the clock
    // its latch set; otherwise what arrived belongs to no take, and only
    // the chase keeps it.
    if (companionMidiRunning.load())
        recordMidiCompanions (n, blockStartMs);
    else
        drainMidiArrivals ([this] (const MidiArrival& arrival) { chaseArrival (arrival); });
}

void Player::recordAudioBlock (const float* const* in, int numInputs, const float* input, juce::int64 position,
                               juce::int64 freeBefore, int n)
{
    const int live = liveCompanions.load();
    auto* target = activeCapture.load();
    // A loop pass that began with no standby ready has no take and is
    // skipped whole (recording.md §15.4). Its blocks still run to the
    // wrap below, because that is where a standby opened meanwhile takes
    // over: at a pass's first sample, never in the middle of one.
    const bool skipping = target == nullptr && captureLoop.load() && captureStarted.load();
    if (target == nullptr && ! skipping)
        return;
    int from = 0; // the first frame of this block the take includes
    if (target != nullptr && captureStartRequested.load())
    {
        // Armed after this block's pull: its position may be from before
        // record's jump, so the next block, which saw the request, starts
        // the take.
        if (! blockSawRequest)
            return;
        // A missed live lock made this block silence with no position to
        // latch; the take starts on the next block instead, so the latch
        // and the first pushed samples always describe the same instant.
        if (position == -1)
            return;
        const juce::int64 here = position == -2 ? freeBefore : position;
        const juce::int64 startAt = captureStartAt.load();
        if (startAt >= 0)
        {
            // A pre-rolled take (count-in) waits for its position, and
            // begins mid-block when the position falls inside this one,
            // so started_at_samples is exactly what was asked for.
            if (here + n <= startAt)
                return;
            from = (int) std::max<juce::int64> (0, startAt - here);
        }
        captureStartRequested = false;
        target->setStartedAt (here + from);
        // The companions start on the same sample (arming.md §2.2). Its
        // MIDI ones run on the MIDI clock, which starts here too.
        bool midiCompanion = false;
        for (int c = 0; c < live; ++c)
        {
            if (auto* take = companions[(size_t) c].audio.load())
                take->setStartedAt (here + from);
            if (auto* take = companions[(size_t) c].midiTake.load())
            {
                take->setStartedAt (here + from);
                midiCompanion = true;
            }
        }
        if (midiCompanion)
        {
            midiTakeClock = -from;
            midiFloor = std::numeric_limits<juce::int64>::min();
            midiLastAt = 0;
            midiArrivalsLost = 0;
            chasePending = true;
            companionMidiRunning = true;
        }
        captureStarted = true;
    }
    if (! captureStarted.load())
        return;
    // Punch-out (recording.md §10.4): the take ends on `until` exactly,
    // mid-block. Under a loop take the same frame begins the next pass
    // — the wrap in pullAudio put the rest of this block at the region's
    // start — so the standby transaction takes over inside this block
    // and not one sample is lost between passes. A block that ends
    // exactly on `until` ends the pass too, with nothing left over: the
    // next block already begins at the region's start, so it cannot.
    const juce::int64 untilAt = captureUntil.load();
    const juce::int64 here = position == -2 ? freeBefore : position;
    int cut = n;
    bool ending = false;
    if (untilAt >= 0 && position >= 0 && here + n >= untilAt)
    {
        cut = (int) std::max<juce::int64> (from, untilAt - here);
        ending = true;
    }
    const float* source = input != nullptr ? input : ((int) silence.size() >= n ? silence.data() : nullptr);
    if (source == nullptr)
        return;
    if (target != nullptr && cut > from)
    {
        target->push (source + from, cut - from);
        // Each audio companion takes the same span of its own input.
        for (int c = 0; c < live; ++c)
            if (auto* take = companions[(size_t) c].audio.load())
            {
                const int own = companions[(size_t) c].channel.load();
                const bool present = in != nullptr && own >= 0 && own < numInputs;
                const float* ownSource = present ? in[own] : ((int) silence.size() >= n ? silence.data() : nullptr);
                if (ownSource != nullptr)
                    take->push (ownSource + from, cut - from);
            }
    }
    if (! ending)
        return;
    if (captureLoop.load())
    {
        // Whether or not the heartbeat has finalized the last take, the
        // standby it opened takes over here, and with none ready the pass
        // that begins here is skipped and counted.
        auto* next = standbyCapture.exchange (nullptr);
        activeCapture = next;
        if (next != nullptr)
        {
            next->setStartedAt (captureStartAt.load());
            if (n > cut)
                next->push (source + cut, n - cut);
        }
        else
            captureMissed.fetch_add (1);
    }
    else
    {
        activeCapture = nullptr;
        captureStarted = false;
        for (int c = 0; c < live; ++c)
            companions[(size_t) c].audio = nullptr;
    }
    // A skipped pass ended no take. MIDI companions end a block later,
    // as a MIDI take ends (recordMidiCompanions); the pass is done when
    // they are.
    if (target != nullptr && ! companionMidiRunning.load())
        capturesEnded.fetch_add (1);
}

template <typename Handle>
void Player::drainMidiArrivals (Handle&& handle)
{
    const int ready = midiArrivals.getNumReady();
    if (ready <= 0)
        return;
    int start1, size1, start2, size2;
    midiArrivals.prepareToRead (ready, start1, size1, start2, size2);
    for (int i = 0; i < size1; ++i)
        handle (midiArrivalRing[(size_t) (start1 + i)]);
    for (int i = 0; i < size2; ++i)
        handle (midiArrivalRing[(size_t) (start2 + i)]);
    midiArrivals.finishedRead (size1 + size2);
}

void Player::recordMidiBlock (field::MidiCapture& take, juce::int64 position, juce::int64 freeBefore, int n,
                              double blockStartMs)
{
    // A block with no position (a missed live lock, a bed not rolling
    // yet) leaves the arrivals queued: the next block places them, back
    // from its own start.
    if (position == -1)
        return;
    const auto chaseEach = [this] (const MidiArrival& arrival) { chaseArrival (arrival); };
    const juce::int64 here = position == -2 ? freeBefore : position;
    // A MIDI primary's companions are MIDI too, since armSet makes an
    // audio track the primary whenever one is armed, and they record
    // exactly what it records (arming.md §2.2).
    const int live = liveCompanions.load();
    const auto eachCompanion = [&] (auto&& use)
    {
        for (int c = 0; c < live; ++c)
            if (auto* companion = companions[(size_t) c].midiTake.load())
                use (*companion);
    };
    if (captureStartRequested.load())
    {
        if (! blockSawRequest)
        {
            drainMidiArrivals (chaseEach);
            return;
        }
        int from = 0;
        const juce::int64 startAt = captureStartAt.load();
        if (startAt >= 0)
        {
            if (here + n <= startAt)
            {
                drainMidiArrivals (chaseEach);
                return;
            }
            from = (int) std::max<juce::int64> (0, startAt - here);
        }
        captureStartRequested = false;
        take.setStartedAt (here + from);
        eachCompanion ([&] (field::MidiCapture& companion) { companion.setStartedAt (here + from); });
        midiTakeClock = -from;
        midiFloor = std::numeric_limits<juce::int64>::min();
        midiLastAt = 0;
        midiArrivalsLost = 0; // lost before the take began
        chasePending = true;
        captureStarted = true;
    }
    if (! captureStarted.load())
    {
        drainMidiArrivals (chaseEach);
        return;
    }
    const juce::int64 untilFrames = midiUntilFrames (take);
    const juce::int64 blockStart = stampMidiBlock (
        untilFrames, n, blockStartMs,
        [&] (juce::int64 at, const juce::uint8* bytes, int size)
        {
            take.push (at, bytes, size);
            eachCompanion ([&] (field::MidiCapture& companion) { companion.push (at, bytes, size); });
        },
        [&] (juce::int64 frames, int lost)
        {
            take.setFrames (frames);
            eachCompanion ([&] (field::MidiCapture& companion) { companion.setFrames (frames); });
            if (lost > 0)
            {
                take.addDropped (lost);
                eachCompanion ([&] (field::MidiCapture& companion) { companion.addDropped (lost); });
            }
        });
    // The take ends at the first block that begins at or past `until`,
    // not the block `until` falls inside: a message is drained at the
    // start of the block after it arrives, so only then has every
    // message before `until` been stamped.
    if (blockStart < untilFrames)
        return;
    activeMidiCapture = nullptr;
    for (int c = 0; c < live; ++c)
        companions[(size_t) c].midiTake = nullptr;
    captureStarted = false;
    capturesEnded.fetch_add (1);
}

juce::int64 Player::midiUntilFrames (const field::Transaction& take) const
{
    // `until` and the start are on the bed's timeline, in the bed's
    // samples, and the take's clock counts the device's, so the span
    // between them changes rate when the two differ, as a 44.1 kHz song
    // on a 48 kHz device does.
    const double rate = currentDeviceRate();
    const double bedRate = take.timelineRate() > 0.0 ? take.timelineRate() : rate;
    const juce::int64 untilAt = captureUntil.load();
    return untilAt >= 0 ? std::llround ((double) (untilAt - take.startedAt()) * rate / bedRate)
                        : std::numeric_limits<juce::int64>::max();
}

template <typename Push, typename Frames>
juce::int64 Player::stampMidiBlock (juce::int64 untilFrames, int n, double blockStartMs, Push&& push, Frames&& frames)
{
    // The take's clock counts the device's samples from its start, as an
    // audio take's frames do, so `at` stays in sample_rate's units and
    // runs on through a bed that wraps.
    const juce::int64 blockStart = midiTakeClock;
    const juce::int64 blockEnd = blockStart + n;
    const double rate = currentDeviceRate();
    const int lost = midiArrivalsLost.exchange (0);
    drainMidiArrivals ([&] (const MidiArrival& arrival)
    {
        auto at = blockStart + (juce::int64) std::llround ((arrival.ms - blockStartMs) * rate / 1000.0);
        // Drained here, a message arrived after the previous block's
        // drain: a block that runs late (the null clock catches up on a
        // stall by running blocks back to back) cannot place it further
        // back than that block's start.
        at = std::clamp (at, midiFloor, blockEnd - 1);
        if (at < 0)
        {
            chaseArrival (arrival); // before the start
            return;
        }
        if (chasePending)
            writeChase (push);
        // After this take's chased lines, so they never repeat a change it
        // records: the next take on this arm starts from every change, kept
        // or past `until`, as one after the take ends would be.
        chaseArrival (arrival);
        at = std::max (at, midiLastAt);
        if (at >= untilFrames)
            return;
        push (at, arrival.bytes, arrival.size);
        midiLastAt = at;
    });
    if (chasePending)
        writeChase (push);
    frames (std::max<juce::int64> (0, std::min (blockEnd, untilFrames)), lost);
    midiFloor = blockStart;
    midiTakeClock = blockEnd;
    return blockStart;
}

void Player::takeChaseSeeds()
{
    if (! chaseSeeded.load())
        return;
    const juce::SpinLock::ScopedTryLockType lock (chaseSeedLock);
    if (! lock.isLocked())
        return; // an arm is writing them: the next block takes them
    chase.fill ({});
    chaseNext = 1;
    for (int i = 0; i < chaseSeedCount; ++i)
    {
        const auto& seed = chaseSeeds[(size_t) i];
        chase[(size_t) (seed.channel * chasedControllers + seed.cc)] = { chaseNext++, (juce::uint8) seed.value };
    }
    chaseSeeded = false;
}

void Player::chaseArrival (const MidiArrival& arrival)
{
    // A control change, and not a channel mode message (120 to 127),
    // which acts once rather than setting a value to start from.
    if (arrival.size != 3 || (arrival.bytes[0] & 0xf0) != 0xb0 || arrival.bytes[1] >= chasedControllers)
        return;
    const int channel = arrival.bytes[0] & 0x0f;
    chase[(size_t) (channel * chasedControllers + arrival.bytes[1])] = { chaseNext++, arrival.bytes[2] };
}

template <typename Push>
void Player::writeChase (Push&& push)
{
    chasePending = false;
    int count = 0;
    for (int slot = 0; slot < chaseSlots; ++slot)
        if (chase[(size_t) slot].order != 0)
            chaseSorted[(size_t) count++] = slot;
    std::sort (chaseSorted.begin(), chaseSorted.begin() + count,
               [this] (int a, int b) { return chase[(size_t) a].order < chase[(size_t) b].order; });
    for (int i = 0; i < count; ++i)
    {
        const int slot = chaseSorted[(size_t) i];
        const juce::uint8 bytes[3] { (juce::uint8) (0xb0 | (slot / chasedControllers)), (juce::uint8) (slot % chasedControllers),
                                     chase[(size_t) slot].value };
        push (0, bytes, 3);
    }
}

void Player::recordMidiCompanions (int n, double blockStartMs)
{
    const int live = liveCompanions.load();
    field::MidiCapture* first = nullptr;
    for (int c = 0; c < live && first == nullptr; ++c)
        first = companions[(size_t) c].midiTake.load();
    if (first == nullptr)
    {
        // A stop detached them, so what arrived belongs to no take, and
        // only the chase keeps it.
        companionMidiRunning = false;
        drainMidiArrivals ([this] (const MidiArrival& arrival) { chaseArrival (arrival); });
        return;
    }
    const auto eachCompanion = [&] (auto&& use)
    {
        for (int c = 0; c < live; ++c)
            if (auto* companion = companions[(size_t) c].midiTake.load())
                use (*companion);
    };
    const juce::int64 untilFrames = midiUntilFrames (*first);
    const juce::int64 blockStart = stampMidiBlock (
        untilFrames, n, blockStartMs,
        [&] (juce::int64 at, const juce::uint8* bytes, int size)
        { eachCompanion ([&] (field::MidiCapture& companion) { companion.push (at, bytes, size); }); },
        [&] (juce::int64 frames, int lost)
        {
            eachCompanion ([&] (field::MidiCapture& companion)
            {
                companion.setFrames (frames);
                if (lost > 0)
                    companion.addDropped (lost);
            });
        });
    // A block after the audio, as recordMidiBlock ends a MIDI take.
    if (blockStart < untilFrames)
        return;
    for (int c = 0; c < live; ++c)
        companions[(size_t) c].midiTake = nullptr;
    companionMidiRunning = false;
    // The pass is done once the audio has ended too.
    if (activeCapture.load() == nullptr)
        capturesEnded.fetch_add (1);
}

void Player::handleIncomingMidiMessage (juce::MidiInput*, const juce::MidiMessage& message)
{
    // Read here rather than taken from the message: JUCE's ALSA input
    // stamps with the 32-bit millisecond counter, not the clock the
    // callback reads.
    const double arrivalMs = juce::Time::getMillisecondCounterHiRes();
    // A take records channel messages — notes, controllers, pressure,
    // program changes, bends. System messages describe the sender, not
    // the performance: SysEx would not fit a fixed-size record, and the
    // clock and active sensing some controllers send many times a second
    // would bury the notes.
    const int size = message.getRawDataSize();
    const auto* raw = message.getRawData();
    if (size < 1 || size > field::MidiCapture::maxMessageBytes || raw[0] < 0x80 || raw[0] >= 0xf0)
        return;
    const juce::SpinLock::ScopedLockType lock (midiArrivalWrite);
    int start1, size1, start2, size2;
    midiArrivals.prepareToWrite (1, start1, size1, start2, size2);
    if (size1 + size2 == 0)
    {
        midiArrivalsLost.fetch_add (1);
        return;
    }
    auto& arrival = midiArrivalRing[(size_t) (size1 > 0 ? start1 : start2)];
    arrival.ms = arrivalMs;
    arrival.size = size;
    std::memcpy (arrival.bytes, raw, (size_t) size);
    midiArrivals.finishedWrite (1);
}

void Player::audioDeviceIOCallbackWithContext (const float* const* inputChannelData,
                                               int numInputChannels,
                                               float* const* outputChannelData,
                                               int numOutputChannels,
                                               int numSamples,
                                               const juce::AudioIODeviceCallbackContext&)
{
    processBlock (inputChannelData, numInputChannels, outputChannelData, numOutputChannels, numSamples);
}

void Player::audioDeviceAboutToStart (juce::AudioIODevice* device)
{
    transport.prepareToPlay (device->getCurrentBufferSizeSamples(), device->getCurrentSampleRate());
    if ((int) silence.size() < device->getCurrentBufferSizeSamples())
        silence.assign ((size_t) device->getCurrentBufferSizeSamples(), 0.0f);
    // A device start is where a rate change becomes real (hot-plug,
    // default-follow, an explicit selection): rebuild the delivery
    // conversion against the rate the callback is about to run at.
    const juce::ScopedLock guard (liveLock);
    rebuildLiveConverter();
}

void Player::audioDeviceStopped()
{
    transport.releaseResources();
}

// ---- Recording (recording.md §5–6) ----------------------------------------

juce::var Player::arm (const juce::String& track, const juce::String& device, int input)
{
    auto entry = obj();
    entry->setProperty ("track", track);
    entry->setProperty ("kind", "audio");
    entry->setProperty ("input", input);
    return armSet ({ juce::var (entry.get()) }, device);
}

juce::var Player::armMidi (const juce::String& track, const std::vector<ChaseSeed>& seeds)
{
    auto entry = obj();
    entry->setProperty ("track", track);
    entry->setProperty ("kind", "midi");
    return armSet ({ juce::var (entry.get()) }, {}, seeds);
}

juce::var Player::armSet (const juce::Array<juce::var>& tracks, const juce::String& device,
                          const std::vector<ChaseSeed>& seeds, const void* owner)
{
    auto result = obj();
    auto fail = [&] (const juce::String& error)
    {
        result->setProperty ("error", error);
        return juce::var (result.get());
    };
    if (capture != nullptr)
        return fail ("cannot re-arm while recording (stop first)");
    if (tracks.isEmpty())
        return fail ("arm needs a track");
    if (tracks.size() > maxCompanions + 1)
        return fail ("at most " + juce::String (maxCompanions + 1) + " tracks can be armed at once");

    struct Entry
    {
        juce::String track;
        bool midi = false;
        int input = 0;
        juce::String monitor; // the capture input's name, when monitored
    };
    std::vector<Entry> audio, midi;
    juce::StringArray named, monitored;
    juce::Array<int> inputs;
    for (const auto& item : tracks)
    {
        Entry entry;
        entry.track = item.getProperty ("track", juce::var()).toString();
        const auto kind = item.getProperty ("kind", "audio").toString();
        if (entry.track.isEmpty())
            return fail ("each armed track needs a track");
        if (named.contains (entry.track))
            return fail (entry.track + " is armed twice");
        named.add (entry.track);
        entry.monitor = item.getProperty ("monitor", juce::var()).toString();
        if (entry.monitor.isNotEmpty())
        {
            if (kind == "midi")
                return fail (entry.track + " records MIDI, which has no input to monitor");
            if (monitored.contains (entry.monitor))
                return fail ("two tracks are monitored as \"" + entry.monitor + "\"");
            monitored.add (entry.monitor);
            std::lock_guard<std::mutex> hold (inputsLock);
            if (rings.count (entry.monitor.toStdString()) > 0)
                return fail ("input \"" + entry.monitor + "\" is already open");
        }
        if (kind == "midi")
        {
            entry.midi = true;
            midi.push_back (entry);
            continue;
        }
        if (kind != "audio")
            return fail ("arm's kind is \"midi\", or absent for an audio input");
        const auto input = item.getProperty ("input", juce::var (1));
        if (! input.isInt() && ! input.isInt64() && ! input.isDouble())
            return fail ("arm needs an input channel number");
        entry.input = (int) input;
        if (entry.input < 1)
            return fail ("input channels count from 1");
        if (inputs.contains (entry.input))
            return fail ("input " + juce::String (entry.input) + " is armed for two tracks");
        inputs.add (entry.input);
        audio.push_back (entry);
    }
    inputs.sort();

    // Open what the set listens to, MIDI first: its sources open without
    // starting, so a MIDI refusal returns before the device changes, and
    // an audio failure, which puts the device back as it was, drops only
    // those unstarted inputs. A bad arm leaves playback, and the arm
    // before it, alone.
    std::vector<std::unique_ptr<juce::MidiInput>> opened;
    juce::StringArray sources;
    if (! midi.empty())
    {
        // A take records what you play, not the parts the daemon's own
        // outputs play beside it (sequencer.md §2.5).
        auto available = juce::MidiInput::getAvailableDevices();
        if (! captureOwnOutputs)
            available.removeIf ([this] (const juce::MidiDeviceInfo& source) { return midiOutputs.publishes (source.identifier); });
        if (available.isEmpty())
            return fail ("no MIDI sources to record from: start field keys or connect a controller first");
        for (const auto& source : available)
            if (auto input = juce::MidiInput::openDevice (source.identifier, this))
            {
                opened.push_back (std::move (input));
                sources.add (source.name);
            }
        if (opened.empty())
        {
            juce::StringArray listed;
            for (const auto& source : available)
                listed.add (source.name);
            return fail ("cannot open any MIDI source: " + listed.joinIntoString (", "));
        }
    }
    juce::String name = device;
    int channels = 0, inputLatency = 0, outputLatency = 0;
    if (! audio.empty())
    {
        if (auto error = openAudioInputs (device, inputs, name, channels, inputLatency, outputLatency); error.isNotEmpty())
            return fail (error);
    }
    else if (! nullMode)
    {
        if (auto* current = deviceManager.getCurrentAudioDevice())
            outputLatency = current->getOutputLatencyInSamples();
    }

    // The set replaces the arm before it: what it no longer needs closes
    // now that what it does need has opened. The companions stop being
    // read only once nothing can fail, so a refused close keeps them.
    const bool hadAudio = armed.load() && ! armedInputs.isEmpty();
    if (audio.empty() && hadAudio)
        if (auto error = closeAudioInput(); error.isNotEmpty())
            return fail (error);
    liveCompanions = 0;
    closeMidiInputs();
    if (! midi.empty())
    {
        midiInputs = std::move (opened);
        midiSources = sources;
        for (auto& input : midiInputs)
            input->start();
    }
    armedInputs = audio.empty() ? juce::Array<int>() : inputs;
    if (nullMode)
    {
        int mask = 0;
        for (const auto input : armedInputs)
            mask |= 1 << (input - 1);
        nullInputMask = mask;
    }

    // An audio track is the primary whenever one is armed, so a punch-out
    // cuts the audio exactly; MIDI companions take their block after it.
    std::vector<Entry> ordered (audio);
    ordered.insert (ordered.end(), midi.begin(), midi.end());
    const auto& primary = ordered.front();
    armedTrack = primary.track;
    armedDevice = primary.midi ? juce::String() : name;
    armedInput = primary.input;
    captureChannel = primary.midi ? 0 : channelIndex (primary.input);
    companionCount = (int) ordered.size() - 1;
    for (int c = 0; c < companionCount; ++c)
    {
        const auto& entry = ordered[(size_t) c + 1];
        auto& companion = companions[(size_t) c];
        companion.track = entry.track;
        companion.input = entry.input;
        companion.take.reset();
        companion.audio = nullptr;
        companion.midiTake = nullptr;
        companion.peak = 0.0f;
        companion.midi = entry.midi;
        companion.channel = entry.midi ? 0 : channelIndex (entry.input);
    }
    liveCompanions = companionCount;
    // The monitored inputs, replacing the arm before it's: each reads its
    // channel of the block the callback presents.
    closeCaptures();
    {
        std::lock_guard<std::mutex> hold (inputsLock);
        for (const auto& entry : audio)
            if (entry.monitor.isNotEmpty())
                captures[entry.monitor.toStdString()] = {
                    std::make_shared<field::CaptureInput> (captureBlock, channelIndex (entry.input)), owner
                };
    }
    inputPeak = 0.0f;
    freeClock = 0;
    // Each arm starts the chase over, from its own seeds.
    {
        const juce::SpinLock::ScopedLockType lock (chaseSeedLock);
        chaseSeedCount = (int) std::min (seeds.size(), chaseSeeds.size());
        std::copy_n (seeds.begin(), chaseSeedCount, chaseSeeds.begin());
        chaseSeeded = true;
    }
    // The kind before the flag, so the null clock never presents an input
    // to a MIDI arm.
    armedMidi = primary.midi;
    armed = true;

    juce::Array<juce::var> armedList;
    for (const auto& entry : ordered)
    {
        auto item = obj();
        item->setProperty ("track", entry.track);
        item->setProperty ("kind", entry.midi ? "midi" : "audio");
        if (! entry.midi)
            item->setProperty ("input", entry.input);
        if (entry.monitor.isNotEmpty())
            item->setProperty ("monitor", entry.monitor);
        armedList.add (juce::var (item.get()));
    }
    result->setProperty ("armed", armedList);
    if (! audio.empty())
    {
        result->setProperty ("device", name);
        result->setProperty ("input", primary.midi ? juce::var() : juce::var (primary.input));
        result->setProperty ("channels", channels);
        result->setProperty ("input_latency", inputLatency);
    }
    if (! midi.empty())
    {
        if (ordered.size() == 1)
            result->setProperty ("kind", "midi");
        juce::Array<juce::var> sourceList;
        for (const auto& source : midiSources)
            sourceList.add (source);
        result->setProperty ("sources", sourceList);
    }
    result->setProperty ("sample_rate", currentDeviceRate());
    result->setProperty ("output_latency", outputLatency);
    return juce::var (result.get());
}

int Player::channelIndex (int input) const
{
    // The callback's array holds only the active channels, in order.
    return juce::jmax (0, armedInputs.indexOf (input));
}

juce::String Player::openAudioInputs (const juce::String& device, const juce::Array<int>& inputs, juce::String& name,
                                      int& channels, int& inputLatency, int& outputLatency)
{
    if (nullMode)
    {
        if (device.isNotEmpty() && device != "null")
            return "no devices in null-output mode";
        channels = 2;
        for (const auto input : inputs)
            if (input > channels)
                return "the null input has 2 channels";
        name = "null";
        return {};
    }
    auto* type = deviceManager.getCurrentDeviceTypeObject();
    if (type == nullptr)
        return "no audio device type";
    type->scanForDevices();
    auto names = type->getDeviceNames (true);
    if (names.isEmpty())
        return "no input devices";
    if (name.isEmpty())
        name = names[juce::jmax (0, type->getDefaultDeviceIndex (true))];
    if (! names.contains (name))
        return "unknown input device: " + name;

    // The duplex open (recording.md §5): the same device manager, now
    // with the armed input channels active. Playback-only sessions never
    // reach here, which is what keeps the microphone prompt for the first
    // arm rather than the first play.
    const auto previous = deviceManager.getAudioDeviceSetup();
    auto setup = previous;
    setup.inputDeviceName = name;
    setup.useDefaultInputChannels = false;
    setup.inputChannels.clear();
    for (const auto input : inputs)
        setup.inputChannels.setBit (input - 1);
    if (auto error = deviceManager.setAudioDeviceSetup (setup, true); error.isNotEmpty())
    {
        deviceManager.setAudioDeviceSetup (previous, true);
        return error;
    }
    auto* opened = deviceManager.getCurrentAudioDevice();
    if (opened == nullptr)
    {
        deviceManager.setAudioDeviceSetup (previous, true);
        return "the device did not open with an input";
    }
    channels = opened->getInputChannelNames().size();
    // JUCE clears a channel bit the device does not have rather than
    // erroring, so the callback would simply arrive without that input.
    for (const auto input : inputs)
        if (input > channels || ! opened->getActiveInputChannels()[input - 1])
        {
            deviceManager.setAudioDeviceSetup (previous, true);
            return name + " has " + juce::String (channels) + " input channel" + (channels == 1 ? "" : "s")
                   + "; input " + juce::String (input) + " does not exist";
        }
    inputLatency = opened->getInputLatencyInSamples();
    outputLatency = opened->getOutputLatencyInSamples();
    return {};
}

juce::String Player::closeAudioInput()
{
    nullInputMask = 0;
    if (nullMode)
        return {};
    // Back to the output-only open playback has always had; the
    // microphone is released with it.
    auto setup = deviceManager.getAudioDeviceSetup();
    setup.inputDeviceName.clear();
    setup.inputChannels.clear();
    setup.useDefaultInputChannels = true;
    return deviceManager.setAudioDeviceSetup (setup, true);
}

void Player::closeMidiInputs()
{
    for (auto& input : midiInputs)
        input->stop();
    midiInputs.clear();
    midiSources.clear();
}

juce::String Player::disarm()
{
    if (capture != nullptr)
        return "cannot disarm while recording (stop first)";
    if (! armed.load())
        return {};
    armed = false;
    armedMidi = false;
    liveCompanions = 0;
    companionCount = 0;
    closeCaptures();
    closeMidiInputs();
    if (! armedInputs.isEmpty())
    {
        armedInputs.clear();
        if (auto error = closeAudioInput(); error.isNotEmpty())
            return error;
    }
    armedTrack.clear();
    armedDevice.clear();
    armedInput = 0;
    return {};
}

field::Transaction::Facts Player::takeFacts() const
{
    return takeFacts (armedTrack, armedInput);
}

field::Transaction::Facts Player::takeFacts (const juce::String& track, int input) const
{
    field::Transaction::Facts facts;
    facts.track = track;
    facts.device = input > 0 ? armedDevice : juce::String();
    facts.input = input;
    facts.sources = midiSources;
    // The take is at the device's rate — the bytes are what the
    // converter produced (recording.md §3) — while started_at_samples is
    // on the bed's timeline, so both rates are recorded.
    facts.sampleRate = currentDeviceRate();
    facts.timelineRate = liveSession != nullptr ? (double) liveRate : fileSampleRate;
    facts.song = liveSession != nullptr ? liveSong : juce::String();
    facts.source = liveSession == nullptr ? loadedPath : juce::String();
    if (! nullMode)
        if (auto* device = deviceManager.getCurrentAudioDevice())
        {
            facts.inputLatency = device->getInputLatencyInSamples();
            facts.outputLatency = device->getOutputLatencyInSamples();
        }
    facts.daemonVersion = field::daemonVersion;
    return facts;
}

std::unique_ptr<field::Capture> Player::openCapture()
{
    return std::make_unique<field::Capture> (juce::File::getCurrentWorkingDirectory(), takeFacts());
}

juce::var Player::record (const juce::var& at, const juce::var& start, const juce::var& until, bool loop)
{
    auto result = obj();
    auto fail = [&] (const juce::String& error)
    {
        result->setProperty ("error", error);
        return juce::var (result.get());
    };
    if (! armed.load())
        return fail ("not armed (arm an input first)");
    if (capture != nullptr)
        return fail ("already recording");
    if (loop && armedMidi.load())
        return fail ("loop takes record audio only");
    if (loop && companionCount > 0)
        return fail ("a loop take records one track; arm only the track to loop");

    const bool bed = liveSession != nullptr || readerSource != nullptr;
    const bool preRoll = ! start.isVoid();
    const bool punchOut = ! until.isVoid();
    if (punchOut)
    {
        if (at.isVoid())
            return fail ("record with until needs at — where the take begins");
        if (! until.isInt() && ! until.isInt64() && ! until.isDouble())
            return fail ("record needs a sample number for until");
        if ((juce::int64) until <= (juce::int64) at)
            return fail ("until must be after at");
    }
    if (loop)
    {
        if (! punchOut)
            return fail ("a loop take needs until — the region is [at, until)");
        if (liveSession == nullptr)
            return fail ("loop takes need a live session (field play <song>); a file bed loops only whole");
        // The region is the take's definition: the session loops it and
        // every wrap ends one pass and begins the next.
        {
            const juce::ScopedLock guard (liveLock);
            try
            {
                liveSession->setLoopRegion ((juce::int64) at, (juce::int64) until);
            }
            catch (const std::exception& e)
            {
                return fail (e.what());
            }
        }
    }
    if (preRoll)
    {
        if (at.isVoid())
            return fail ("record with start needs at — the position the take begins");
        if (! start.isInt() && ! start.isInt64() && ! start.isDouble())
            return fail ("record needs a sample number for start");
        if ((juce::int64) start > (juce::int64) at)
            return fail ("start must not be after at");
    }
    if (! at.isVoid())
    {
        if (! bed)
            return fail ("nothing loaded to record against; omit `at` for a free-running take");
        if (! at.isInt() && ! at.isInt64() && ! at.isDouble())
            return fail ("record needs a sample number for at");
    }
    // What a refused jump or play, or a failed open, leaves behind: no
    // take, no standby, nothing the callback could reach, and nothing on
    // disk, because a transaction left unfinalized stays there for
    // `recordings` to offer back as a take that never was.
    auto abandon = [&]
    {
        activeCapture = nullptr;
        activeMidiCapture = nullptr;
        standbyCapture = nullptr;
        captureStartRequested = false;
        captureLoop = false; // or every later stop would end a loop that never ran
        // The region was the refused take's, as stop clears it.
        if (loop && liveSession != nullptr)
        {
            const juce::ScopedLock guard (liveLock);
            liveSession->setLoopRegion (0, 0);
            liveLoop = liveSession->looping();
        }
        for (int c = 0; c < companionCount; ++c)
        {
            companions[(size_t) c].audio = nullptr;
            companions[(size_t) c].midiTake = nullptr;
        }
        if (capture != nullptr)
            capture->discard();
        if (standby != nullptr)
            standby->discard();
        capture.reset();
        standby.reset();
        for (int c = 0; c < companionCount; ++c)
            if (auto& take = companions[(size_t) c].take; take != nullptr)
            {
                take->discard();
                take.reset();
            }
    };
    field::Capture* audioTake = nullptr;
    field::MidiCapture* midiTake = nullptr;
    try
    {
        if (armedMidi.load())
        {
            auto take = std::make_unique<field::MidiCapture> (juce::File::getCurrentWorkingDirectory(), takeFacts());
            midiTake = take.get();
            capture = std::move (take);
        }
        else
        {
            auto take = openCapture();
            audioTake = take.get();
            capture = std::move (take);
        }
        // The next pass's transaction is opened now, so the wrap finds
        // it ready; serviceCapture opens each one after that.
        if (loop)
            standby = openCapture();
        // Each companion's take, on its own track (arming.md §2.2). The
        // callback reaches them only from the primary's latch.
        for (int c = 0; c < companionCount; ++c)
        {
            auto& companion = companions[(size_t) c];
            const auto root = juce::File::getCurrentWorkingDirectory();
            if (companion.midi.load())
            {
                auto take = std::make_unique<field::MidiCapture> (root, takeFacts (companion.track, 0));
                companion.midiTake = take.get();
                companion.take = std::move (take);
            }
            else
            {
                auto take = std::make_unique<field::Capture> (root, takeFacts (companion.track, companion.input));
                companion.audio = take.get();
                companion.take = std::move (take);
            }
        }
    }
    catch (const std::exception& e)
    {
        abandon();
        return fail (e.what());
    }
    if (openStallMs > 0)
        std::this_thread::sleep_for (std::chrono::milliseconds (openStallMs));

    {
        // The jump to `at` and the latch that waits for it, in one hold of
        // the lock the callback only tries, so no block runs between them.
        // On a bed already rolling, a block between them would carry the
        // transport past `at`, and the take would start late. The
        // transactions open before, because opening them can take longer
        // than a block.
        const juce::ScopedLock guard (liveLock);
        if (! at.isVoid())
            if (auto error = seek (preRoll ? (juce::int64) start : (juce::int64) at); error.isNotEmpty())
            {
                abandon();
                return fail (error);
            }
        captureStarted = false;
        capturesEnded = 0;
        captureMissed = 0;
        loopTakes = 0;
        // An `at` is where the take begins, exactly: the callback latches
        // on that sample whether the transport pre-rolls to it, starts on
        // it (the request is armed before play, so the first rolling block
        // is the one), or is already rolling toward it. Without one, the
        // next block, wherever it falls.
        captureStartAt = at.isVoid() ? -1 : (juce::int64) at;
        captureUntil = punchOut ? (juce::int64) until : -1;
        captureLoop = loop;
        companionMidiRunning = false;
        standbyCapture = standby.get();
        activeCapture = audioTake;
        activeMidiCapture = midiTake;
        captureStartRequested = true;
    }
    if (bed && transportState() != "playing")
        if (auto error = play(); error.isNotEmpty())
        {
            abandon();
            return fail (error);
        }
    // Wait for the callback to latch the start — a block or two, unless
    // the device is not running, in which case the response reports -1
    // and the manifest fills in when it does. A pre-rolled take is
    // waiting for its position by design, so no wait: -1 now, and status
    // says pending until the callback gets there.
    for (int i = 0; ! preRoll && i < 300 && ! captureStarted.load(); ++i)
        std::this_thread::sleep_for (std::chrono::milliseconds (1));

    result->setProperty ("transaction", capture->id());
    result->setProperty ("file", capture->file());
    result->setProperty ("started_at_samples", capture->startedAt());
    // Every armed track's take, the primary's first.
    juce::Array<juce::var> takes;
    const auto describe = [&] (const juce::String& track, const field::Transaction& take)
    {
        auto item = obj();
        item->setProperty ("track", track);
        item->setProperty ("transaction", take.id());
        item->setProperty ("file", take.file());
        takes.add (juce::var (item.get()));
    };
    describe (armedTrack, *capture);
    for (int c = 0; c < companionCount; ++c)
        describe (companions[(size_t) c].track, *companions[(size_t) c].take);
    result->setProperty ("takes", takes);
    return juce::var (result.get());
}

juce::Array<juce::var> Player::stopRecording()
{
    // A pass the callback already ended is finalized on its own terms
    // first, so its manifests reach onTake before the stop's.
    serviceCapture();
    // A loop is stopped even with no take open, as when opening its next
    // one failed: the callback would otherwise go on skipping passes.
    const bool wasLoop = captureLoop.load();
    if (capture == nullptr && ! wasLoop)
        return {};
    // A MIDI message is drained in the block after it arrives, so that
    // block must finish before the detach for every message that arrived
    // before this stop to be in the take. The epoch advances before a
    // block drains MIDI, so one epoch is not enough: a detach between that
    // block's count and its drain would skip it. The second epoch's block
    // begins only after the first has returned.
    bool midi = activeMidiCapture.load() != nullptr;
    for (int c = 0; c < companionCount; ++c)
        midi = midi || companions[(size_t) c].midiTake.load() != nullptr;
    if (midi)
        waitOutBlocks();
    // Detach first, then wait out the callback: the block that read
    // activeCapture before the store may still be pushing, and the epoch
    // counter advances only after a block's push is done. Two epochs
    // covers that block and one more; the timeout covers a device that
    // is not running at all, where nothing can be pushing.
    activeCapture = nullptr;
    activeMidiCapture = nullptr;
    standbyCapture = nullptr;
    for (int c = 0; c < companionCount; ++c)
    {
        companions[(size_t) c].audio = nullptr;
        companions[(size_t) c].midiTake = nullptr;
    }
    captureStartRequested = false;
    captureStartAt = -1;
    captureUntil = -1;
    captureLoop = false;
    waitOutBlocks();
    // Under a loop, the block in flight at those stores can have taken
    // the standby over just before them and stored activeCapture just
    // after. No later block takes one over, so a second detach and wait
    // leave nothing pushing.
    if (wasLoop && activeCapture.exchange (nullptr) != nullptr)
        waitOutBlocks();
    captureStarted = false;
    capturesEnded = 0;
    companionMidiRunning = false;

    juce::Array<juce::var> manifests;
    if (capture != nullptr)
    {
        // A take that never took a sample is not one when it is a loop's
        // next pass, still waiting for its wrap, as an unused standby is
        // not. The loop's first take, which is `capture` until it is
        // finalized and so while loopTakes is 0, is a take however soon
        // the stop came, as any other take a stop ends is.
        if (wasLoop && loopTakes > 0 && capture->startedAt() < 0)
            capture->discard();
        else
            manifests.add (finalizeTake (*capture));
        capture.reset();
    }
    for (int c = 0; c < companionCount; ++c)
        if (auto& take = companions[(size_t) c].take; take != nullptr)
        {
            manifests.add (finalizeTake (*take));
            take.reset();
        }
    // A standby is a take only when a wrap just before the stop began
    // its pass; one the callback never reached is not.
    if (standby != nullptr)
    {
        if (standby->startedAt() >= 0)
            manifests.add (finalizeTake (*standby));
        else
            standby->discard();
        standby.reset();
    }
    if (wasLoop && liveSession != nullptr)
    {
        // The region was the take's; the session stops looping it. A swap
        // during the take installed the session looping, so the copy
        // converted delivery reads follows it back.
        const juce::ScopedLock guard (liveLock);
        liveSession->setLoopRegion (0, 0);
        liveLoop = liveSession->looping();
    }
    loopTakes = 0;
    announceTakes (manifests);
    // Default-follow waited for the take (refreshAudioDevice); catch up.
    refreshAudioDevice();
    return manifests;
}

juce::var Player::finalizeTake (field::Transaction& take)
{
    try
    {
        return take.finalize();
    }
    catch (const std::exception& e)
    {
        auto o = obj();
        o->setProperty ("error", juce::String (e.what()));
        return juce::var (o.get());
    }
}

void Player::announceTakes (const juce::Array<juce::var>& manifests)
{
    if (onTake)
        for (const auto& manifest : manifests)
            if (manifest.isObject() && ! manifest.hasProperty ("error"))
                onTake (manifest);
}

void Player::serviceCapture()
{
    // The callback ended `capture` at its until and, under a loop, may
    // have ended the standby it took over at that wrap too; the message
    // thread owns the pointers, so the hand-over of ownership happens
    // here, after the fact. The count says how many ended, and they
    // ended in the order they were opened, so each moves the next take
    // up into `capture`: recording, ended, or under a loop, waiting for
    // the wrap that begins it.
    std::vector<std::unique_ptr<field::Transaction>> ended;
    for (int count = capturesEnded.exchange (0); count > 0 && capture != nullptr; --count)
    {
        ended.push_back (std::move (capture));
        capture = std::move (standby);
    }
    const bool loop = captureLoop.load();
    // Under a loop, the next pass's take opens before the last one
    // finalizes, so a slow finalize does not cost a pass. One take waits
    // in the slot at a time: an empty slot means the callback took the
    // last one over, or none could be opened.
    if (loop && standby == nullptr && standbyCapture.load() == nullptr)
    {
        try
        {
            auto next = openCapture();
            standbyCapture = next.get();
            // With no take left, the callback is skipping a pass, and this
            // one begins at its end.
            if (capture == nullptr)
                capture = std::move (next);
            else
                standby = std::move (next);
        }
        catch (const std::exception&)
        {
            // The passes go on being skipped and counted; the next
            // heartbeat tries again.
        }
    }
    if (ended.empty())
        return;
    if (serviceStallMs > 0)
        std::this_thread::sleep_for (std::chrono::milliseconds (serviceStallMs));
    juce::Array<juce::var> manifests;
    for (const auto& take : ended)
    {
        manifests.add (finalizeTake (*take));
        if (loop)
            ++loopTakes;
    }
    ended.clear();
    // The companions ended with the pass (arming.md §2.2); a loop has none.
    for (int c = 0; c < companionCount; ++c)
        if (auto& take = companions[(size_t) c].take; take != nullptr)
        {
            manifests.add (finalizeTake (*take));
            take.reset();
        }
    if (! loop)
    {
        captureStartAt = -1;
        captureUntil = -1;
        captureStarted = false;
    }
    announceTakes (manifests);
}

juce::String Player::carryTakeRegion (field::LiveSession& session) const
{
    // Outside a loop take, the incoming session starts with no region.
    if (! captureLoop.load())
    {
        session.setLoopRegion (0, 0);
        return {};
    }
    try
    {
        session.setLoopRegion (captureStartAt.load(), captureUntil.load());
    }
    catch (const std::exception& e)
    {
        return "a loop take is recording, and its region does not fit this session (stop first): "
               + juce::String (e.what());
    }
    return {};
}

juce::String Player::setLoopRegion (juce::int64 from, juce::int64 to)
{
    if (liveSession == nullptr)
        return "a loop region needs a live session (field play <song>)";
    if (capture != nullptr)
        return "cannot change the loop while recording (stop first)";
    const juce::ScopedLock guard (liveLock);
    try
    {
        // A region open at the end runs to the content's extent.
        liveSession->setLoopRegion (from, to < 0 ? liveSession->extentSamples() : to);
    }
    catch (const std::exception& e)
    {
        return e.what();
    }
    return {};
}

juce::String Player::recordState() const
{
    if (capture != nullptr)
        return "recording";
    return armed.load() ? "armed" : "idle";
}

juce::var Player::recordings() const
{
    juce::StringArray active;
    if (capture != nullptr)
        active.add (capture->id());
    for (int c = 0; c < companionCount; ++c)
        if (const auto& take = companions[(size_t) c].take; take != nullptr)
            active.add (take->id());
    return field::Transaction::list (juce::File::getCurrentWorkingDirectory(), active);
}

juce::var Player::recover (const juce::String& id) const
{
    auto result = obj();
    bool active = capture != nullptr && capture->id() == id;
    for (int c = 0; c < companionCount; ++c)
        if (const auto& take = companions[(size_t) c].take; take != nullptr)
            active = active || take->id() == id;
    if (active)
    {
        result->setProperty ("error", id + " is still being recorded");
        return juce::var (result.get());
    }
    try
    {
        return field::Transaction::recover (juce::File::getCurrentWorkingDirectory(), id);
    }
    catch (const std::exception& e)
    {
        result->setProperty ("error", juce::String (e.what()));
        return juce::var (result.get());
    }
}

juce::String Player::setClick (const juce::var& schedule)
{
    try
    {
        click.setSchedule (schedule);
    }
    catch (const std::exception& e)
    {
        return e.what();
    }
    return {};
}

void Player::waitOutBlocks() const
{
    // Two epochs: the block in flight when the caller let go of something
    // may already have counted one.
    const auto epoch = callbackEpoch.load();
    for (int i = 0; i < 300 && callbackEpoch.load() < epoch + 2; ++i)
        std::this_thread::sleep_for (std::chrono::milliseconds (1));
}

// ---- MIDI outputs (sequencer.md §2.5) ---------------------------------------

juce::var Player::openMidiOutput (const juce::var& request, const void* owner)
{
    midiSender.start();
    return midiOutputs.open (request, owner, [this] (const juce::String& name) -> std::shared_ptr<field::LiveInput>
    {
        std::lock_guard<std::mutex> hold (inputsLock);
        if (const auto ring = rings.find (name.toStdString()); ring != rings.end())
            return ring->second.ring;
        if (const auto monitored = captures.find (name.toStdString()); monitored != captures.end())
            return monitored->second.input;
        return nullptr;
    });
}

juce::String Player::closeMidiOutput (const juce::String& name) { return midiOutputs.close (name); }

void Player::closeMidiOutputsOwnedBy (const void* owner) { midiOutputs.closeOwnedBy (owner); }

void Player::closeMidiOutputs() { midiOutputs.closeAll(); }
