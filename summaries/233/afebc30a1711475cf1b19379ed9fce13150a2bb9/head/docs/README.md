# Field

Field treats music production like software development. A song is a
repository. Production state — arrangement, tempo, takes, plugin chains,
synthesis programs, generation recipes, mixes — lives in structured,
schema-validated, diffable files. Every meaningful action is a CLI
command, and audio outputs are produced by an explicit dependency graph
with content-addressed caching. Human users and coding agents work on
the same underlying representation; an MCP surface exposing the CLI's
verbs as tools is planned ([mcp-surface](projects/mcp-surface/readme.md)).

For a concrete project you can read and build, see
[`examples/bloom`](../examples/bloom/README.md) — two songs exercising
most of what this page describes, checked by CI on every change.

## Why

A traditional DAW stores production state inside proprietary project
files and graphical interfaces. You cannot inspect that state, review it
as a text diff, or script it reliably, and it versions only as an opaque
binary blob. Audio generation tools live outside the production
environment, and no operation is reproducible. A coding agent cannot
meaningfully operate a DAW.

Field inverts this. You can build, inspect, edit, and record a Field
project without opening a DAW — from a terminal, from an agent, or from
a small native control surface — and all three drive the same engine and
the same files.

## Core concepts

- **Project** — a Git repository of schema-validated YAML plus
  content-addressed audio assets. A project contains one or more songs —
  think album — plus shared instruments and samples reused across them.
  See [project-model.md](project-model.md).
- **Song** — one piece within a project: its own tempo map, tracks,
  takes, and committed audio, drawing freely on the project's shared
  material. A song's structure is its output track's placements.
- **Track** — the one structural primitive. Every definition is a
  track: an instrument is a leaf track carrying its program, an effect
  is an insert on a track, a submix is a track placing other tracks,
  and the song itself is the track named `main`. Structure, local time,
  and the mixer are the same tree. See [tracks.md](tracks.md).
- **Asset** — an immutable audio or MIDI file, referenced by content
  hash. Field never edits audio in place; all placement and editing is
  metadata.
- **Node** — what the build runs: a track's stem, plus the nodes the
  graph mints that no file declares — a `gen:` per inline render, a
  `convert:` per source-and-rate pair, a `tap:` per pre-tapped sender,
  each shared by every placement or cable that needs it. You author
  tracks; the engine derives nodes, so the graph is bigger than the
  file tree.
- **Label** — the address of something buildable: a track's stem, a gen
  node, the song's output track. For example,
  `field build //songs/opener/track:main`. See
  [build-graph.md](build-graph.md).
- **Take** — one performance of something. Recorded takes and renders of
  nondeterministic nodes use the same machinery: numbered, auditioned,
  one active, none destroyed.
- **Part** — notes you write, in bars and beats, in a file under the
  song's `notes/`. A track's `notes:` entry places it, and the build
  renders it through the track's instrument. A MIDI take is in the same
  format, so you edit one by copying it into a part. See
  [project-model.md](project-model.md) "Parts".
- **Recipe** — a committed, seeded description of how a generated asset
  was produced (a SuperCollider program plus a seed, an ACE prompt plus
  model plus seed), with provenance. Recipes are reproducible; the
  generated bits are committed, not regenerated.

## V1 platform scope

macOS on Apple Silicon only. Core Audio, Audio Units (AUv2, and AUv3
where practical), Apollo interfaces as reference hardware, UAD-2 DSP and
UADx native plugins, SuperCollider, and ACE-Step generative audio.

Explicitly out of scope for V1: Logic (integration, import/export,
plugins), VST/CLAP/AAX, other DAW integrations, a full graphical DAW
interface, cloud collaboration, remote rendering, notation, video
scoring, surround/Atmos, and Apollo Console automation (no supported
API exists — see [audio-engine.md](audio-engine.md)).

Windows and Linux are build-and-test targets, not product platforms. CI
builds the daemon and runs the whole suite on Linux
([linux-portability](projects/linux-portability/readme.md) decision 5), and
Windows is being brought up to build, test, and play
([windows-portability](projects/windows-portability/readme.md)). The
product ships on macOS.

## Two workflows

**CLI-first.** You create, configure, generate, build, play, and record
a project from the command line. `field init` starts an empty project;
on a fresh clone of [`examples/bloom`](../examples/bloom/README.md),
this sequence takes creek from request to delivered file:

```bash
field generate creek/still-water-keys --seed 90210 --variants 2
field generate creek/lead-take --seed 4823 --variants 3
field build creek/track:main
field play creek
field export creek --rate 44100 --bit-depth 16
```

**A minimal recording widget** (later). A compact native macOS control
surface for the engine: transport, arming, metering, monitoring, take
audition. Not a DAW. The widget and the CLI control the same engine and
project state; the widget holds no hidden state unavailable to the CLI.

## Sequencing philosophy

Field is built generation-first, because offline generation delivers
unique value — prompt → recipe → committed, diffable, buildable music —
with zero real-time code. The playback daemon arrived only after real
use had battle-tested the project model; the live graph, plugin hosting
and recording's input side each followed the same rule, and monitoring
is next in that line.
The current build order lives in [projects/](projects/README.md).

## Documentation

- [CLI](cli.md) — the command-line manual: labels, building, playing, exporting
- [Architecture](architecture.md) — layers, processes, and language decisions
- [Tracks](tracks.md) — the structural primitive: the track file, nesting, and cables
- [Project model](project-model.md) — the canonical on-disk representation
- [Build graph](build-graph.md) — targets, caching, freezing, determinism
- [Audio engine](audio-engine.md) — the real-time daemon that plays, records, and hosts plugins
- [Remote](remote.md) — login, clone, push and pull, and the read-through cache against an audiofield remote
- [Keys](keys.md) — the computer keyboard as a MIDI instrument, and how to write a keymap
- [Install](install.md) — `./install.sh` and `field upgrade`: what each step runs, and how to read the status
- [Release](release.md) — cut a release: the Release workflow, `scripts/release.ts`, and the versions a release leaves alone
- [Projects](projects/README.md) — work in progress, next, and later
