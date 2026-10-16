#include "player.h"
#include "capture.h"
#include "capture_input.h"
#include "hosting.h"
#include "keys.h"
#include "live.h"
#include "midi_out.h"
#include "render.h"
#include "ring_input.h"
#include "server.h"

#include <juce_events/juce_events.h>

#include <csignal>
#include <optional>

// field-audiod: the playback daemon (playback.md). Spawned on demand by the
// CLI with its working directory at the project root, serves the NDJSON
// control socket at .field/audiod.sock, and exits on its own after an idle
// timeout — daemon-lite (§3.1). Artifacts only: it plays files the build
// produced and has no idea what a clip or a bar is.

namespace
{
juce::String jsonEvent (const juce::String& name,
                        const std::function<void (juce::DynamicObject&)>& fill)
{
    juce::DynamicObject::Ptr o = new juce::DynamicObject();
    o->setProperty ("event", name);
    fill (*o);
    return juce::JSON::toString (juce::var (o.get()), true) + "\n";
}

// Runs on the message thread: emits state transitions and position events,
// turns natural end-of-stream into a stop, and asks the daemon to exit
// when idle.
class Heartbeat : public juce::Timer
{
public:
    Heartbeat (Player& p, Server& s, int idleSeconds)
        : player (p), server (s), idleMs ((juce::int64) idleSeconds * 1000)
    {
        lastKnownState = player.transportState();
        lastKnownRecord = player.recordState();
        // Baseline the device too, or the first tick broadcasts the
        // spawn-time output as a phantom "moved" event (#16 review).
        lastKnownDevice = player.status()
                              .getProperty ("device", juce::var())
                              .getProperty ("name", juce::var())
                              .toString();
        startTimer (250);
    }

    std::atomic<bool> wantExit { false };

    void timerCallback() override
    {
        server.sweepClosedConnections();

        // Where Core Audio's property listeners do not exist, the only way
        // to notice a device arriving or vanishing is to look. Once a
        // second rather than every tick: a rescan enumerates the whole
        // device list, which is far too expensive at 250 ms and buys
        // nothing, because hot-plug is a human-timescale event. The
        // rescan lands before status() below, so a change still reaches
        // the socket on the same tick it is noticed.
        if constexpr (! Player::hardwareListenersAvailable)
        {
            if (++ticksSinceRescan >= 4)
            {
                ticksSinceRescan = 0;
                player.refreshAudioDevice();
            }
        }

        if (player.streamFinished())
            player.stop();
        // A take the callback ended at its until (recording.md §10.4)
        // finalizes here, on the message thread, and a loop opens its
        // next standby.
        player.serviceCapture();
        player.serviceMidiOutputs();

        auto status = player.status();

        auto state = player.transportState();
        if (state != lastKnownState)
        {
            lastKnownState = state;
            server.broadcast (jsonEvent ("state", [&] (juce::DynamicObject& o)
                                         { o.setProperty ("state", state); }));
        }

        // The input side's state (recording.md §6): idle, armed,
        // recording — a `field record` blocking on the take and a
        // `field transport status` from elsewhere read the same thing.
        auto record = player.recordState();
        if (record != lastKnownRecord)
        {
            lastKnownRecord = record;
            server.broadcast (jsonEvent ("record", [&] (juce::DynamicObject& o)
                                         { o.setProperty ("state", record); }));
        }

        // The output can move underneath a client (default-follow, device
        // vanishing): say so on the socket.
        auto device = status.getProperty ("device", juce::var());
        auto deviceName = device.getProperty ("name", juce::var()).toString();
        if (deviceName != lastKnownDevice)
        {
            lastKnownDevice = deviceName;
            if (deviceName.isNotEmpty())
                server.broadcast (jsonEvent ("device", [&] (juce::DynamicObject& o)
                {
                    o.setProperty ("name", deviceName);
                    o.setProperty ("sample_rate", device.getProperty ("sample_rate", 0));
                }));
        }

        if (state == "playing")
        {
            auto sample = (juce::int64) status.getProperty ("sample", 0);
            server.broadcast (jsonEvent ("position", [&] (juce::DynamicObject& o)
                                         { o.setProperty ("sample", sample); }));
        }


        // Armed or recording pins the daemon open (recording.md §5): an
        // idle exit under a take would be the take dying to a timeout.
        auto idle = server.connectionCount() == 0 && state != "playing"
                    && ! player.recordingPinned()
                    && juce::Time::currentTimeMillis() - server.lastActivityMs() > idleMs;
        if (server.quitRequested || idle)
            wantExit = true;
    }

private:
    Player& player;
    Server& server;
    const juce::int64 idleMs;
    juce::String lastKnownState;
    juce::String lastKnownRecord;
    juce::String lastKnownDevice;
    int ticksSinceRescan = 0;
};
} // namespace

