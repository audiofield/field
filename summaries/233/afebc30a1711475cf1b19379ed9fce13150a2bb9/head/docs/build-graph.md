# Build graph

Field treats a project as an explicit dependency graph, Bazel-style:
labels, dependencies, content-addressed outputs, incremental rebuilds,
cached outputs, and queries — without Bazel syntax or its vocabulary
(project-layout.md §4: the format speaks tracks, entries, and inserts;
the engine speaks nodes, generators, and action keys).

```bash
field build //songs/opener/track:main
field build opener/...
field export opener/track:main
field query 'deps(opener/track:main)'
field explain opener/track:main
```

Labels address songs and shared material alike: an entry in one song
plays `//shared/asset:rain` exactly as it plays the song's own audio.

The absolute form is canonical, but the CLI accepts songs-relative
shorthand for all of the above — `field build opener/track:main`,
`field explain opener/...` — and a bare song name means the song's
output track: `field play opener` is `//songs/opener/track:main`
(project-core.md §3.4, amended 2026-08-08; `main` is a convention, and a
song with no track by that name gets a no-such-label error).
`//shared/...` material uses the full form.

## Caching, and freezing is caching

The cache key for a node's output is the hash of its inputs: input asset
hashes, plugin ID and version, serialized state, parameters, automation,
and render-relevant settings. Same inputs → cached artifact returned,
zero renders.

There is no separate freeze machinery. **A frozen track is a cached
intermediate output**; invalidate the cache (change a parameter) and it
is unfrozen automatically. A bounce is a cached output given a name.
Outputs are stored under their content hash, so a rebuild never
overwrites an old render — it produces a new artifact and moves a
pointer.

### The remote as a second cache

When a project has an audiofield remote, a local miss asks the remote
for the action key before the rule runs, and a hit lands in the same
CAS and index as a local render would, verified against the entry's
hash on the way in. The build reports it as `fetched`. Every failure
falls through to the render; a build never uploads. `field clone`
warms the cache the same way for every song's `main` and the nodes
beneath it, so the first build on a fresh clone is hits all the way
down. See [remote.md](remote.md).

### Watch mode

The cache is what makes watching cheap
([watch.md](projects/watch/readme.md)). `field build --watch <label>`
rebuilds on every settled change and answers "did anything audible
change" as an output-hash question: a fader move re-runs one sum, and a
comment edit or `field fmt` pass is all cache hits and reports silence.
`check` gates every rebuild, so a red project (a half-saved file
mid-edit — the common case) keeps its last good outputs and retries on
the next change.

