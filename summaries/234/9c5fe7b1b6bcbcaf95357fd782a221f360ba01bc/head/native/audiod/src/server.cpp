#include "server.h"
#include "player.h"
#include "version.h"


#if defined(_WIN32)
// The named-pipe transport (windows-portability.md §2.1): the CLI
// computes the \\.\pipe\ name (socketPathFor's win32 branch) and
// hands it whole via --socket. FILE_FLAG_FIRST_PIPE_INSTANCE is the
// flock — a second daemon on the same name fails at creation, before
// anything is disturbed — and CancelIoEx is the SHUT_RD, aborting a
// reader's wait while the write side finishes in-flight responses.
// Request handling below the I/O layer is shared with the POSIX arm.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <sddl.h>
#pragma comment (lib, "advapi32.lib")

#include <algorithm>
#include <cmath>
#include <cstring>
#include <vector>
#else
#include <fcntl.h>
#include <sys/file.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>
#endif

namespace
{
constexpr int protocolVersion = 1;

juce::String jsonLine (const juce::var& v)
{
    return juce::JSON::toString (v, true) + "\n";
}

juce::DynamicObject::Ptr obj() { return new juce::DynamicObject(); }

juce::var errorResponse (const juce::var& id, const juce::String& message)
{
    auto o = obj();
    if (! id.isVoid())
        o->setProperty ("id", id);
    o->setProperty ("ok", false);
    o->setProperty ("error", message);
    return juce::var (o.get());
}

// arm's `controllers` (instrument-knobs.md §2.8): [{channel, cc, value}],
// channel from 1 to 16 as `field keys` writes it, controller from 0 to
// 119, value from 0 to 127. Absent is none. Empty string, or why not.
juce::String readChaseSeeds (const juce::var& list, std::vector<ChaseSeed>& seeds)
{
    if (list.isVoid())
        return {};
    const auto* items = list.getArray();
    const juce::String shape = "arm's controllers are a list of {channel, cc, value}: channel 1 to 16, cc 0 to 119, value 0 to 127";
    if (items == nullptr)
        return shape;
    const auto whole = [] (const juce::var& v, int low, int high)
    { return (v.isInt() || v.isInt64() || v.isDouble()) && (double) v == std::floor ((double) v) && (int) v >= low && (int) v <= high; };
    for (const auto& item : *items)
    {
        const auto channel = item.getProperty ("channel", juce::var());
        const auto cc = item.getProperty ("cc", juce::var());
        const auto value = item.getProperty ("value", juce::var());
        if (! whole (channel, 1, 16) || ! whole (cc, 0, 119) || ! whole (value, 0, 127))
            return shape;
        seeds.push_back ({ (int) channel - 1, (int) cc, (int) value });
    }
    return {};
}

// What a stop answers with (arming.md §2.2): `take`, the primary track's
// manifest, as a one-track stop always has, and `takes`, every armed
// track's, the primary's first. A take whose finalize failed is left out.
void addTakes (juce::DynamicObject& ok, const juce::Array<juce::var>& manifests)
{
    if (manifests.isEmpty())
        return;
    const auto finalized = [] (const juce::var& m) { return m.isObject() && ! m.hasProperty ("error"); };
    if (finalized (manifests.getFirst()))
        ok.setProperty ("take", manifests.getFirst());
    juce::Array<juce::var> takes;
    for (const auto& manifest : manifests)
        if (finalized (manifest))
            takes.add (manifest);
    ok.setProperty ("takes", takes);
}

// hello's pid, spelled per platform: dispatch is shared, but <unistd.h>
// is only included on the POSIX arm.
int processId()
{
#if defined(_WIN32)
    return (int) GetCurrentProcessId();
#else
    return (int) ::getpid();
#endif
}
} // namespace

Server::Server (Player& p, juce::String relativeSocketPath)
    : player (p), socketPath (std::move (relativeSocketPath))
{
}

void Server::handleLine (Connection& connection, const juce::String& line)
{
    lastActivity = juce::Time::currentTimeMillis();
    auto request = juce::JSON::parse (line);
    juce::String response;
    if (! request.isObject())
    {
        response = jsonLine (errorResponse (juce::var(), "invalid JSON"));
    }
    else if (request.getProperty ("op", juce::var()).toString() == "session")
    {
        // The one op dispatched without the blanket lock: session
        // construction instantiates plugins, and JUCE's create posts to
        // the message thread and waits — under the lock that wait is on
        // this thread's own lock, and the daemon hangs (minjudd's P1 on
        // #150). loadSession builds lock-free and takes the lock itself
        // for the install, so player state stays message-thread-owned
        // and the heavy build no longer serializes other connections'
        // requests.
        response = dispatch (request, &connection);
    }
    else
    {
        // Player state belongs to the message thread; every request takes
        // the lock, which also serializes requests across connections.
        const juce::MessageManagerLock mml;
        response = dispatch (request, &connection);
    }
    send (connection, response);
}

