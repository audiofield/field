# Architecture

Field is divided into layers with a hard rule about where each language
is allowed: **TypeScript for everything with a keyboard, C++ for
everything with a deadline, Python only as a model-runner.**

```text
CLI / MCP / Recording Widget
            |
            v
    Field Control Plane          TypeScript
            |
     +------+----------+
     v                 v
Native Audio Daemon   Worker subprocesses
(field-audiod)         |         |
 C++ / JUCE       SuperCollider  Python model-runners
     |            (sclang/scsynth,  (field-aced, field-voiced:
 Core Audio        driven over OSC)  ACE-Step, Chatterbox)
 Audio Units
 Apollo
```

## Control plane (TypeScript)

The control plane owns project interpretation and orchestration: it
parses and validates project files, constructs the dependency graph,
hashes inputs, makes cache decisions, invokes the daemon and the
SuperCollider and Python workers, manages assets and provenance,
integrates with Git for semantic diffs, and exposes the CLI (and later
the MCP tool surface).

**Decision — TypeScript, not Python, and no Python-first prototype.**
The schemas are the contract and the daemon speaks a well-defined IPC
protocol, so the control-plane language is technically a two-way door —
but the rewrite tax is real, so Field picks once. TypeScript wins on MCP
SDK maturity, schema validation (zod), and long-running-process
ergonomics. The canonical project format remains language-neutral
regardless.

**Diagnostics have two severities, and only one holds the gate.** A
diagnostic without a severity is an error: `field check` fails, `build`
refuses, `watch` reports and waits for the next edit. A `warning`
reports without failing any of them — `check` prints it (marked
`warning:`) and still says ok, `build` surfaces it and proceeds, `watch`
reports it and rebuilds anyway. The level exists because some true
findings describe normal intermediate states — a cable with one end
wired (nested-tracks.md §19 decision 3) — and a gate that fails on those
either stops legitimate work or trains you to expect red.

**`field --version` reports the build, not the checkout.** `pnpm build`
stamps `dist/build-info.json` with the commit, branch, and dirty count
at build time — cleared before `tsc`, written after everything
succeeds, so a failed build leaves no stamp — and the dist artifact
reads its stamp. Both the stamp and the live read ask Git only when the
package root has its own `.git`, a directory in a clone and a file in a
worktree. A release, built from a source archive, has none, so it
reports no commit even when it is unpacked inside another repository,
whose commit Git would otherwise find by searching upward.

When the checkout has moved since the build, the report says so beside
the baked identity instead of impersonating it: a new HEAD prints
`checkout now at <sha> — field upgrade cli to update`, and edits without
a commit print `checkout has changed since the build — field upgrade cli
to update`. On Windows, where `field upgrade` does not run, both name
`pnpm build` in the checkout instead. Running from source (tsx, vitest)
keeps the live git read, because there the checkout is the code; an
unstamped dist falls back to the live read.

**The remote is a second cache, reached over HTTPS with no new
dependency.** `field login`, `field clone`, and the read-through in
`field build` talk to an audiofield remote through Node's global
`fetch`, with the API shapes as zod schemas in `src/remote/protocol.ts`
and the protocol versioned the way the daemons' are. The remote client
is injected into the build engine at the same seam as the generator
runner, so a build test is never a network test. Git is spawned through
one helper, `src/git.ts`. Tokens live in the macOS keychain or
`~/.field/credentials`, Field's first per-user state. See
[remote.md](remote.md).

**`field ui <song>` is a view over the files, served by the same
process.** It compiles the song's live session, connects to the daemon,
and serves the client in `ui/` over HTTP and one WebSocket per view, bound
to `127.0.0.1`. A gesture in the view ends as a YAML edit, written
through the same comment-preserving document code every editor uses, and
the watch loop carries it into the playing session exactly as it carries
a hand edit; the server never pushes an edit to the daemon itself. Two
guards stand because the socket accepts writes. The upgrade checks the
`Origin` header against the server's own addresses and a per-launch
token, and every edit carries the sha256 of the file bytes it was made
against, so an edit to a file that changed underneath is refused and the
view refreshed. Before writing, the server loads the project with the
edited text and refuses any edit that would add an error. Solo is
session-only: the server compiles an alternate session holding the
soloed track's subtree, its carriers, and its send receivers
(`src/model/solo.ts`), and writes nothing. The view opens in an Electron
shell from the `ui/` workspace member, or in a browser with `--browser`
or when the shell cannot start; closing the shell, or ctrl-c, stops the
transport and ends the session. See
[projects/ui/readme.md](projects/ui/readme.md).

