# Field

Field is a Mac-first, Git-native music production system designed so
entire music projects are operable by both humans and coding agents. A
song is a repository: every piece of production state — arrangement,
tempo, takes, effect chains, synthesis programs, generation recipes,
mixes — is schema-validated YAML, every meaningful action is a CLI
command, and audio is produced by an explicit dependency graph with
content-addressed caching.

The closest analogy: **Bazel for music production**, growing toward a
real-time recording runtime and an agent-native control layer.

## What that looks like

A track is a YAML file. This one plays a generated electric-piano
phrase and sends it to a shared reverb:

```yaml
# songs/creek/tracks/keys.yaml (abridged)
name: keys
sends:
  keys-verb:
    gain_db: -14
inputs:
  - track: still-water-keys
    at: [1]
    duration: [4]
```

The song's structure is tracks placing tracks — creek is three passes
of a four-bar phrase, and the file says so:

```yaml
# songs/creek/tracks/main.yaml (abridged)
name: main
inputs:
  - track: phrase
    at: [1]
  - track: phrase
    at: [5]
  - track: phrase
    at: [9]
```

Everything is buildable, and everything explains itself. The reverb
return hears the keys once per pass — Field derives the arrival times
from the tree, and refuses wirings where they would be ambiguous:

```console
$ field explain creek/track:space
...
reaches: track:main -3.0 dB
cable: receive "keys-verb" ← track:keys, -14.0 dB (tap post), 3 arrivals at samples 0, 480000, 960000
cable: receive "vocal-verb" ← track:lead-vocal, -10.0 dB (tap post), arrives at sample 0
```

Edits rebuild exactly what they change. Nudge that send from `-14` to
`-13` and `field build creek` re-renders `space` and `main` — every
other stem is a cache hit, and the sender never re-renders. A fader
move re-runs one sum. A comment edit rebuilds nothing. Freezing *is*
caching: there is no separate freeze machinery to manage.

Generation is a committed recipe, not a lost session. A seeded
SuperCollider program rebuilds bit-for-bit under the same SuperCollider
toolchain (the program's content hash is a cache input; your sclang
install is not); a model request (ACE-Step music, Chatterbox voice)
records its takes with full provenance — model, seed, hash — and
`field choose` repoints which take the song plays by moving one line in
that record. In a project that commits its generated audio, that is a
one-line Git diff — bloom deliberately doesn't: the recipes ship, and
every clone generates its own takes:

```console
$ field generate creek/still-water-keys --seed 90210 --variants 2
$ field choose creek/still-water-keys --variant 2
$ field play creek
```

And because it is all text, `git diff` is the session history, `git
revert` undoes a mix decision, and a coding agent can read, edit,
build, and audition a project with no DAW in the loop.

## Try it