juce::String Server::dispatch (const juce::var& request, const void* owner)
{
    auto id = request.getProperty ("id", juce::var());
    auto op = request.getProperty ("op", juce::var()).toString();
    auto ok = obj();
    if (! id.isVoid())
        ok->setProperty ("id", id);
    ok->setProperty ("ok", true);

    if (op == "hello")
    {
        ok->setProperty ("protocol", protocolVersion);
        ok->setProperty ("daemon", "field-audiod");
        ok->setProperty ("version", field::daemonVersion);
        // So a client can tell a stale daemon apart from a live one by
        // more than its answers — and so a test can kill this process
        // mid-take to prove the transaction survives.
        ok->setProperty ("pid", processId());
        // Capability names (realtime.md §3): clients gate on these, not
        // on parsing the version string.
        juce::Array<juce::var> features;
        features.add ("loop");
        features.add ("session");
        // The session verb replaces mid-play with the transport carried
        // (chunk 3). 0.5 advertised `session` too, with a swap that
        // stopped and rewound — so the watch path gates on this feature,
        // not that one (Codex's finding).
        features.add ("swap");
        // The input side (recording.md §6): arm, disarm, record, the
        // recordings list and recover, `record` in status, the `record`
        // and `take` events, and stop finalizing a take.
        features.add ("record");
        // The metronome schedule op and record's `start` (recording.md
        // §7): a count-in is the schedule beginning before the take.
        features.add ("click");
        features.add ("record-start");
        // The region loop and record's until/loop (recording.md §10.4):
        // punch-out, and a take per pass.
        features.add ("loop-region");
        features.add ("record-until");
        // arm's kind "midi" and the MIDI take (keyboard-instrument.md
        // §12.4).
        features.add ("record-midi");
        features.add ("record-tracks");
        // arm's controllers, and a MIDI take that starts with the
        // controllers sent before it (instrument-knobs.md §2.8).
        features.add ("midi-chase");
        // The input and input_close ops, `inputs` in status, and input
        // windows in a session (live-supercollider.md chunk 2).
        features.add ("live-input");
        // `monitor` on arm's audio entries: capture inputs a session's
        // input windows read (live-supercollider.md §12).
        features.add ("live-monitor");
        // The midi_out and midi_out_close ops, `outputs` in status, and
        // MIDI capture leaving the daemon's own outputs out (sequencer.md
        // §2.5).
        features.add ("midi-out");
        ok->setProperty ("features", features);
    }
    else if (op == "devices")
    {
        auto devices = player.deviceList();
        if (auto* o = devices.getDynamicObject())
            for (auto& prop : o->getProperties())
                ok->setProperty (prop.name, prop.value);
    }
    else if (op == "device.select")
    {
        auto error = player.selectDevice (request.getProperty ("name", juce::var()).toString());
        if (error.isNotEmpty())
            return jsonLine (errorResponse (id, error));
    }
    else if (op == "load")
    {
        auto path = request.getProperty ("path", juce::var()).toString();
        auto loop = (bool) request.getProperty ("loop", false);
        auto info = player.load (juce::File (path), loop);
        if (info.getProperty ("error", juce::var()).isString())
            return jsonLine (errorResponse (id, info.getProperty ("error", juce::var()).toString()));
        if (auto* o = info.getDynamicObject())
            for (auto& prop : o->getProperties())
                ok->setProperty (prop.name, prop.value);
    }
    else if (op == "session")
    {
        // The compiled live session (session.ts): rendered by the
        // engine from this moment; paths resolve against the daemon's
        // working directory, which is the project root.
        auto info = player.loadSession (request.getProperty ("session", juce::var()),
                                        juce::File::getCurrentWorkingDirectory());
        if (info.getProperty ("error", juce::var()).isString())
            return jsonLine (errorResponse (id, info.getProperty ("error", juce::var()).toString()));
        if (auto* o = info.getDynamicObject())
            for (auto& prop : o->getProperties())
                ok->setProperty (prop.name, prop.value);
    }
    else if (op == "input")
    {
        // A live input (live-supercollider.md §2): a ring FieldOut writes
        // and the session's input window of this name reads.
        auto info = player.openInput (request.getProperty ("name", juce::var()).toString(), owner);
        if (info.getProperty ("error", juce::var()).isString())
            return jsonLine (errorResponse (id, info.getProperty ("error", juce::var()).toString()));
        if (auto* o = info.getDynamicObject())
            for (auto& prop : o->getProperties())
                ok->setProperty (prop.name, prop.value);
    }
    else if (op == "input_close")
    {
        auto error = player.closeInput (request.getProperty ("name", juce::var()).toString());
        if (error.isNotEmpty())
            return jsonLine (errorResponse (id, error));
    }
    else if (op == "midi_out")
    {
        // A MIDI output's schedule (sequencer.md §2.5): opens the output,
        // or replaces the schedule of the one open under the name.
        auto info = player.openMidiOutput (request, owner);
        if (info.getProperty ("error", juce::var()).isString())
            return jsonLine (errorResponse (id, info.getProperty ("error", juce::var()).toString()));
        if (auto* o = info.getDynamicObject())
            for (auto& prop : o->getProperties())
                ok->setProperty (prop.name, prop.value);
    }
    else if (op == "midi_out_close")
    {
        auto error = player.closeMidiOutput (request.getProperty ("name", juce::var()).toString());
        if (error.isNotEmpty())
            return jsonLine (errorResponse (id, error));
    }
    else if (op == "ramp")
    {
        auto error = player.liveRamp (request.getProperty ("track", juce::var()).toString(),
                                      (int) request.getProperty ("input", juce::var (0)),
                                      (double) request.getProperty ("gain_db", juce::var (0.0)),
                                      (double) request.getProperty ("ramp_ms", juce::var (15.0)));
        if (error.isNotEmpty())
            return jsonLine (errorResponse (id, error));
    }
    else if (op == "play")
    {
        auto error = player.play();
        if (error.isNotEmpty())
            return jsonLine (errorResponse (id, error));
    }
    else if (op == "pause")
    {
        // Both end a take in progress (player.cpp: a capture against a
        // still transport has no honest placement), and both hand the
        // finalized manifest back so the caller that ended it has it
        // without a second round-trip; the `take` event reaches everyone
        // else.
        addTakes (*ok, player.stopRecording());
        player.pause();
    }
    else if (op == "stop")
    {
        addTakes (*ok, player.stopRecording());
        player.stop();
    }
    else if (op == "arm")
    {
        const auto track = request.getProperty ("track", juce::var()).toString();
        const auto kind = request.getProperty ("kind", juce::var());
        std::vector<ChaseSeed> seeds;
        if (auto error = readChaseSeeds (request.getProperty ("controllers", juce::var()), seeds); error.isNotEmpty())
            return jsonLine (errorResponse (id, error));
        juce::var info;
        if (auto* tracks = request.getProperty ("tracks", juce::var()).getArray())
            info = player.armSet (*tracks, request.getProperty ("device", juce::var()).toString(), seeds, owner);
        else if (kind.toString() == "midi")
            info = player.armMidi (track, seeds);
        else if (! kind.isVoid())
            return jsonLine (errorResponse (id, "arm's kind is \"midi\", or absent for an audio input"));
        else
        {
            auto input = request.getProperty ("input", juce::var (1));
            if (! input.isInt() && ! input.isInt64() && ! input.isDouble())
                return jsonLine (errorResponse (id, "arm needs an input channel number"));
            info = player.arm (track, request.getProperty ("device", juce::var()).toString(), (int) input);
        }
        if (info.getProperty ("error", juce::var()).isString())
            return jsonLine (errorResponse (id, info.getProperty ("error", juce::var()).toString()));
        if (auto* o = info.getDynamicObject())
            for (auto& prop : o->getProperties())
                ok->setProperty (prop.name, prop.value);
    }
    else if (op == "disarm")
    {
        auto error = player.disarm();
        if (error.isNotEmpty())
            return jsonLine (errorResponse (id, error));
    }
    else if (op == "record")
    {
        auto info = player.record (request.getProperty ("at", juce::var()),
                                   request.getProperty ("start", juce::var()),
                                   request.getProperty ("until", juce::var()),
                                   (bool) request.getProperty ("loop", false));
        if (info.getProperty ("error", juce::var()).isString())
            return jsonLine (errorResponse (id, info.getProperty ("error", juce::var()).toString()));
        if (auto* o = info.getDynamicObject())
            for (auto& prop : o->getProperties())
                ok->setProperty (prop.name, prop.value);
    }
    else if (op == "loop")
    {
        // The live session's region loop (recording.md §10.4): {from,
        // to} in session samples; omitting both clears it.
        auto from = request.getProperty ("from", juce::var (0));
        // `to` omitted beside a `from` means the content's extent (-1 to
        // the player); both omitted clears.
        auto to = request.getProperty ("to", request.hasProperty ("from") ? juce::var (-1) : juce::var (0));
        if ((! from.isInt() && ! from.isInt64() && ! from.isDouble())
            || (! to.isInt() && ! to.isInt64() && ! to.isDouble()))
            return jsonLine (errorResponse (id, "loop needs sample numbers for from and to"));
        auto error = player.setLoopRegion ((juce::int64) from, (juce::int64) to);
        if (error.isNotEmpty())
            return jsonLine (errorResponse (id, error));
    }
    else if (op == "click")
    {
        // The metronome schedule (recording.md §7): {rate, ticks}. An
        // empty ticks list clears it.
        auto error = player.setClick (request);
        if (error.isNotEmpty())
            return jsonLine (errorResponse (id, error));
    }
    else if (op == "recordings")
    {
        ok->setProperty ("recordings", player.recordings());
    }
    else if (op == "recover")
    {
        // `transaction`, not `id`: the request's id is the request's.
        auto info = player.recover (request.getProperty ("transaction", juce::var()).toString());
        if (info.getProperty ("error", juce::var()).isString())
            return jsonLine (errorResponse (id, info.getProperty ("error", juce::var()).toString()));
        ok->setProperty ("take", info);
    }
    else if (op == "locate")
    {
        auto sample = request.getProperty ("sample", juce::var());
        if (! sample.isInt() && ! sample.isInt64() && ! sample.isDouble())
            return jsonLine (errorResponse (id, "locate needs a sample number"));
        auto error = player.locate ((juce::int64) sample);
        if (error.isNotEmpty())
            return jsonLine (errorResponse (id, error));
    }
    else if (op == "status")
    {
        auto s = player.status (true); // a client read consumes the meter
        if (auto* o = s.getDynamicObject())
            for (auto& prop : o->getProperties())
                ok->setProperty (prop.name, prop.value);
    }
    else if (op == "quit")
    {
        quitRequested = true;
    }
    else
    {
        return jsonLine (errorResponse (id, "unknown op: " + op));
    }
    return jsonLine (juce::var (ok.get()));
}


