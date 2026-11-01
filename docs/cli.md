# CLI

`field` is the whole interface to a Field project. It validates the
project, builds audio through the dependency graph, plays a song live in
the engine, records takes, and edits the YAML that describes all of it.

Every command runs from inside a project. `field` finds the project root
by walking up from your working directory until it finds `field.yaml`,
so any subdirectory works; outside a project you get `not inside a Field
project`. Commands print results to stdout, errors to stderr, and exit
non-zero when they fail.

This page is the task-oriented manual. For the concepts underneath
it — what a track is, why the cache is the freeze — start at
[README](README.md), and read [build-graph.md](build-graph.md) for
labels and caching in depth. For a project to run these commands
against, use [`examples/bloom`](../examples/bloom/README.md).

## Install

Field needs Node 24 (the version in [`.nvmrc`](../.nvmrc)), pnpm —
never npm or yarn — and CMake with a C++ compiler. Install the newest
release:

```sh
curl -fsSL https://field.one/install.sh | bash
```

The installer builds the release from source in
`~/.local/share/field/<version>/` and puts `field` in `~/.local/bin`.
`field upgrade` installs the next release from any directory, and
`field upgrade status` says what is out of date. To work on Field
itself, run `pnpm setup` once and then `./install.sh` in a clone, which
links that checkout onto your PATH instead.
[install.md](install.md) describes both kinds of install, each step,
and each status row. On Windows the installer does not run yet: run
`pnpm install`, `pnpm build`, `pnpm build:ui`, `pnpm build:native`, and
`pnpm add -g .` in a checkout. To run from source without installing,
use `pnpm field <args>`.