You need Node 24 (the version in [`.nvmrc`](.nvmrc)), pnpm — never npm
or yarn — CMake 3.24 or newer with a C++ compiler (Xcode's command line
tools on macOS), and [SuperCollider](https://supercollider.github.io/):
every render in the example project is an SC recipe, and `field build`
runs `sclang` from your PATH, the macOS app bundle, or `FIELD_SCLANG`.

Install the newest release:

```sh
curl -fsSL https://field.one/install.sh | bash
```

The installer downloads the release's source, builds it in
`~/.local/share/field/<version>/`, builds `field-audiod`, the playback
and render daemon, and puts a `field` command in `~/.local/bin`. Field
publishes no binaries, so every install builds from source; the first
compiles JUCE, which takes a few minutes. To move to the next release,
from anywhere:

```sh
field upgrade            # installs the newest release
field upgrade status     # what is installed, and what is out of date
field uninstall          # removes it; curl -fsSL https://field.one/uninstall.sh | bash does too
```

To work on Field itself, install a checkout instead. Run `pnpm setup`
once, then:

```sh
git clone https://github.com/audiofield/field
cd field
./install.sh             # links this checkout onto your PATH as field
```

A checkout install is a link, not a copy: `field` runs whatever the
checkout last built, and `field upgrade` rebuilds the checkout as it
stands after you pull. [docs/install.md](docs/install.md) describes
both kinds of install, each step, and each status row, and gives the
steps by hand for Windows, where the installer does not run yet. To run
from source without installing: `pnpm field <args>`.

Then open the example project — two songs that exercise most of the
system, checked by CI on every change:

```sh
cd examples/bloom
field check                                            # validates everything
field build tall-grass && field play tall-grass        # SC recipes only, no models needed
field generate creek/still-water-keys --seed 90210 --variants 2
field generate creek/lead-take --seed 4823 --variants 3
field build creek && field play creek                  # the full song
field arrangement creek                                # the derived timeline
```

The two `generate` steps need the model workers (`field setup aced`,
`field setup voiced` — explicit, never automatic); everything else runs
from SuperCollider recipes alone. See the
[bloom README](examples/bloom/README.md) for the guided tour.

### The audio daemon

`field-audiod` is a separate native binary (CMake and JUCE), built by
`./install.sh` or `field upgrade audiod`. Build it before playing **or
building** anything:
the daemon is also the renderer — `eq`, `limit` and `reverb` targets
render by spawning it, so `field build` fails without it rather than
falling back to anything.

Without it `field play` falls back to `afplay`, `field devices` fails,
and the options that need a real-time transport — `--from`, `--device`,
`--loop`, `--click`, `--watch` — refuse to run rather than pretending.

The CLI looks for the binary inside the checkout it was linked from, so
one build serves every project directory. `FIELD_AUDIOD` overrides that
path. It builds on macOS and Linux, and CI builds it on both.

### Playing the keyboard

`field keys` turns the computer keyboard into the MIDI source `Field
Keys`, which Logic or any other MIDI application can play from. It
needs `field-audiod` and a terminal that reports key releases through
the kitty keyboard protocol: Ghostty, iTerm2 3.5 or later, kitty, or
WezTerm. Keys are read by physical position, so Dvorak, AZERTY, and
other layouts play the same notes, and a keymap of your own is a YAML
file away. Name an instrument, as in `field keys juno` inside
`examples/bloom`, and it plays that SuperCollider instrument live too.
The arrows choose and turn its knobs, such as `juno`'s filter cutoff,
and the number row types a value they glide to. Each knob is a MIDI
controller, so a take you record keeps every turn. See
[docs/keys.md](docs/keys.md).

## Status

The offline half is real and in daily use: nested tracks, per-track
tempo/meter and sample rates with automatic edge conversion, sends with
derived arrivals, seeded SuperCollider rendering, deliberate music and
voice generation, watch mode with live variant A/B-ing, versioned
export, and a native playback daemon with a sample-accurate transport.

Recording, monitoring, and plugin hosting are next — the real-time
engine's settled decisions are in
[docs/audio-engine.md](docs/audio-engine.md), and the current build
order is in [docs/projects/](docs/projects/README.md). An MCP surface
exposing the CLI's verbs to agents is planned.

## Documentation

Start at [docs/](docs/README.md) — the thesis and core concepts, with
the index to the rest: architecture, tracks, the project model, the
build graph, and the audio engine.

## License

Field's code is licensed under the [MIT License](LICENSE).

The audio daemon, `field-audiod`, links two third-party codebases that
carry their own terms:

- **[JUCE](https://juce.com)**, licensed under AGPLv3 or a commercial
  JUCE license.
- **Steinberg's VST3 SDK**, compiled in so the daemon can host VST3
  plugins. JUCE 8.0.4, the version the daemon pins, bundles it under
  GPLv3 or Steinberg's proprietary VST3 license.

FieldOut, the SuperCollider server plugin in `native/sc-fieldout/` that
carries `field keys`' voice into the daemon, is licensed under
GPL-3.0-or-later ([its LICENSE](native/sc-fieldout/LICENSE)), because it
builds against SuperCollider's plugin interface, whose headers are
vendored beside it from SuperCollider 3.14.1. It runs inside `scsynth`,
not in Field's processes, and shares only an MIT header describing the
shared-memory ring with the rest of Field.

A commercial JUCE license does not cover the VST3 SDK. Unless you hold
both a commercial JUCE license and Steinberg's proprietary VST3
license, a `field-audiod` binary you build or distribute is under
copyleft terms: AGPLv3 for JUCE and GPLv3 for the VST3 SDK, so anyone
who receives it is entitled to its source.