void Server::broadcast (const juce::String& line)
{
    std::vector<std::shared_ptr<Connection>> current;
    {
        const std::lock_guard<std::mutex> lock (connectionsMutex);
        current = connections;
    }
    for (auto& connection : current)
        if (connection->open)
            send (*connection, line);
}

int Server::connectionCount()
{
    const std::lock_guard<std::mutex> lock (connectionsMutex);
    int open = 0;
    for (auto& connection : connections)
        if (connection->open)
            ++open;
    return open;
}


#if defined(_WIN32)

// Connection::pipe and the two Server members are void* in the header to
// keep <windows.h> out of it; this file casts at the boundary.
static HANDLE asHandle (void* p) { return static_cast<HANDLE> (p); }

// The pipe's DACL: the user running the daemon, and nobody else - the
// 0600 the POSIX socket has, which §2.1 chose pipes partly to keep. A null
// SECURITY_ATTRIBUTES would give the default descriptor, which grants read
// to Everyone and the anonymous account: any local account could open the
// pipe, receive every broadcast, and hold the idle exit off. Built once and
// kept for the process's life; nullptr when it cannot be built, which
// start() refuses rather than falling back to the default.
static SECURITY_ATTRIBUTES* pipeSecurity()
{
    static SECURITY_ATTRIBUTES attributes = []
    {
        SECURITY_ATTRIBUTES built {};
        HANDLE token = nullptr;
        if (! OpenProcessToken (GetCurrentProcess(), TOKEN_QUERY, &token))
            return built;
        DWORD size = 0;
        GetTokenInformation (token, TokenUser, nullptr, 0, &size);
        std::vector<unsigned char> user (size);
        LPSTR sid = nullptr;
        if (size > 0 && GetTokenInformation (token, TokenUser, user.data(), size, &size)
            && ConvertSidToStringSidA (reinterpret_cast<TOKEN_USER*> (user.data())->User.Sid, &sid))
        {
            // D:P is a protected DACL (nothing inherited); GA is generic
            // all, for this one SID.
            const auto sddl = std::string ("D:P(A;;GA;;;") + sid + ")";
            PSECURITY_DESCRIPTOR descriptor = nullptr;
            if (ConvertStringSecurityDescriptorToSecurityDescriptorA (sddl.c_str(), SDDL_REVISION_1,
                                                                      &descriptor, nullptr))
            {
                built.nLength = sizeof (built);
                built.lpSecurityDescriptor = descriptor;
                built.bInheritHandle = FALSE;
            }
            LocalFree (sid);
        }
        CloseHandle (token);
        return built;
    }();
    return attributes.lpSecurityDescriptor != nullptr ? &attributes : nullptr;
}