`field play <song> --watch` composes the same loop with playback, minus
the wait: each settled change recompiles the song's live session, a
gain move ramps in the next block, and anything structural swaps the
session at a block boundary with the transport carried — no wrap to
wait for (realtime.md chunk 3). The compile is where the cache pays
twice (realtime.md decision 4): a track whose stem action is cached is
served as that stem — automatic freezing, no live chain to run, except
for a track carrying a live input and every track above it, which keep
their chains for the input ([audio-engine.md](audio-engine.md) "Live
inputs") — and
under watch the dirty stems rebuild behind the play and freeze on the
next compile, a swap with nothing to hear because live and offline are
bit-identical. The compile still runs `build` for the session's file
sources, and build never runs a generative request — but a `chosen:`
repoint is just a YAML edit, so `field choose` against a running watch
is live variant A/B-ing mid-play.

### Getting a file out

Outputs live under their content hash, materialized at
`.field/out/<label>.wav` — addresses for the engine, not names anyone
wants in a Finder window or an email. `field export <patterns>` builds
and then copies the result to `~/Desktop` (or `--to <dir>`) under the
label with its punctuation flattened, minus the `songs/` prefix:

```console
$ field export creek
exported //songs/creek/track:main → ~/Desktop/creek-track-main-v1.wav
```

Shared material keeps its shelf (`shared-asset-water-v1.wav`). Export
ships what `play` would play, through the same resolver, and only the
labels the patterns match — the dependencies a build prints are means,
not products.

The name is long deliberately. A short form (`creek-main`) reads better
until a song has a track and a gen node of the same name — which every
generative leaf has by construction — at which point two different files
want one name. A name that is sometimes scoped is worse than one that
always is: you cannot predict the file you are about to get.

**Delivery formatting belongs to export** (multi-rate.md decision 1):

- `--rate` and `--bit-depth` convert on the way out through the daemon's
  normalize op — never as a node in the song — writing integer PCM at
  the chosen depth.
- A flag left off defaults to the source's own value where it has one. A
  float source (everything Field renders) has no integer depth of its
  own, so `--rate` alone on a stem refuses and asks for `--bit-depth`.
- The effective pair joins the name after a dot
  (`creek-track-main.44100-16-v1.wav`) — a character no label can
  carry — so a converted family never versions an unconverted one, nor a
  label that happens to end in digits. A CD deliverable is an
  invocation, not a node in the song.

**Exports are versioned, never overwritten.** Finishing something and
putting it somewhere is how people mark a version, and the previous one
is often the only copy of a decision later undone:

- A second export is `-v2`, numbered from the highest already there. A
  gap means someone threw that version away, and minting a second `-v2`
  would disagree with them.
- Re-exporting something unchanged is a no-op: the bytes are compared
  against *every* version present, newest first, and the command reports
  `current` naming the version that stands.
- When the match is an older version — export v1, change something,
  export v2, change it back — it reports `reverted` and names both
  numbers, because the newest file in the directory is then no longer
  what you just built.

Nothing Field does removes or overwrites a file in the destination,
including files it did not write. The copy lands on a temp name and is
linked into place, so an interrupted export leaves debris rather than a
truncated version, and a name that merely differs in case cannot be
written through on a case-insensitive volume — the link fails and the
next number is taken.

A committed source whose bytes have drifted from their declared hash is
refused outright — the same guard `build` applies before consuming an
asset as an input. Export is the command whose product leaves the
machine, so it must not ship audio the project does not describe.

## Render strategies

How a node's output can be produced is a declared, per-node property:

- **`offline`** — renderable faster than realtime. Native AUs, SC
  non-realtime mode, most UAD-2 plugins (UAD-2 supports
  faster-than-realtime bounce, capped by DSP headroom).
- **`realtime-bounce`** — renderable only at 1×: Field plays through the
  graph and captures the result. The universal escape hatch — anything
  audible is freezable at 1×. Used for plugins that can't render offline
  and for external instruments (below).
- **`live-only`** — not renderable at all, because the node's output is
  not a pure function of the timeline: a live microphone input, a
  monitoring chain, a SuperCollider node played by hand, MIDI sent to an
  external device with no declared return. There is no answer to "what
  does this node output at bar 42," so there is nothing to cache. A mix
  depending on a live-only node fails the build with a clear error:
  *this output doesn't exist until someone performs it — capture it
  first.* A capture of a live-only node's output is a take, and
  re-enters the buildable world.

**External instruments** graduate from live-only to realtime-bounce by
declaring an audio return path ("this device's output returns on Apollo
inputs 3–4"): Field plays the MIDI at 1×, captures the return, and
caches it like any other render — flagged nondeterministic, because
knobs on hardware are outside the hash.

## Node types and their generators

Every automatic type has a `Generator` in `src/generators/` — the code
that generates it mechanically, in-graph, cached. The `generative` kind
has none: its generation is human-triggered (`field generate`), its
variants are committed under `audio/<name>/`, named by the gen node —
and its label resolves to the chosen variant (`field choose` repoints
it; every placement follows). A `record:` entry that records audio has
no node of its own either: before a track is planned, the graph
replaces the entry with a window over its chosen take's ledger asset,
placed where the take's row says it was sung, or with nothing when no
take is chosen (`withTakes` in `src/graph/graph.ts`). Nothing after
that point knows recording exists. An entry that records MIDI places
its take's render instead, a `voice-render` node (below). A `notes:`
entry mints a `voice-render` node too, which the stem places like any
generator's.

### `stem` — every track, implicitly

Every track is buildable as `//songs/<song>/track:<name>` without
declaring anything, an empty one rendering as the silence it contains,
because the track file **is** the declaration. What a track file says —
entry kinds, placement, nesting, levels, local time and rate, sends — is
[tracks.md](tracks.md); this section is how the graph renders one.

The stem places its entries through the tempo map (`at`, source offset,
slip, entry gain and pan, linear fades) and sums them into a pre-fader
Float32 stereo stem in the render daemon
([projects/mix-assembly/readme.md](projects/mix-assembly/readme.md) §1).
A muted entry (`mute: true`) is left out before planning, so it is
absent from the stem's spec, its action key, and its dependencies, and a
cable whose every sender placement is muted carries nothing
(`src/model/cables.ts`). A placed track is one more source in the same
list, so a track→track edge is an ordinary graph edge, and a track
placed three times is one render placed three times. The song's output
track additionally renders the song's declared `length`, with `loop:`
folding the overhang back onto the start.

The action key hashes the *resolved placement plan* in samples, not the
raw YAML:

- A tempo edit rebuilds exactly the tracks whose musical entries moved.
- Reordering entries in the file changes nothing.
- Entry spelling is wiring — a ref changing kind cannot re-key a parent
  whose children are byte-identical.
- The cache key sees the plan but not the level applied above it, so
  mixing decisions never invalidate rendered stems.

Cables join the plan the same way (nested-tracks.md §19): a receive
consumes the sender's stem — or, for `tap: pre`, an implicit `tap:`
node, the sender's plan minus its inserts, shared by every pre cable
from that sender — as ordinary clips at the derived arrivals, converted
at the edge like any source. The receive re-keys on sender content,
gain, tap and arrivals, and on nothing else: a send-level tweak
re-renders the receiver and whatever consumes it, never the sender.

An entry's `loop:` map tiles its source to fill the window
([projects/clip-looping/readme.md](projects/clip-looping/readme.md)):
repetitions expand into ordinary placement-plan entries — grid-locked
via `loop.every`, cut or rung-out per `loop.mode`, seams click-guarded
by `loop.fade` — so the renderer and action-key format don't know loops
exist, and a loop hashes identically to its hand-tiled equivalent.

### `resample` — minted at rate edges

The one type nobody can declare: when a source arrives at a placement at
a rate other than its track's, the graph mints
`//songs/<song>/convert:<name>-<rate>` between them (multi-rate.md
decision 4) — one node per (source, rate) however many placements
consume it, visible in `explain` and `deps()` like any rule.

It runs the daemon's polyphase resampler (render-pipeline.md decision 9,
the same one `--rate` exports through) and writes float32 undithered,
because it sits between two float stages — quantization is a delivery
choice, made at export. The conversion is automatic but never invisible:
it is a node you can ask about.

### `supercollider`

A SuperCollider program defines the sound, rendered offline via
scsynth's NRT mode. `source:` names the program — a bare filename
resolves in `shared/instruments/`, a slashed path is project-relative.

The program is a plain `.scd` run through `sclang` with `FIELD_OUTPUT` /
`FIELD_SEED` / `FIELD_DURATION` / `FIELD_SAMPLE_RATE` / `FIELD_CHANNELS`
in the environment; it writes `FIELD_OUTPUT` and exits. The program's
*content hash* is a cache input, so editing the code invalidates exactly
its own renders; with a fixed seed, renders are reproducible
bit-for-bit. `field sc render` runs a program directly (uncached) for
iteration. Full contract:
[projects/sc-render/readme.md](projects/sc-render/readme.md) §2 (the plan
predates the §4 rename).

The same program can also be played from notes. When `FIELD_MODE` is
`voice`, it must not render or exit, and its value — the file's last
expression — is a SynthDef with `freq`, `amp`, `gate`, and `out`
controls that frees itself after `gate` goes to 0. It may also have a
`mod` control, which the modulation wheel sets, and a `cc<n>` control
for any controller n from 2 to 119 but the sustain pedal, each from 0
to 1. When the instrument has a knob file beside it (`juno.knobs.yaml`
for `juno.scd`), `FIELD_KNOBS` names a copy of it that passed Field's
check, so the voice can map its controls through the knobs' ranges.
`field keys <instrument>` plays that voice live; the render variables
are absent in voice mode, so a program checks `FIELD_MODE` before
reading them. A `supercollider:` entry never runs in voice mode, so
voice mode changes its renders only through the program's own content
hash. See [keys.md](keys.md).

### `voice-render` — notes, rendered through an instrument

The graph mints one for each `notes:` entry, and for each record entry
whose chosen take is a MIDI take, at `//songs/<song>/gen:<name>` where
`<name>` is the entry's generator name (keyboard-instrument.md §12.3,
sequencer.md §2.3). It plays through the track's `instrument:`. Nobody
declares it. The track places a part's render in the entry's window, as
any generator's, and a take's render where the take starts. A looping
part resolves each repetition where the repetition starts, and a
repetition that resolves differently from every one before it, after a
tempo or meter change, gets a node of its own, `gen:<name>-<n>`, named
for its number `<n>`. Repetitions that resolve alike play one node
(`partRenders` in `src/generators/stem.ts`).