Build the daemon before you build, play or record anything.
`field-audiod` is the renderer as well as the player: every track's
stem, inserts included, and every rate conversion render by spawning it, so
`field build` fails without it rather than falling back to anything.
`field play` needs it to play a song live, and `field record` needs it
to capture a take; only plain artifact playback has a fallback (see
[Platform notes](#platform-notes)).

SuperCollider renders every `supercollider:` entry. `field build` runs
the `sclang` that `FIELD_SCLANG` names, or else the one on your `PATH`
(`sclang.exe` on Windows), or else the one the SuperCollider installer
put in place: the macOS app bundle, or the newest
`SuperCollider-<version>` folder under Program Files on Windows. See
[Environment variables](#environment-variables).

To see what you have, ask the version:

```console
$ field --version
field 0.3.0
worker protocol 2
remote        https://audiofield.io (default)  not logged in

daemons in .
  field-audiod  not running
  field-aced    not running
  field-voiced  not running
```

The first line is the CLI's version. A build from a checkout adds the
commit it came from, as in `field 0.3.0  (6a310a4 on main)`, and says so
when the checkout has moved on or carries uncommitted changes. The
`remote` line names the remote this project talks to, where that URL
came from, and whether you are logged in to it (see [Share a project
through a remote](#share-a-project-through-a-remote)). The rest reports
which daemons run for *this* project and which build each one is on — a
daemon started before your last daemon build still runs the old
code, and `field transport quit` is how you retire it.

## Address things with labels

A label is the address of something buildable. The absolute form is
canonical, and the CLI accepts a songs-relative shorthand everywhere:

| Form | Means |
| --- | --- |
| `//songs/creek/track:main` | a track's stem — the canonical spelling |
| `creek/track:main` | the same label, songs-relative |
| `creek` | the song's output track, `track:main` |
| `//songs/creek/gen:lead-take` | a generated node's chosen variant |
| `creek/gen:lead-take-2` | variant 2 specifically, for auditioning |
| `//shared/asset:rain` | shared material, which has no shorthand |
| `creek/...` | every label in the song, as a pattern |

Commands that take labels take several at once, and `build`, `export`
and `play` all accept patterns.

## Check the project

`field check` validates schemas, references, asset content and canonical
formatting. It is the gate every build and every watch rebuild runs
first, and it is what CI runs.

```console
$ field check
ok
```

A failing check prints one line per problem and exits 1. When the only
complaint is formatting, `field fmt` rewrites the files:

```console
$ field fmt
formatted songs/creek/tracks/keys.yaml
```

`field fmt` refuses to format a project with validation errors — fix
those first, since canonically formatting an invalid file means nothing.

## Look around

`field status` summarizes the project:

```console
$ field status
project bloom @ 48000 Hz
  creek: 14 tracks, 25 inputs
  tall-grass: 6 tracks, 6 inputs
```

`field arrangement <song>` derives the song's structure from its output
track's placements — the timeline nobody wrote down:

```console
$ field arrangement creek
creek (12 bars)
  1.1.1 0:00.0  lead-vocal  (+3 dB, pan 0.2)
  1.1.1 0:00.0  pad  (-6 dB, pan -0.2)
  1.1.1 0:00.0  phrase
  1.1.1 0:00.0  space  (-3 dB)
  5.1.1 0:10.0  phrase
  9.1.1 0:20.0  phrase
```

`--json` prints the same structure as JSON, with the field names of
`ArrangementView` in `src/commands/arrangement.ts`, for a program to
read.

The bar count appears when the song declares a `length:`. A song that
declares none is as long as its material, which is also what governs
where playback stops.

`field query` asks the graph a question — a pattern, or `deps(...)` for
everything a label depends on:

```console
$ field query "deps(tall-grass/track:room)"
//songs/tall-grass/gen:seven-eight-loop
//songs/tall-grass/track:seven-eight-loop
//songs/tall-grass/track:drums
//songs/tall-grass/track:room
```

`field explain <label>` is the one to reach for when something surprises
you. It reports the label's type, its inputs, its parameters, and — for
a track — where the signal actually goes, including the cables it
receives:

```console
$ field explain tall-grass/track:room
//songs/tall-grass/track:room (rule)
type: stem v1
input: //songs/tall-grass/track:drums (not built)
parameters: {"clips":[{"input":0,"start":0,"read_offset":0,"gain_db":-10,"fade_in":0,"fade_out":0}],"inserts":[{"effect":"reverb","mix":1,"decay":1.2,"predelay_ms":10,"damping":0.7}]}
reaches: track:main -6.0 dB
cable: receive "drum-verb" ← track:drums, -10.0 dB (tap post), arrives at sample 0
```

Once the inputs are built, each input shows its hash in place of
`(not built)`, and an `action:` line reports the action key and whether
it is cached. Once the label itself is built, an `output:` line gives
the output's hash and size. `--json` prints the whole explanation as
JSON, with the field names of `Explanation` in `src/graph/build.ts`; an
input that is not built yet has an empty `sha256`.

`creek` cannot answer either command on a fresh checkout. Its generated
takes are not committed, so `field query` and `field explain` on
anything that depends on them stop at a message naming the
`field generate` command that fills them.

## Build

`field build <patterns...>` builds labels. Each line says what happened:
`built` ran the work, `cached` returned a stored artifact, `fetched`
downloaded the artifact from the project's remote (see [Share a project
through a remote](#share-a-project-through-a-remote)), and `source` is a
committed file that was never built at all.

```console
$ field build tall-grass
cached  //songs/tall-grass/track:bass → .field/out/songs/tall-grass/track/bass.wav
built   //songs/tall-grass/gen:seven-eight-loop → .field/out/songs/tall-grass/gen/seven-eight-loop.wav
built   //songs/tall-grass/track:seven-eight-loop → .field/out/songs/tall-grass/track/seven-eight-loop.wav
built   //songs/tall-grass/track:drums → .field/out/songs/tall-grass/track/drums.wav
built   //songs/tall-grass/track:room → .field/out/songs/tall-grass/track/room.wav
built   //songs/tall-grass/track:main → .field/out/songs/tall-grass/track/main.wav
```

Outputs live under their content hash and are materialized at
`.field/out/<label>.wav`. Those are addresses for the engine, not names
to hand to anyone — use `field export` for that.

`field build <patterns...> --watch` rebuilds on every settled change
until ctrl-c, and answers "did anything audible change" as an
output-hash question: a fader move re-runs one sum, a comment edit
reports silence.

```console
$ field build tall-grass --watch
cached  //songs/tall-grass/track:bass
cached  //songs/tall-grass/gen:seven-eight-loop
cached  //songs/tall-grass/track:seven-eight-loop
cached  //songs/tall-grass/track:drums
cached  //songs/tall-grass/track:room
cached  //songs/tall-grass/track:main
watching for changes (ctrl-c stops)
· no audible change
↻ //songs/tall-grass/track:main bc412911da7a
```

That session saw two edits to `songs/tall-grass/tracks/main.yaml`: a
changed comment, then the room's `gain_db` moved from `-6` to `-4`.

A project that fails `check` mid-edit — a half-saved file, the common
case — prints its diagnostics, keeps the last good outputs, and retries
on the next change. Unlike a plain build, watch starts fine on a project
that does not currently check.

## Play

`field play <song>` plays the song live in the engine. Clean subgraphs
arrive as cached stems and only dirty ones cost anything, so live
evaluation and playback are the same thing — there is no separate freeze
to manage. Ctrl-c stops.

```console
$ field play tall-grass
live    tall-grass (live)
3.5.295 (0:04.2)
```

The position line is `bar.beat.tick (m:ss.t)`, updating in place.
Playback ends when the song does: a song that declares a `length:` runs
to it, and one that does not runs as long as its material and its tails.

Naming a bare song plays it live. Naming an explicit label — a track, a
gen node, an asset — plays the *built artifact* from disk instead, and
several patterns make a queue played in order. The options work on
both, except `--watch`, which follows a live song only:

| Option | Does |
| --- | --- |
| `--loop` | loops the song at its extent, or replays an artifact queue |
| `--device <name>` | picks an output device; `field devices` lists them |
| `--watch` | follows the project so edits land mid-play (live songs only) |
| `--from <position>` | starts at `bar[.beat[.tick]]` (one target only) |
| `--click` | plays a metronome against the song's tempo map |

`--from` with `--loop` loops a region. On a live song, playback starts
at the position and wraps from the song's extent back to it, so
`field play tall-grass --from 2 --loop` repeats bar 2 to the end. On an
artifact, each pass replays the file from the position. `--click` puts
the metronome in the output only: the engine synthesizes it in the
callback, and it never reaches anything `field build` renders.

`field devices` lists output and input devices, spawning the daemon if
it is not already running:

```console
$ field devices
output:
* MacBook Pro Speakers
  Microsoft Teams Audio
input:
* MacBook Pro Microphone  (1 channel)
  Microsoft Teams Audio  (2 channels)
```

The `*` marks the system default in each list, which is what `field
play` and `field record` use when you name no `--device`. The input
list appears only when the machine has an input device.

### Follow your edits while it plays

`field play <song> --watch` composes watch mode with playback, minus the
wait. Each settled change recompiles the session: a gain move ramps in
on the next block, anything structural swaps the session at a block
boundary with the transport carried, and dirty stems rebuild behind the
play and freeze on the next compile — a swap with nothing to hear,
because live and offline evaluation are bit-identical.

Because `field choose` is only a YAML edit, running it against a playing
watch session is live variant A/B-ing.

## Control the running daemon

`field play` starts the daemon; `field transport` drives it from another
terminal.

```console
$ field transport status
stopped (nothing loaded)
device: MacBook Pro Speakers @ 48000 Hz
daemon: field-audiod 0.14.0
```

| Command | Does |
| --- | --- |
| `field transport status` | state, position, file, device, and every armed track |
| `field transport play` | starts or resumes the transport |
| `field transport pause` | pauses, holding position |
| `field transport stop` | stops the transport |
| `field transport locate <position>` | jumps to `bar[.beat[.tick]]` |
| `field transport quit` | shuts the daemon down |

`quit` is how you pick up a new build: the daemon respawns on the next
`field play`, running the binary you just compiled.

## Open a song in the UI

`field ui <song>` opens a window on a song: the transport, a timeline
with one lane per placement, levels, mute and solo, clip edits, and the
selected track's insert chain. Every gesture in the window ends as an
edit to the project's YAML, which the running session picks up exactly
as it picks up an edit you make in an editor. Solo is the exception: it
changes what you hear and writes nothing. Ctrl-c, or closing the window,
stops the transport and ends the session.

The window is a web client served by `field` itself from `ui/dist`,
which `./install.sh` and `field upgrade cli` build with the CLI. When the
build is missing, `field ui` refuses and names `field upgrade cli`, or on
Windows `pnpm build:ui` in the checkout.

`field ui` prints the URL it serves on, then opens the app window. The
URL carries a token that the server checks, and it serves only
`127.0.0.1`:

```console
$ field ui creek --no-open
field ui: http://127.0.0.1:53581/?t=ec78bbed68e25fb16cfba087facc6f0b
```

| Option | Does |
| --- | --- |
| `--port <port>` | serves on this port instead of a random one |
| `--no-open` | prints the URL and opens nothing |
| `--browser` | opens a browser tab instead of the app window |

The app window is an Electron shell from the `ui/` workspace. When it
is not installed, or exits before its window opens, `field ui` opens a
browser instead and keeps the session running. [ui.md](projects/ui/readme.md)
§6 records what the window does and why.

The app window receives the session URL in its environment, out of
sight of other users. A browser does not: `--browser`, and the fallback
to a browser, hand the URL with its token to `open`, `xdg-open`, or
`start` on the command line, where another user on a shared machine can
read it, and a browser that starts for it can keep it in its own
command line while it runs. Use the app window, or `--no-open` and paste
the URL yourself, where that matters.

## Record a take

`field record <track>` records a performance onto a track that asks for
one. It arms an input on `field-audiod`, records against whatever the
daemon is playing, and loads the track's song as the bed when nothing is
loaded. Ctrl-c stops the take. The command then lands it: the WAV moves
into the song's `audio/` directory, a row in `takes.yaml` beside it
places the take on the track, and the new take is chosen.

A track asks for a performance with a bare `record:` entry. `field
track create tall-grass vocal` makes the track and places it in the
song's `main`; add the entry, and `field check` warns that it has no
takes until you record one:

```yaml
# songs/tall-grass/tracks/vocal.yaml
name: vocal
inputs:
  - record:
```

```sh
field record tall-grass/track:vocal --at 2 --until 3 --count-in 1
```

That command clicks one bar in, records exactly bar 2, lands the take,
and stops.

| Option | Does |
| --- | --- |
| `--device <name>` | picks an input device (default: the system input) |
| `--input <n,...>` | records these channels of the device, counting from 1, one per audio track in the order named (default 1, 2, ...) |
| `--at <position>` | starts the take at `bar[.beat[.tick]]` |
| `--until <position>` | punches out: the take ends on that exact sample |
| `--loop` | loops `--at` to `--until`, landing a take every pass until ctrl-c |
| `--click` | plays a metronome through the take |
| `--count-in <bars>` | clicks this many bars before `--at` |
| `--monitoring <mode>` | how you monitor the take, recorded on its row (default `apollo-direct`); `host` plays each audio input through its track |
| `--console-preset <name>` | records the Console preset the take expects |

`--until` and `--count-in` need `--at`, and `--loop` needs `--until`
and a live song as the bed. Under `--loop`, the last pass is chosen.

With `--monitoring host`, you hear each audio track's input through
that track's inserts, the buses above it, and `main`, from the moment
it arms, count-in included, until the take ends. The take itself is the
dry input; the effects are only what you hear:

```sh
field record tall-grass/track:vocal --monitoring host --at 2 --count-in 1
```

Host monitoring needs the song as a live bed at the device's rate, with
each track it hears reaching `main`: it refuses a file bed, another
song, a device the daemon converts the song for, and a track that a
solo, a muted placement, or the arrangement keeps from `main`. Use
headphones, or a microphone the speakers cannot reach.
With the default, `apollo-direct`, Field plays nothing of the input,
and you monitor in your interface's mixer.

Name several tracks to record them in one pass, audio, MIDI, or both:
every take starts on the same sample and lands on its own track. A
track whose record entry names an instrument records MIDI
([keys.md](keys.md#record-what-you-play)). The audio tracks take
`--input` channels in the order you name them, 1, 2, and on when you
give none; `--loop` records one track only:

```sh
field record tall-grass/track:vocal tall-grass/track:guitar tall-grass/track:keys --input 1,2
```

`field transport status` in another terminal lists every armed track. If
one track's take never arrives while the others land, `field record`
exits with an error that names the track and the `--recover <id>` that
finalizes it.

Every take is a transaction under `.field/recording/` until it lands, so
a crash loses nothing that reached the disk. `field record --list`
shows the transactions, `--recover <id>` finalizes and lands one that a
dead daemon left behind, and `--land <id>` lands a finalized one that
nothing landed. [audio-engine.md](audio-engine.md#crash-safe-recording)
describes the transaction, the click, and punch-out in depth, and
[project-model.md](project-model.md#recorded-takes) describes the entry
and `takes.yaml`.

To play an earlier take instead, choose it by name:

```sh
field choose tall-grass/vocal --take take-20261010-185553
```

## Get a file out

`field export <patterns...>` builds the labels and copies the results to
`~/Desktop` as numbered versions, so the thing you send someone has a
name and a version rather than a hash.

```console
$ field export tall-grass --to /tmp/mixes
exported //songs/tall-grass/track:main → /tmp/mixes/tall-grass-track-main-v1.wav
$ field export tall-grass --to /tmp/mixes
current  //songs/tall-grass/track:main → /tmp/mixes/tall-grass-track-main-v1.wav
$ field export tall-grass --rate 44100 --bit-depth 16 --to /tmp/mixes
exported //songs/tall-grass/track:main → /tmp/mixes/tall-grass-track-main.44100-16-v1.wav
```

The file is named for the label, without the `songs` prefix. A delivery
converted with `--rate` or `--bit-depth` carries both in its name, as
`.44100-16`, and numbers its own versions, so a conversion never bumps
the native export's version.

| Option | Does |
| --- | --- |
| `--to <dir>` | writes somewhere other than `~/Desktop` (must exist) |
| `--rate <hz>` | delivers at this sample rate (default: the source's) |
| `--bit-depth <bits>` | delivers at 16, 24 or 32 (a float source must choose) |

Each line reports one of three outcomes. `exported` wrote a new version,
`current` found the newest version already identical, and `reverted` is
the one to stop on: these bytes match an *older* version, so a change was
undone and the highest-numbered export is not what you just built.

## Share a project through a remote

An audiofield remote hosts a project's Git repository, keeps its audio
in Git LFS, and holds the renders its author already built, so a fresh
clone builds from cache hits instead of rendering. Five commands talk to
it, and [remote.md](remote.md) covers each one in depth:

| Command | Does |
| --- | --- |
| `field login` | logs in with a device code and stores the token |
| `field logout` | forgets the token, revoking it on the remote when it is reachable |
| `field clone <owner>/<project> [dir]` | clones with Git LFS and warms the build cache |
| `field push [git args]` | runs `git push`, then offers the renders this machine holds |
| `field pull [git args]` | runs `git pull`, then warms the build cache for the new `HEAD` |

`login` and `logout` take `--remote <url>` to name a site other than the
project's. `push` and `pull` hand everything after the verb to Git, so
`field push -u origin main` means what `git push -u origin main` means.

A project has a remote when its `origin` is an audiofield Git host, or
when `FIELD_REMOTE` names one. Then `field build`, `field explain`,
`field play` and `field export` ask the remote before they render a
local cache miss, and `build` and `explain` report a hit as `fetched`.
Pass `--no-remote` to skip the remote for one `build` or `explain`.
Watch mode never asks the remote.

## Create and edit

| Command | Does |
| --- | --- |
| `field init` | initialize a project in the current directory |
| `field song create <name>` | create a song with default tempo and meter |
| `field track create <song> <name>` | create a track in a song |
| `field import <file> --song <name>` | copy audio in and record it in `assets.yaml` |

`field init` takes `--name <slug>` and `--sample-rate <hz>`; without
them it uses the directory name and the default rate. `--license <spdx>`
writes the project's license, an SPDX identifier such as `CC-BY-4.0`,
`CC0-1.0`, or `MIT`, into `field.yaml` as `license:`. Without it,
`field.yaml` carries no license. The license speaks for the work the
project's authors made; an imported asset keeps the license it arrived
under. `field check` reports a `license:` that is not an SPDX
identifier.

`field import` records the file's content hash and its WAV facts — rate,
bit depth, channels, frame count — and refuses a WAV whose sample rate
differs from the project's. In a terminal it asks; in a script, pass
`--allow-mismatch` to accept the mismatch deliberately.

```console
$ field import ../rain.wav --song creek
imported rain (audio/rain/rain.wav, 920458 bytes, 48000 Hz 24-bit 2ch, 152727 frames)
sha256 e299cf7c9e0f7481fbb721ecfdadaeb7f824c3451f3825e5a9c5698300ce92a6
```

The path is relative to the song, so the file lands at
`songs/creek/audio/rain/rain.wav` and its row in
`songs/creek/assets.yaml`.

## Generate

Generation is a committed recipe, not a lost session. The workers are
explicit and never automatic:

```console
$ field setup aced
$ field generate creek/still-water-keys --seed 90210 --variants 2
$ field choose creek/still-water-keys --variant 2
```

`field setup [worker]` prepares the worker environments with `uv`; with
no argument it sets up all of them. `--check` reports whether each one
is set up and current, changing nothing, and `--existing` re-syncs only
the ones already set up, which is what `field upgrade` runs. `field
generate <song>/<name>` fills a generative entry — a new name scaffolds
a leaf track — and writes
variants into `songs/<song>/audio/<name>/` with a recipe recording the
model, the seed and the hash of every take. A missing `--seed` draws one
and the output says what it drew, because a seed here is provenance
rather than reproducibility: inference does not reproduce across GPU and
framework versions.

Music generation takes `--prompt`, `--bars` or `--duration`, `--lyrics`
and `--bpm`. Voice takes `--text`, `--voice-ref`, `--exaggeration` and
`--conviction`. Both take `--variants <n>` (1–8, default 2).

`field choose <song>/<name> --variant <n>` repoints which take the label
resolves to. Every placement follows, and in a project that commits its
generated audio that is a one-line Git diff. `--take <name>` does the
same for a recorded take (see [Record a take](#record-a-take)).

## Plugins

| Command | Does |
| --- | --- |
| `field plugins scan` | scan installed AU/VST3 plugins into `.field/plugins.json` |
| `field plugins list` | print the scanned inventory |
| `field plugins pin` | write identities, versions and latency into track files |
| `field insert add <track> [plugin]` | add an insert to a track |

```console
$ field plugins scan
LABS — vst3 9acb4b39 3.0.26 (Spitfire Audio)
scanned: 1 plugin, 0 failed
```

`field plugins pin` takes `--au` or `--vst3` to break a name matching
both formats, and `--update` to accept installed versions over drifted
pins — a deliberate re-render, since the pinned version is a cache input.

`field insert add` with no plugin named opens an incremental-search
chooser in a terminal: type to filter (every whitespace-separated token
must match, so `au delay` narrows to AU delays), arrow keys to move,
Enter to take, Escape to cancel. It then asks where in the chain the
insert goes. Outside a terminal — in a script or an agent — the
interactive halves do not exist: name the plugin, and it lands at the
end of the chain. Use `--at <position>` to place it explicitly and
`--id <handle>` when the chain repeats a plugin.

## Render an SC program directly

`field sc render <program> --seed <n> --duration <seconds>` runs a
SuperCollider program straight to a WAV, uncached, for iteration. The
cached form is a `supercollider:` entry in a track, which the build
graph keys on the program's content hash.

```console
$ field sc render shared/instruments/creek-kit.scd --seed 7801 --duration 3.182
rendered /path/to/creek-kit.wav (seed 7801, 3.182s @ 48000 Hz)
```

`--channels <n>` takes 1 or 2 (default 2), and `--output <path>` writes
somewhere other than `<program>.wav` in the current directory.

## Environment variables

| Variable | Does |
| --- | --- |
| `FIELD_SCLANG` | path to `sclang`, ahead of `PATH` and the installed SuperCollider |
| `FIELD_AUDIOD` | path to the `field-audiod` binary, ahead of the built one |
| `FIELD_REMOTE` | the remote's API base in place of the one `origin` implies, or `off` to stop reading from any remote |
| `FIELD_TOKEN` | the token to send, ahead of the stored one, for CI and agents |
| `FIELD_OFFLINE` | `install.sh` and `field upgrade` download nothing: a checkout compares against the last fetch of its upstream, and a release install's `status` compares nothing |
| `FIELD_REPO`, `FIELD_REF` | the repository and ref a release install follows, `audiofield/field` and `v0` unless set |
| `FIELD_DATA_DIR`, `FIELD_BIN_DIR` | where a release install keeps its versions and its `field` shim; see [install.md](install.md#environment-variables) |

`FIELD_SCLANG` and `FIELD_AUDIOD` point at a binary the default search
does not find. `FIELD_AUDIOD` is resolved to an absolute path
immediately, because the daemon spawns with its working directory at the
project root, where a relative path would mean something else.
`FIELD_TOKEN` is read and never written, and `field login` warns when it
is set. [remote.md](remote.md#which-remote) gives the rules for which
remote a project talks to.

## Platform notes

macOS on Apple Silicon is the reference platform — see [V1 platform
scope](README.md#v1-platform-scope) for what that commits to and what it
does not. Two differences show up at the command line wherever you run.

Plugin formats differ by platform. Audio Units are an Apple format with
no implementation elsewhere, so `field plugins scan` scans VST3 only off
macOS, and a track pinning `au:` cannot render there. VST3 hosting is
unaffected.

`field play` needs `field-audiod`. On macOS, a machine without the built
daemon falls back to `afplay` for plain artifact playback, with no
transport and no options. Off macOS there is no `afplay`, so an unbuilt
daemon is a plain refusal that names the build command: `field upgrade
audiod`, or on Windows `pnpm build:native` in the checkout. The decision
is recorded in
[windows-portability.md](projects/windows-portability/readme.md) §2.2 as
amended. Porting the rest is tracked there and in
[linux-portability.md](projects/linux-portability/readme.md).

## Command reference

| Command | Does |
| --- | --- |
| `field --version` | the CLI build, the remote, and which build each daemon runs |
| `field init` | initialize a project in the current directory |
| `field check` | validate schemas, references, assets, formatting |
| `field fmt` | rewrite project files to canonical formatting |
| `field status` | summarize the project |
| `field arrangement <song>` | the song's derived timeline |
| `field query <expr>` | query the graph: a pattern, or `deps(...)` |
| `field explain <label>` | type, inputs, action key, cache status, levels |
| `field build <patterns...>` | build labels; `--watch` to follow changes |
| `field export <patterns...>` | build and deliver numbered versions |
| `field play <patterns...>` | play a song live, or audition artifacts |
| `field devices` | list output and input devices |
| `field transport <op>` | drive the running daemon |
| `field ui <song>` | open a song in the UI window, served on `127.0.0.1` |
| `field record <tracks...>` | record a take onto each track's `record:` entry, in one pass |
| `field keys [targets...]` | play the keyboard as a MIDI source, and instruments or MIDI tracks from it |
| `field login` | log in to a remote and store the token |
| `field logout` | forget the stored token |
| `field clone <owner>/<project> [dir]` | clone a project and warm the build cache |
| `field push [git args]` | `git push`, then offer the renders this machine holds |
| `field pull [git args]` | `git pull`, then warm the build cache |
| `field song create <name>` | create a song |
| `field track create <song> <name>` | create a track |
| `field import <file> --song <name>` | import audio and record it |
| `field insert add <track> [plugin]` | add an insert to a track |
| `field plugins scan\|list\|pin` | the hosted plugin inventory |
| `field setup [worker]` | set up generation worker environments; `--check` reports, `--existing` re-syncs |
| `field upgrade [target]` | run the installer from anywhere: a checkout's own `install.sh`, or the newest release's, with `all`, `cli`, `audiod`, `workers`, or `status` |
| `field uninstall` | remove field: a release install's versions and shim, or a checkout's pnpm link, leaving the checkout itself |
| `field generate <song>/<name>` | run a deliberate generator |
| `field choose <song>/<name> --variant <n>` | repoint which generated take plays |
| `field choose <song>/<name> --take <name>` | repoint which recorded take plays |
| `field sc render <program>` | render an SC program directly, uncached |

Every command takes `--help`.