// Byte mode, blocking semantics under overlapped I/O, and local clients
// only: without PIPE_REJECT_REMOTE_CLIENTS a pipe accepts connections
// from other machines and checks them against the DACL alone.
static constexpr DWORD pipeMode = PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS;

Server::~Server()
{
    running = false;
    if (acceptEvent != nullptr)
        SetEvent (asHandle (acceptEvent));
    if (acceptThread.joinable())
        acceptThread.join();
    if (pendingPipe != nullptr)
        CloseHandle (asHandle (pendingPipe));
    if (acceptEvent != nullptr)
        CloseHandle (asHandle (acceptEvent));

    std::vector<std::shared_ptr<Connection>> toClose;
    {
        const std::lock_guard<std::mutex> lock (connectionsMutex);
        toClose = connections;
        connections.clear();
    }
    for (auto& c : toClose)
    {
        c->open = false;
        CancelIoEx (asHandle (c->pipe), nullptr);
        if (c->reader.joinable())
            c->reader.join();
        CloseHandle (asHandle (c->pipe));
    }
}

juce::String Server::start()
{
    if (! socketPath.startsWith ("\\\\.\\pipe\\"))
        return "on Windows --socket must be a \\\\.\\pipe\\ name, got: " + socketPath
               + " (an older field CLI passes the POSIX path - rebuild it)";

    // First instance, and the single-owner guarantee with it: two daemons
    // racing one name cannot both hold FILE_FLAG_FIRST_PIPE_INSTANCE, and
    // the loser fails here with ERROR_ACCESS_DENIED - the same shape as
    // the #12-review flock, with no lock file and no stale socket to
    // unlink.
    auto* security = pipeSecurity();
    if (security == nullptr)
        return "could not build the pipe's security descriptor: " + juce::String ((int) GetLastError());
    auto* first = CreateNamedPipeA (socketPath.toRawUTF8(),
                                    PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
                                    pipeMode, PIPE_UNLIMITED_INSTANCES, 64 * 1024, 64 * 1024, 0, security);
    if (first == INVALID_HANDLE_VALUE)
        return GetLastError() == ERROR_ACCESS_DENIED
                   ? "another field-audiod already owns " + socketPath
                   : "CreateNamedPipe failed for " + socketPath + ": " + juce::String ((int) GetLastError());
    pendingPipe = first;

    acceptEvent = CreateEventA (nullptr, TRUE, FALSE, nullptr); // manual-reset
    if (acceptEvent == nullptr)
    {
        CloseHandle (first);
        pendingPipe = nullptr;
        return "CreateEvent failed: " + juce::String ((int) GetLastError());
    }

    lastActivity = juce::Time::currentTimeMillis();
    running = true;
    acceptThread = std::thread ([this] { acceptLoop(); });
    return {};
}