## Native audio daemon (C++ / JUCE) — `field-audiod`

The daemon owns all latency-sensitive and hardware-facing work. Its
playback half is shipped: device I/O, a sample-accurate transport with
musical-position readout, and playback of built labels, behind a
versioned NDJSON protocol on a Unix domain socket, or on Windows a named
pipe. It runs daemon-lite — `field play` spawns it on demand, one
instance per project is guaranteed by a lock file on macOS and Linux and
by `FILE_FLAG_FIRST_PIPE_INSTANCE` on Windows
([windows-portability.md §2.1](projects/windows-portability/readme.md)),
and it exits when idle — and `field transport`, `field devices` and
`field record` drive the same protocol, which CI exercises against the
real binary in null-output mode. Hosting arrived with
[plugin-hosting.md](projects/plugin-hosting/readme.md) chunks 1 and 2:
`--scan` probes installed AU/VST3 plugins one crash-isolated subprocess
each, `--render` instantiates pinned plugins offline, and live sessions
host them in their chains — child chains on the load thread, the master
chain in the callback, delay compensation from declared latency.
Recording arrived with [recording.md](projects/recording/readme.md):
the daemon opens the device duplex only when something arms, captures
one input channel into a crash-safe transaction under
`.field/recording/`, and recovers a transaction a dead daemon left
behind ([audio-engine.md](audio-engine.md) "Capture as built"); a
stopped take lands in the project and builds in place, the metronome
and count-in run in the engine, and punch-out and loop takes ride the
live session's region loop. Monitoring through the engine followed
with [live-supercollider.md](projects/live-supercollider/readme.md)
§12: `field record --monitoring host` plays the armed input through its
track's effects. The rest — comping, editor windows, routing, metering
beyond the armed input's peak — is future work whose settled decisions
live in [audio-engine.md](audio-engine.md).

MIDI is hardware-facing too, so it lives here as well
([keys.md](keys.md)). `field keys` reads the keyboard in TypeScript and
spawns `field-audiod --keys`, a short-lived mode separate from the
daemon that owns the `Field Keys` virtual MIDI source and, on macOS,
reports the active keyboard layout. `--midi-monitor` prints what a
named MIDI source sends, or what reaches a virtual destination it
publishes. Neither touches the transport or the control
socket. The daemon itself records MIDI: armed for a MIDI take, it
listens to every MIDI source and stamps each message on the clock the
audio callback keeps, so a MIDI take lines up with the song as an
audio take does. It sends MIDI on that clock too: a MIDI output plays a
schedule of messages and MIDI clock from the audio callback, to a
virtual source it publishes or to a hardware port
([audio-engine.md](audio-engine.md) "MIDI outputs").

The real-time audio callback never depends on TypeScript or Python: GC
pauses and JIT are disqualifying when a 64-sample buffer at 96kHz gives
you about 0.7ms.

**Decision — C++ with JUCE.** Alternatives considered and rejected:

- *Swift + AVAudioEngine/AudioToolbox.* Viable for a Mac-only product,
  and Apple's stack does host AUv2/v3 with a manual-rendering mode for
  offline builds. Rejected because JUCE has already absorbed a decade of
  workarounds Field would otherwise re-earn: out-of-process plugin
  scanning (one crashy plugin must not kill the daemon), plugin editor
  window hosting, state-serialization quirks across badly behaved
  plugins, delay-compensation bookkeeping, and glitch-free dynamic graph
  rebuilds. UAD plugins exercise exactly these edges.
- *Tracktion Engine.* A full open-source DAW engine — too much of Field
  already built, at the wrong altitude: it owns its project model, and
  Field's entire thesis is owning the model. Mapping canonical files
  onto its internal state would be permanent work, and hidden state is
  the problem Field exists to kill.
- *Rust.* Better real-time discipline than C++ in principle, but there
  is no mature AU-hosting story in Rust, and JUCE is a C++ framework you
  inherit from, not a library you call — a Rust/JUCE bridge means
  designing a C ABI over a deeply object-oriented API and debugging
  real-time threading bugs at the FFI boundary. Not worth borrow
  checking in roughly 30% of one contained process.