It runs `sc/voice-render.scd` through `sclang`, which loads the
instrument in voice mode with `sc/voice-load.scd`, as `field keys` loads
it, and drives its voice from the notes with `sc/voicer.scd`, the
voicing `field keys` plays with. Sustain, all-notes-off, pitch bend (±2
semitones), the modulation wheel, and every other controller act as
they did live. The render is stereo at the track's rate and runs 4
seconds past the notes' end, so the last notes' release is heard;
scsynth rounds it up to a whole control block, as it does every NRT
render.

Its parameters are the instrument and `events`: the notes resolved
through the track's tempo and meter maps from where they are placed, in
samples from that point (`src/time/notes.ts`). Its cache inputs are the
notes file, the instrument's content hash, its knob file's when it has
one, and the three harness files. So editing a note, the tempo map, or
any input renders it again, and a second placement that resolves alike
is a cache hit, because the events count from the placement rather than
from the song's start. A take is a source node, so the build refuses
one whose pinned bytes changed; a part is hashed in place. A take
copied into a part and placed where the take starts has the take's
action key. The render checks the knob file as `field keys` does, so
`field check` and the build name a file that fails before anything
renders, and it hands the voice the checked copy in `FIELD_KNOBS`. The
harness adds nothing random, so an instrument that renders reproducibly
renders its notes reproducibly, bit for bit.