void Server::acceptLoop()
{
    while (running)
    {
        HANDLE pipe = asHandle (pendingPipe);
        OVERLAPPED ov {};
        ov.hEvent = asHandle (acceptEvent);
        ResetEvent (ov.hEvent);
        bool connected = ConnectNamedPipe (pipe, &ov) != 0;
        bool pending = false;
        if (! connected)
        {
            auto err = GetLastError();
            if (err == ERROR_PIPE_CONNECTED)
                connected = true;
            else if (err == ERROR_IO_PENDING)
            {
                pending = true;
                // A bounded poll rather than an INFINITE wait: SetEvent
                // from beginShutdown can race the ResetEvent above and be
                // swallowed, and a missed wake here deadlocks the drain
                // loop. 200 ms of shutdown latency beats a wake protocol
                // that has to be right - the same trade the heartbeat
                // rescan made for hot-plug.
                while (WaitForSingleObject (ov.hEvent, 200) == WAIT_TIMEOUT && running) {}
                DWORD ignored = 0;
                if (running && GetOverlappedResult (pipe, &ov, &ignored, FALSE) != 0)
                {
                    connected = true;
                    pending = false; // reaped: the kernel is done with ov
                }
            }
        }

        // `ov` is this thread's stack and the kernel owns it until the
        // operation completes, so no exit from this iteration may leave a
        // connect outstanding: the destructor joins this thread (freeing
        // the frame) and only then closes the handle, which is when the
        // kernel writes the completion status — into memory that is gone.
        // Probed rather than argued on #161: the status lands *after*
        // CloseHandle. readLoop never had this bug because every
        // GetOverlappedResult there waits (TRUE) before its scope ends.
        if (pending)
        {
            CancelIoEx (pipe, &ov);
            DWORD ignored = 0;
            // A connect that completed between the poll and the cancel is
            // a real client: take it rather than dropping a connection
            // the kernel already accepted.
            if (GetOverlappedResult (pipe, &ov, &ignored, TRUE) != 0 && running)
                connected = true;
        }

        if (! running)
            break; // the destructor closes the parked instance
        if (! connected)
        {
            // A client gave up mid-connect. One that opened the instance
            // and closed it before ConnectNamedPipe ran leaves it failing
            // with ERROR_NO_DATA until the server disconnects it - without
            // this, the loop would retry the same handle forever and no
            // instance would listen. `field --version` does exactly that
            // open-and-close when it probes the pipe with existsSync.
            DisconnectNamedPipe (pipe);
            continue;
        }

        // Park the next instance before serving this one, so a client
        // connecting immediately after has somewhere to land. No
        // FIRST_PIPE_INSTANCE - the name is already ours.
        auto* next = CreateNamedPipeA (socketPath.toRawUTF8(),
                                       PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED,
                                       pipeMode, PIPE_UNLIMITED_INSTANCES, 64 * 1024, 64 * 1024, 0,
                                       pipeSecurity());
        pendingPipe = next != INVALID_HANDLE_VALUE ? next : nullptr;

        auto connection = std::make_shared<Connection>();
        connection->pipe = pipe;
        {
            const std::lock_guard<std::mutex> lock (connectionsMutex);
            connections.push_back (connection);
        }
        lastActivity = juce::Time::currentTimeMillis();
        connection->reader = std::thread ([this, connection] { readLoop (connection); });
        // A connection accepted in the same instant as beginShutdown would
        // miss its cancel and stall the drain loop; catch it here.
        if (! running)
            CancelIoEx (pipe, nullptr);

        if (pendingPipe == nullptr)
            break; // no instance to accept on; stop rather than spin
    }
}