**Licensing.** JUCE 8 is dual-licensed AGPLv3 / commercial, and the
daemon also compiles in Steinberg's VST3 SDK to host VST3 plugins,
which JUCE 8.0.4 bundles under GPLv3 or Steinberg's proprietary VST3
license. A daemon built from this repository takes the copyleft option
of each (see the README's License section). A closed-source build would
need a commercial JUCE license and Steinberg's proprietary VST3 license
both; the JUCE license alone does not cover the SDK. JUCE and the SDK
stay **quarantined inside `native/audiod/`**: the daemon, and
`field-fixture`, the test plugin the same CMake project builds for the
hosting tests, whose VST3 build carries both and whose AU build carries
JUCE. They never leak into the CLI, the workers, or the UI, so licensing
exposure stays in that one directory and the hosting layer stays
swappable. The one other copyleft component is FieldOut, in
`native/sc-fieldout/`: a SuperCollider server plugin under
GPL-3.0-or-later, because it builds against SuperCollider's plugin
interface, vendored beside it from SuperCollider 3.14.1. It loads into
`scsynth`, not into any Field process, and shares only the ring's layout
in `native/ring/field_ring.h`, which is MIT, with the daemon
([live-supercollider.md](projects/live-supercollider/readme.md) §11).

## SuperCollider

A first-class runtime, driven directly from TypeScript — no Python
intermediary. SC's control surface is spawning `sclang`/`scsynth` and
OSC over UDP, which TypeScript handles fine. Two modes:

- **Offline (NRT)** — the default: an SC program plus an explicit seed
  renders an asset via scsynth's non-realtime mode. Deterministic,
  cacheable, and the first real build rule. A recorded MIDI take renders
  the same way, through its instrument's voice
  ([build-graph.md](build-graph.md) "`voice-render`").
- **Live** — `field keys <instrument>` runs a voice host: `sclang` on
  `sc/voice-host.scd`, which boots its own scsynth on the output device
  and plays the instrument's voice from every MIDI source
  ([keys.md](keys.md)). Its sound goes straight to the device, beside
  the daemon's rather than through the session graph. Bringing it into
  that graph, so a track's inserts process it, is
  [live-supercollider](projects/live-supercollider/readme.md)'s work.
  The engine's half has landed: a live session carries an input up
  through every chain above its track ([audio-engine.md](audio-engine.md)
  "Live inputs"), fed from a shared-memory ring that FieldOut, a GPL-3.0
  scsynth plugin in `native/sc-fieldout`, writes. `field keys` on a track
  routes the voice host through FieldOut into that input, so the track's
  effects and those above it process what you play.

SC source is tracked in Git and treated as code.

## Python model-runners — `field-aced`, `field-voiced`

Python survives only where the ML ecosystem forces it. Two workers exist
today: `field-aced` runs ACE-Step music generation and `field-voiced`
runs Chatterbox voice generation, both invoked by `field generate` and
never by the build. Each runs from its own uv-managed environment, which
`field setup <worker>` creates explicitly — environments are never built
as a side effect. A worker takes immutable inputs and a job spec and
emits assets plus structured metadata over the versioned worker protocol
(see IPC below), and never participates in the real-time callback.
Later analysis workers (separation, transcription, loudness, take
ranking) join the same protocol. No application code is written in
Python.

## IPC

Boring by design: versioned NDJSON over flock-owned Unix domain sockets
— `field-audiod` on the daemon protocol, `field-aced` and `field-voiced`
on the worker protocol with a `hello` handshake — and OSC to scsynth.
Audio crosses processes once: a voice `field keys` plays reaches the
daemon through a POSIX shared-memory ring that FieldOut writes inside
`scsynth` and the daemon reads, one writer and one reader, the daemon
owning the object ([audio-engine.md](audio-engine.md) "Live inputs"). On
Windows, `field-audiod` listens on a named pipe instead, whose first
instance (`FILE_FLAG_FIRST_PIPE_INSTANCE`) is the single-owner guarantee
and whose DACL admits only the user running it
([windows-portability.md §2.1](projects/windows-portability/readme.md)).
The workers keep their Unix sockets, so they do not run on Windows.
All three daemons share the daemon-lite lifecycle: spawned on demand,
one instance per project, idle exit. `field --version` reports the
worker protocol version and what each running daemon speaks, so the
widget (Swift, later) can speak the same protocol as the control plane.