### `eq` / `limit` / `reverb` / `plate` / `hall` — the offline effects

From [projects/effects/readme.md](projects/effects/readme.md): Fyra's
auto-normalizing EQ (RBJ biquads, bandwidth in octaves, response-based
compensation on by default — tone changes, level doesn't), an offline
lookahead limiter with a hard ceiling guarantee, and a deterministic
Freeverb whose output grows by its tail. The reverbs pair joined from
[projects/reverbs/readme.md](projects/reverbs/readme.md): `plate`, Dattorro's
figure-8 tank, and `hall`, a Jot FDN with per-band decay — both
deterministic including their modulated tails, growing by their tails
the same way (the hall by its longest band's).

They run as `inserts:` — baked into the stem, with the master chain on
the song's output track — and chains are wrapper tracks placing wrapper
tracks, cached per link: a track wrapped in an effect is a different
track. `field check` names containment cycles.

**Hosted plugins** join the same chains as `plugin:` entries
([projects/plugin-hosting/readme.md](projects/plugin-hosting/readme.md)).
The action key hashes the keyed spelling, computable from the
repository alone: exact identity and pinned version (never the display
name), the authored params canonicalized by name, the *full* state-blob
hash, the declared `tail:` and `latency:`, and the track's resolved
transport — tempo-synced plugins read a playhead both render paths
supply identically, so a tempo edit re-renders a tempo-synced chain.
Machine-local facts (install paths, blob file paths) join the plan only
at execute time. The daemon instantiates in the `--render` subprocess,
restores the blob then overlays params, processes at a fixed 512-sample
block (third-party code owes no block-size invariance; determinism
comes from never varying the recipe), trims declared latency, and rings
an undeclared tail out to −60 dBFS under a hard cap. A machine without
the plugin serves cached stems — the version gate sits at
instantiation, never at cache lookup — and a rebuild fails at the node
naming the plugin, format, identity and version.

## Determinism policy

**The contract is recipe-reproducibility, not bit-reproducibility.**
Plugin renders are not bit-identical across runs (modeled analog noise,
dither, floating-point scheduling) but sound the same; the build system
never re-renders unchanged inputs, so nondeterminism only surfaces on
deliberate cold rebuilds. Seeded SC renders are deterministic; ACE with
a fixed seed is reproducible on the same machine but not guaranteed
across GPU/framework versions — which is why generative requests commit
their takes, never regenerating mechanically.

Nodes that can differ *audibly* between renders are flagged
**nondeterministic**, in three tiers:

1. Plugins with tempo-sync/retrigger LFO modes: Field prefers those
   modes and stores phase/offset as an explicit parameter —
   deterministic.
2. Free-running LFOs with an exposed rate/phase parameter: a per-plugin
   registry of known parameter mappings pins what's pinnable.
3. Truly free-running (some vintage emulations, deliberately): flagged
   in `field explain`; renders are handled as takes.

**Renders of nondeterministic nodes are takes** (see
[project-model.md](project-model.md)): numbered, auditioned, one active.
A rebuild that would replace the active render of a nondeterministic
node prompts first — or, in non-interactive/agent mode, auto-pins the
outgoing artifact so nothing is ever silently lost. Pinning is a named,
GC-immune reference to a content-addressed artifact — cheap, and
reversible: repoint to any retained take.