void Server::readLoop (std::shared_ptr<Connection> connection)
{
    std::string buffer;
    char chunk[4096];
    auto processLines = [&]
    {
        size_t newline;
        while ((newline = buffer.find ('\n')) != std::string::npos)
        {
            auto line = buffer.substr (0, newline);
            buffer.erase (0, newline + 1);
            if (! line.empty())
                handleLine (*connection, juce::String::fromUTF8 (line.c_str(), (int) line.size()));
        }
    };

    // `running` in the loop condition is the SHUT_RD this platform does
    // not have: CancelIoEx only aborts a read that is pending at that
    // instant, and a reader that was inside dispatch at shutdown would
    // otherwise issue a fresh ReadFile and keep serving a chatty client
    // forever — the daemon then never exits. The state check closes
    // that; at most one request slips through the gap.
    bool clientGone = false;
    while (connection->open && running)
    {
        // The handle is overlapped, so each read carries its own event;
        // CancelIoEx from beginShutdown aborts the wait.
        DWORD n = 0;
        OVERLAPPED ov {};
        ov.hEvent = CreateEventA (nullptr, TRUE, FALSE, nullptr);
        bool ok = ReadFile (asHandle (connection->pipe), chunk, sizeof (chunk), nullptr, &ov) != 0
                      || GetLastError() == ERROR_IO_PENDING;
        // beginShutdown may have cleared `running` and run its CancelIoEx
        // between the loop check and this ReadFile, so the cancel missed
        // the read. Checking again once the read is issued closes that
        // window: either the cancel saw this read, or this sees the flag.
        if (ok && ! running)
            CancelIoEx (asHandle (connection->pipe), &ov);
        if (ok)
            ok = GetOverlappedResult (asHandle (connection->pipe), &ov, &n, TRUE) != 0;
        const bool aborted = ! ok && GetLastError() == ERROR_OPERATION_ABORTED;
        CloseHandle (ov.hEvent);
        if (! ok || n == 0)
        {
            clientGone = ! aborted; // an abort is shutdown, not the client leaving
            break;
        }
        buffer.append (chunk, (size_t) n);
        processLines();
    }

    if (connection->open && ! running && ! clientGone)
    {
        // Shutdown drain, one peek deep: SHUT_RD on the POSIX arm still
        // delivers what the client had already written before the
        // half-close, so in-flight requests get their responses. One
        // peek, then exactly that many bytes - re-peeking would chase a
        // client that keeps writing, which is the loop this replaces.
        DWORD available = 0;
        PeekNamedPipe (asHandle (connection->pipe), nullptr, 0, nullptr, &available, nullptr);
        while (available > 0)
        {
            DWORD got = 0;
            OVERLAPPED drainOv {};
            drainOv.hEvent = CreateEventA (nullptr, TRUE, FALSE, nullptr);
            bool drained = ReadFile (asHandle (connection->pipe), chunk,
                                     (DWORD) std::min ((size_t) available, sizeof (chunk)), nullptr, &drainOv) != 0
                               || GetLastError() == ERROR_IO_PENDING;
            if (drained)
                drained = GetOverlappedResult (asHandle (connection->pipe), &drainOv, &got, TRUE) != 0;
            CloseHandle (drainOv.hEvent);
            if (! drained || got == 0)
                break;
            available -= got;
            buffer.append (chunk, (size_t) got);
            processLines();
        }
    }

    lastActivity = juce::Time::currentTimeMillis();
    // Last, for the POSIX arm's reason: the sweep is the one closer, so a
    // reused handle can never be closed out from under a newer connection.
    connection->open = false;
}
void Server::send (Connection& connection, const juce::String& line)
{
    const std::lock_guard<std::mutex> lock (connection.writeMutex);
    auto utf8 = line.toRawUTF8();
    auto remaining = strlen (utf8);
    while (remaining > 0 && connection.open)
    {
        // A vanished client is an error return here by construction -
        // there is no SIGPIPE to ignore on this platform (main.cpp).
        DWORD written = 0;
        OVERLAPPED ov {};
        ov.hEvent = CreateEventA (nullptr, TRUE, FALSE, nullptr);
        bool ok = WriteFile (asHandle (connection.pipe), utf8, (DWORD) remaining, nullptr, &ov) != 0
                      || GetLastError() == ERROR_IO_PENDING;
        if (ok)
            ok = GetOverlappedResult (asHandle (connection.pipe), &ov, &written, TRUE) != 0;
        CloseHandle (ov.hEvent);
        if (! ok || written == 0)
            break;
        utf8 += written;
        remaining -= (size_t) written;
    }
}