int main (int argc, char* argv[])
{
    juce::String socketPath = ".field/audiod.sock";
    juce::String renderPlan;
    juce::String renderLiveSession;
    juce::String renderLiveOut;
    juce::String renderLiveClick;
    std::vector<std::string> renderLiveInputs; // with --render-live: name=file.wav, each an input
    bool ringSelfTest = false;
    bool captureSelfTest = false;
    bool midiOutSelfTest = false;
    int ringFeedId = 0;
    std::string ringFeedWav;
    juce::String scanFormat;
    juce::String probeFormat;
    juce::String probeCandidate;
    juce::String probeOut;
    juce::String captureFormat;
    juce::String captureIdentifier;
    juce::String captureParams;
    juce::String captureOut;
    std::optional<juce::String> keysName;
    std::optional<juce::String> monitorName;
    bool monitorDestination = false;
    bool nullOutput = false;
    int idleSeconds = 300;

    for (int i = 1; i < argc; ++i)
    {
        juce::String arg (argv[i]);
        if (arg == "--socket" && i + 1 < argc)
            socketPath = argv[++i];
        else if (arg == "--render" && i + 1 < argc)
            renderPlan = argv[++i];
        else if (arg == "--render-live" && i + 2 < argc)
        {
            renderLiveSession = argv[++i];
            renderLiveOut = argv[++i];
        }
        else if (arg == "--click" && i + 1 < argc)
            renderLiveClick = argv[++i]; // with --render-live: a click schedule to add
        else if (arg == "--input" && i + 1 < argc)
            renderLiveInputs.push_back (argv[++i]); // with --render-live: name=file.wav
        else if (arg == "--scan" && i + 1 < argc)
            scanFormat = argv[++i];
        else if (arg == "--scan-probe" && i + 3 < argc)
        {
            probeFormat = argv[++i];
            probeCandidate = argv[++i];
            probeOut = argv[++i];
        }
        else if (arg == "--state-capture" && i + 4 < argc)
        {
            captureFormat = argv[++i];
            captureIdentifier = argv[++i];
            captureParams = argv[++i];
            captureOut = argv[++i];
        }
        else if (arg == "--keys" && i + 1 < argc)
            keysName = juce::String::fromUTF8 (argv[++i]);
        else if (arg == "--midi-monitor" && i + 1 < argc)
            monitorName = juce::String::fromUTF8 (argv[++i]);
        else if (arg == "--destination" && monitorName)
            monitorDestination = true; // with --midi-monitor: publish a virtual destination
        else if (arg == "--null-output")
            nullOutput = true;
        else if (arg == "--ring-selftest")
            ringSelfTest = true;
        else if (arg == "--capture-selftest")
            captureSelfTest = true;
        else if (arg == "--midi-out-selftest")
            midiOutSelfTest = true;
        else if (arg == "--ring-feed" && i + 2 < argc)
        {
            const juce::String id (argv[++i]);
            ringFeedId = id.containsOnly ("0123456789") ? id.getIntValue() : 0;
            if (ringFeedId <= 0)
            {
                std::fprintf (stderr, "field-audiod: --ring-feed wants a ring number, not \"%s\"\n", id.toRawUTF8());
                return 2;
            }
            ringFeedWav = argv[++i];
        }
        else if (arg == "--idle" && i + 1 < argc)
            idleSeconds = juce::String (argv[++i]).getIntValue();
        else
        {
            std::fprintf (stderr,
                          "usage: field-audiod [--socket <path>] [--null-output] "
                          "[--idle <seconds>]\n"
                          "       field-audiod --render <plan.json>\n"
                          "       field-audiod --render-live <session.json> <out.wav> "
                          "[--click <schedule.json>] [--input <name>=<file.wav>]...\n"
                          "       field-audiod --scan <au|vst3>\n"
                          "       field-audiod --scan-probe <au|vst3> <candidate> <out>\n"
                          "       field-audiod --state-capture <au|vst3> <identifier> "
                          "<paramsJson> <out>\n"
                          "       field-audiod --ring-selftest\n"
                          "       field-audiod --capture-selftest\n"
                          "       field-audiod --midi-out-selftest\n"
                          "       field-audiod --ring-feed <ring> <file.wav>\n"
                          "       field-audiod --keys <name>\n"
                          "       field-audiod --midi-monitor <name> [--destination]\n");
            return 2;
        }
    }

    // The helper behind `field keys` and its monitor
    // (keyboard-instrument.md §2.5) are subprocesses for the reason --render
    // is: they return before any socket or audio device exists, so playing
    // keys never contends with the transport.
    if (keysName)
        return field::runKeys (*keysName);
    if (monitorName)
        return field::runMidiMonitor (*monitorName, monitorDestination);

    // Scanning is a subprocess tree for the same isolation reasons as
    // --render: the parent iterates candidates and spawns itself with
    // --scan-probe per candidate, so a plugin that crashes while being
    // described is a recorded skip, never a dead scan
    // (plugin-hosting.md chunk 1).
    // Hosting subprocesses leave via _Exit (hosting.h exitSubprocess):
    // their work is already flushed, and static teardown after a plugin
    // module has loaded frees memory that is not the process's to free.
    if (probeFormat.isNotEmpty())
    {
        try
        {
            field::exitSubprocess (field::runScanProbe (probeFormat.toStdString(),
                                                        probeCandidate.toStdString(),
                                                        probeOut.toStdString()));
        }
        catch (const std::exception& e)
        {
            std::fprintf (stderr, "field-audiod: probe failed: %s\n", e.what());
            field::exitSubprocess (1);
        }
    }
    if (captureFormat.isNotEmpty())
    {
        try
        {
            field::exitSubprocess (field::runStateCapture (captureFormat.toStdString(),
                                                           captureIdentifier.toStdString(),
                                                           captureParams.toStdString(),
                                                           captureOut.toStdString()));
        }
        catch (const std::exception& e)
        {
            std::fprintf (stderr, "field-audiod: state capture failed: %s\n", e.what());
            field::exitSubprocess (1);
        }
    }
    if (scanFormat.isNotEmpty())
    {
        try
        {
            field::exitSubprocess (
                field::runScan (scanFormat.toStdString(),
                                juce::File::getSpecialLocation (
                                    juce::File::currentExecutableFile)
                                    .getFullPathName()
                                    .toStdString()));
        }
        catch (const std::exception& e)
        {
            std::fprintf (stderr, "field-audiod: scan failed: %s\n", e.what());
            field::exitSubprocess (1);
        }
    }

    // Render is a subprocess, not a mode of the running daemon
    // (render-pipeline.md decision 6): it returns before any socket,
    // device or message loop exists, so a build action never contends
    // with a playback session and two builds never contend with each
    // other. Nothing below this point runs.
    if (renderPlan.isNotEmpty())
    {
        if (auto error = field::runRender (renderPlan.toStdString()); ! error.empty())
        {
            std::fprintf (stderr, "field-audiod: render failed: %s\n", error.c_str());
            if (field::hostingWasUsed())
                field::exitSubprocess (1);
            return 1;
        }
        // A render that hosted a plugin skips static teardown (see the
        // subprocess comment below); one that did not keeps the ordinary
        // exit it has always had.
        if (field::hostingWasUsed())
            field::exitSubprocess (0);
        return 0;
    }

    // The ring's own check (ring_input.h): the reader against the
    // writer FieldOut runs, with no SuperCollider in the loop.
    if (ringSelfTest)
    {
        if (auto error = field::runRingSelfTest(); ! error.empty())
        {
            std::fprintf (stderr, "field-audiod: ring self-test failed: %s\n", error.c_str());
            return 1;
        }
        std::printf ("{\"ok\":true}\n");
        return 0;
    }

    // The capture input's own check (capture_input.h): an armed input
    // read whole, in a loop wrap's steps, and with nothing to read.
    if (captureSelfTest)
    {
        if (auto error = field::runCaptureSelfTest(); ! error.empty())
        {
            std::fprintf (stderr, "field-audiod: capture self-test failed: %s\n", error.c_str());
            return 1;
        }
        std::printf ("{\"ok\":true}\n");
        return 0;
    }

    // The MIDI outputs' own check (midi_out.h): the callback's selection
    // and the sender's, against a fake clock and fake sinks.
    if (midiOutSelfTest)
    {
        if (auto error = field::runMidiOutSelfTest(); ! error.empty())
        {
            std::fprintf (stderr, "field-audiod: MIDI output self-test failed: %s\n", error.c_str());
            return 1;
        }
        std::printf ("{\"ok\":true}\n");
        return 0;
    }

    // An input without SuperCollider (ring_input.h): a file into a ring.
    if (ringFeedId > 0)
    {
        if (auto error = field::runRingFeed ((uint32_t) ringFeedId, ringFeedWav); ! error.empty())
        {
            std::fprintf (stderr, "field-audiod: ring feed failed: %s\n", error.c_str());
            return 1;
        }
        return 0;
    }

    // The golden instrument (live.h): a session evaluated offline, for
    // byte-comparison against the stems the same graph renders. A
    // subprocess for the same reasons --render is.
    if (renderLiveSession.isNotEmpty())
    {
        if (auto error = field::runRenderLive (renderLiveSession.toStdString(),
                                               renderLiveOut.toStdString(),
                                               juce::File::getCurrentWorkingDirectory()
                                                   .getFullPathName()
                                                   .toStdString(),
                                               renderLiveClick.toStdString(),
                                               renderLiveInputs);
            ! error.empty())
        {
            std::fprintf (stderr, "field-audiod: render-live failed: %s\n", error.c_str());
            return 1;
        }
        return 0;
    }

    // A write to a dying client must be an error return, never a
    // process-killing signal. On POSIX this line is the whole mechanism:
    // with SIGPIPE ignored, write() to a closed peer returns EPIPE and
    // Server::send stops. Windows has no SIGPIPE at all — a send to a
    // closed peer is an error return by definition — so the guarantee
    // holds there with no line to write, and the guard below is absence
    // of the symbol, not absence of the guarantee.
    //
    // There used to be a per-socket SO_NOSIGPIPE alongside it, described
    // as belt and braces. It was redundant, and the redundancy was
    // load-bearing only in the argument for it: the daemon never forks or
    // execs (so no child inherits this disposition), nothing else here
    // touches SIGPIPE, and JUCE's only handler lives in NamedPipe, which
    // the daemon never constructs — and is an empty function anyway. The
    // second mechanism also happened to be the one thing in the daemon
    // that did not port to Linux, which is a fair sign of what it was
    // worth.
    //
    // What this line does cover is a real cross-thread race, not a
    // hypothetical one: Server::send checks connection.open before
    // writing and the reader thread clears that flag when the peer goes,
    // but they are different threads — so a broadcast can read the flag
    // as true and write microseconds after the close. Narrow, and fatal
    // without this.
    //
    // It is not covered by a test. An attempt (30 connect-and-vanish
    // cycles during playback) never lost the race, and passed with
    // SIGPIPE back at SIG_DFL, so it asserted nothing. Provoking the
    // window from outside means winning a race the daemon is built to
    // lose, and a test that hits it only sometimes is worse than none.
#if ! defined(_WIN32)
    std::signal (SIGPIPE, SIG_IGN);
#endif

    juce::ScopedJuceInitialiser_GUI juceInit;

    Player player (nullOutput);
    if (auto error = player.initialise(); error.isNotEmpty())
    {
        std::fprintf (stderr, "field-audiod: audio init failed: %s\n", error.toRawUTF8());
        return 1;
    }

    Server server (player, socketPath);
    if (auto error = server.start(); error.isNotEmpty())
    {
        std::fprintf (stderr, "field-audiod: %s\n", error.toRawUTF8());
        return 1;
    }

    // A finalized take reaches every client, however the take ended — the
    // stop op that ended it, a remote stop, the bed running out.
    // Nested rather than flattened: the manifest's own `id` is the
    // transaction's, and a top-level `id` is how every client tells a
    // response from an event.
    player.onTake = [&server] (const juce::var& manifest)
    {
        server.broadcast (jsonEvent ("take", [&] (juce::DynamicObject& o)
                                     { o.setProperty ("take", manifest); }));
    };

    // The spawn reports what a dead daemon left behind (recording.md §5):
    // an incomplete transaction under .field/recording/ is a take whose
    // audio is still there, waiting for `recover`. The log is the
    // daemon's only voice at this point; the `recordings` op is how a
    // client asks.
    // Held in a local: getArray() points into the var, and a temporary
    // var dies at the end of the condition that produced it.
    const auto transactions = field::Transaction::list (juce::File::getCurrentWorkingDirectory(), {});
    if (auto* pending = transactions.getArray())
        for (const auto& entry : *pending)
            if (! (bool) entry.getProperty ("complete", false))
            {
                const bool midi = entry.hasProperty ("events_on_disk");
                std::fprintf (stderr,
                              "field-audiod: recoverable take %s (%lld %s on disk) — "
                              "recover it with the recover op\n",
                              entry.getProperty ("id", juce::var()).toString().toRawUTF8(),
                              (long long) (juce::int64) entry.getProperty (midi ? "events_on_disk" : "frames_on_disk", 0),
                              midi ? "MIDI messages" : "frames");
            }

    Heartbeat heartbeat (player, server, idleSeconds);
    // runDispatchLoopUntil rather than runDispatchLoop: the daemon has no
    // NSApplication, and the bounded variant reliably drives timers and
    // async callbacks in a plain console process.
    while (! heartbeat.wantExit)
        juce::MessageManager::getInstance()->runDispatchLoopUntil (100);

    // Drain before destruction, still dispatching: a reader parked on a
    // MessageManagerLock is only released by this loop, so leaving it with
    // live readers would deadlock ~Server's join (#12 review). Progress is
    // guaranteed — each pass grants pending locks, finished readers mark
    // themselves closed, the sweep reaps them.
    server.beginShutdown();
    while (server.connectionCount() > 0)
    {
        juce::MessageManager::getInstance()->runDispatchLoopUntil (50);
        server.sweepClosedConnections();
    }
    server.sweepClosedConnections();
    // Rings outlive the process unless unlinked, and the exit below skips
    // the destructors that would unlink them.
    player.closeInputs();
    player.closeMidiOutputs();
    // A daemon that hosted a plugin (a live session's chain) has the
    // same static-teardown hazard the render subprocess measured: a
    // loaded plugin module's memory in the DeletedAtShutdown list. The
    // sockets are drained and the device is about to close with the
    // process; teardown has nothing left to contribute but the crash.
    if (field::hostingWasUsed())
        field::exitSubprocess (0);
    return 0;
}