void Server::beginShutdown()
{
    running = false;
    if (acceptEvent != nullptr)
        SetEvent (asHandle (acceptEvent)); // best effort; the accept wait also polls running
    const std::lock_guard<std::mutex> lock (connectionsMutex);
    for (auto& connection : connections)
        if (connection->open)
            // Aborts the pending read. A null OVERLAPPED cancels every I/O
            // on the handle, so a WriteFile still waiting on a full pipe
            // buffer is cancelled too; only writes that already fit the
            // buffer are sure to finish.
            CancelIoEx (asHandle (connection->pipe), nullptr);
}

void Server::sweepClosedConnections()
{
    const std::lock_guard<std::mutex> lock (connectionsMutex);
    for (auto it = connections.begin(); it != connections.end();)
    {
        if (! (*it)->open)
        {
            if ((*it)->reader.joinable())
                (*it)->reader.join();
            // An input or a MIDI output dies with the connection that
            // opened it: a `field keys` or `field seq` killed outright
            // never closes its own.
            player.closeInputsOwnedBy (it->get());
            player.closeMidiOutputsOwnedBy (it->get());
            DisconnectNamedPipe (asHandle ((*it)->pipe));
            CloseHandle (asHandle ((*it)->pipe));
            it = connections.erase (it);
        }
        else
        {
            ++it;
        }
    }
}

#else

Server::~Server()
{
    running = false;
    if (listenFd >= 0)
    {
        ::shutdown (listenFd, SHUT_RDWR);
        ::close (listenFd);
        ::unlink (socketPath.toRawUTF8());
    }
    if (lockFd >= 0)
        ::close (lockFd); // releases the flock; the lock file itself stays
    if (acceptThread.joinable())
        acceptThread.join();

    std::vector<std::shared_ptr<Connection>> toClose;
    {
        const std::lock_guard<std::mutex> lock (connectionsMutex);
        toClose = connections;
        connections.clear();
    }
    for (auto& c : toClose)
    {
        c->open = false;
        ::shutdown (c->fd, SHUT_RDWR);
        ::close (c->fd);
        if (c->reader.joinable())
            c->reader.join();
    }
}

juce::String Server::start()
{
    if (socketPath.length() >= (int) sizeof (sockaddr_un::sun_path))
        return "socket path too long: " + socketPath;

    sockaddr_un addr {};
    addr.sun_family = AF_UNIX;
    std::snprintf (addr.sun_path, sizeof (addr.sun_path), "%s", socketPath.toRawUTF8());

    // Exactly one daemon per socket, decided by flock rather than a
    // connect probe: two daemons spawned in the same instant could each
    // fail the probe and unlink the other's freshly bound socket (#12
    // review). The lock is held for the daemon's whole life and the OS
    // releases it on any death, so it cannot go stale; with the lock won,
    // any existing socket file is by definition a dead daemon's leftover.
    // The lock file itself is never unlinked — removing it would reopen
    // the race for the next pair of spawns.
    lockFd = ::open ((socketPath + ".lock").toRawUTF8(), O_CREAT | O_RDWR, 0600);
    if (lockFd < 0)
        return "cannot open lock file: " + juce::String (strerror (errno));
    if (::flock (lockFd, LOCK_EX | LOCK_NB) != 0)
        return "another field-audiod already owns " + socketPath;
    ::unlink (socketPath.toRawUTF8());

    listenFd = ::socket (AF_UNIX, SOCK_STREAM, 0);
    if (listenFd < 0)
        return "socket() failed: " + juce::String (strerror (errno));
    if (::bind (listenFd, (sockaddr*) &addr, sizeof (addr)) != 0)
        return "bind() failed for " + socketPath + ": " + juce::String (strerror (errno));
    if (::listen (listenFd, 8) != 0)
        return "listen() failed: " + juce::String (strerror (errno));

    lastActivity = juce::Time::currentTimeMillis();
    running = true;
    acceptThread = std::thread ([this] { acceptLoop(); });
    return {};
}

void Server::acceptLoop()
{
    while (running)
    {
        int fd = ::accept (listenFd, nullptr, nullptr);
        if (fd < 0)
        {
            if (running)
                continue;
            break;
        }
        auto connection = std::make_shared<Connection>();
        connection->fd = fd;
        {
            const std::lock_guard<std::mutex> lock (connectionsMutex);
            connections.push_back (connection);
        }
        lastActivity = juce::Time::currentTimeMillis();
        connection->reader = std::thread ([this, connection] { readLoop (connection); });
        // A connection accepted in the same instant as beginShutdown would
        // miss its half-close and stall the drain loop; catch it here.
        if (! running)
            ::shutdown (fd, SHUT_RD);
    }
}

void Server::readLoop (std::shared_ptr<Connection> connection)
{
    std::string buffer;
    char chunk[4096];
    while (connection->open)
    {
        auto n = ::read (connection->fd, chunk, sizeof (chunk));
        if (n <= 0)
            break;
        buffer.append (chunk, (size_t) n);
        size_t newline;
        while ((newline = buffer.find ('\n')) != std::string::npos)
        {
            auto line = buffer.substr (0, newline);
            buffer.erase (0, newline + 1);
            if (! line.empty())
                handleLine (*connection, juce::String::fromUTF8 (line.c_str(), (int) line.size()));
        }
    }
    lastActivity = juce::Time::currentTimeMillis();
    // Last: the sweep only joins threads whose connection is closed, and
    // everything above must be finished by then. The fd is closed by the
    // sweep too — exactly one closer, so a reused descriptor can never be
    // closed out from under a newer connection.
    connection->open = false;
}

void Server::sweepClosedConnections()
{
    const std::lock_guard<std::mutex> lock (connectionsMutex);
    for (auto it = connections.begin(); it != connections.end();)
    {
        if (! (*it)->open)
        {
            if ((*it)->reader.joinable())
                (*it)->reader.join();
            // An input or a MIDI output dies with the connection that
            // opened it: a `field keys` or `field seq` killed outright
            // never closes its own.
            player.closeInputsOwnedBy (it->get());
            player.closeMidiOutputsOwnedBy (it->get());
            ::close ((*it)->fd);
            it = connections.erase (it);
        }
        else
        {
            ++it;
        }
    }
}


void Server::send (Connection& connection, const juce::String& line)
{
    const std::lock_guard<std::mutex> lock (connection.writeMutex);
    auto utf8 = line.toRawUTF8();
    auto remaining = strlen (utf8);
    while (remaining > 0 && connection.open)
    {
        // A client may vanish between our poll and this write (ctrl-c mid
        // position stream). SIGPIPE is ignored process-wide (main.cpp), so
        // that write returns EPIPE and the loop below stops. There is
        // deliberately no second mechanism — see the note there.
        auto n = ::write (connection.fd, utf8, remaining);
        if (n <= 0)
            break;
        utf8 += n;
        remaining -= (size_t) n;
    }
}


void Server::beginShutdown()
{
    running = false;
    if (listenFd >= 0)
        ::shutdown (listenFd, SHUT_RDWR);
    const std::lock_guard<std::mutex> lock (connectionsMutex);
    for (auto& connection : connections)
        if (connection->open)
            ::shutdown (connection->fd, SHUT_RD); // write side stays up for in-flight responses
}


#endif // platform transport
