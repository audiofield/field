# bloom

A sample Field project — an album-shaped workspace you can read, diff, and
(with the Field CLI) validate and edit. It lives here, inside the Field
repository, so that CI runs `field check` against it: a change that breaks the
format now fails in the pull request that makes it rather than the next time
somebody opens this directory.

Field is a Git-native music production system designed so that entire projects
are operable by both humans and coding agents: every piece of production state
is schema-validated YAML, every meaningful action is a CLI command, and audio
is produced through an explicit build graph. This directory is what a Field
project looks like on disk.

**No audio is committed here.** Every sound in bloom is a recipe, and the ones
a machine cannot reproduce are simply empty until you fill them — so the first
thing this example asks of you is to generate its vocal and its keys, and the
bloom you end up with is nobody else's. See [Generating](#generating) below;
that is the point of the example rather than a limitation of it.

## What's here

- `field.yaml` — the project manifest (a project holds many songs; think album)
- `songs/creek/` — a declared 12-bar loop at a flat 96, an arrangement,
  and a band that exists almost entirely as recipes: a pad and a kit as
  seeded SuperCollider programs, a lead vocal generated from text by a
  local model (placements reference **tracks**, not files), the vocal
  clipped into the arrangement, a shared reverb (`space`) fed by cables
  from two depths of the tree, and a `main` track that sums it all with
  a fader on every placement
- `songs/tall-grass/` — 7/8 at 132 BPM, a SuperCollider percussion loop
  placed with `slip` to drag the groove late against the grid, and a
  drum room fed by a send — the smallest possible cable: one sender,
  one fully wet return, placed in `main` like any other track
- `shared/` — three shelves shared across songs: `instruments/` (the
  SuperCollider programs), `samples/`, and `plugins/`. The sample shelf is
  empty here, because nothing recorded is committed; `field import` is what
  puts something on it, and writes the ledger that pins it

A **ledger** binds every committed audio file to a readable name and its
SHA-256, and `field check` verifies content against the recorded hashes —
`shared/assets.yaml` for the shared scope, `songs/<song>/assets.yaml` for a
song's own. bloom carries neither, because it commits no audio; import
anything and one appears.

The distinction the format turns on is which sounds a machine can reproduce.
A seeded SuperCollider program is a promise the build can keep: creek's pad
and beat, and tall-grass's 7/8 groove, are code and a seed, and the build
renders them on demand, byte for byte, every time. Model inference is not
that promise — it does not reproduce across GPU and framework versions — so a
generated sound records what it *did*: the prompt, and per take the model,
seed, hash and time. Provenance instead of reproducibility.

A recipe holds only the request. What a run produced and which take you kept
live in `audio/<name>/variants.yaml`, beside the WAVs they pin — because
those are facts about *your* machine, and a recipe is what everybody shares.
That split is what lets this example ship: generating and choosing here leave
every committed file untouched, so following the instructions below does not
put your checkout into a diff.

Times are authored in musical notation — `[bar]`, `[bar, beat]`,
`[bar, beat, tick]` — resolved through the song's meter map at load, so
`at: [4, 4]` is "one beat before bar 5". Underneath they are integer
ticks at 960 per quarter note, and `bar.beat.tick` (like `13.1.1`) is how
the CLI displays them. The comments in the YAML files survive
`field fmt` — formatting is canonical, but your annotations are yours.

## Playing with it

```bash
git clone https://github.com/audiofield/field
cd field && nvm use && ./install.sh   # the field command and its daemon (needs CMake + Xcode CLT)

cd examples/bloom
field status
field check          # schemas, identity rules, tempo maps, references, formatting
field song create fence-line
field track create fence-line banjo
```

`field check` passes on a fresh clone even though creek has no audio yet: the
project is coherent, the takes are simply absent. That is `check`'s question —
is this project well-formed — and it is `build` and `play` that ask whether
this machine is ready, and say which command would make it so.

Shuffle some keys in a track file and run `field check` (it will object) and
`field fmt` (it will fix it, keeping your comments). Change a meter event to
land off a bar boundary and watch `check` catch it.

## Generating

tall-grass builds on a fresh clone — everything in it is a SuperCollider
recipe, so there is nothing to fill:

```bash
field build tall-grass
```

creek does not, and says why:

```text
//songs/creek/gen:lead-take has no takes yet

# Use this command to generate. Specify a seed with --seed <n>
field generate creek/lead-take
```

Two of creek's parts are model-generated, and neither ships with audio.
Both are `generative:` entries — leaf tracks whose one input *is* the
request: the keys a prompt, the vocal a line and its delivery — and you
supply the run:

```bash
field generate creek/still-water-keys --seed 90210 --variants 2
field generate creek/lead-take --seed 4823 --variants 3
field build creek
```

Each writes `songs/creek/audio/<name>/variants.yaml` and chooses the first
take, so the name resolves immediately. The file carrying the request is not
touched — run `git status` afterwards and it is clean. Note what is *not*
passed: no `--prompt`, no `--text`. The file already says what to generate,
and a flag repeating it is refused as a second answer.

Then audition the takes and change your mind:

```bash
field play //songs/creek/gen:lead-take-1
field play //songs/creek/gen:lead-take-2
field choose creek/lead-take --variant 2
```

`choose` moves what the *gen node* means, so every placement follows in a
one-line diff — nothing is copied and nothing is re-imported. Those takes are yours:
generation does not reproduce across GPU and framework versions, so your
creek is not this creek, and the repository never claims otherwise.

The takes and the WAVs both land under `songs/creek/audio/` and are
git-ignored by one rule, because the pins and the bytes they pin are the same
commit decision — a project that *does* commit its audio commits both, and
gets provenance `field check` can verify. If you want your takes back
exactly, keep the seeds; but the honest answer is that model generation does
not reproduce, so you regenerate and pick again.

## Building

A song's renders are declared where they play — a track file implies a
stem, an inline generator mints its own `gen:` node — and the project
itself is the build graph: targets derive from the files by convention,
Bazel-style:

```bash
field build //songs/...                        # everything
field build //songs/creek/track:lead-vocal     # one stem
field query 'deps(//songs/creek/track:lead-vocal)'
field explain //songs/creek/convert:gen-lead-take-48000
```

The chosen take is 24 kHz mono — Chatterbox's own rate, no project's — so
the placement edge mints a conversion at the song's 48 kHz automatically
(multi-rate.md decision 4); nothing in the project spells it. The first
build runs it in the daemon and materializes output under `.field/out/`;
the second is an action-cache hit that executes nothing. `explain` shows
the node the edge implied, like any other:

```text
//songs/creek/convert:gen-lead-take-48000 (rule)
type: resample v1
input: //songs/creek/gen:lead-take 180d928010e2
parameters: {"sample_rate":48000}
action: 0f0e2880191f (cached)
output: 4a95681045f8 (599098 bytes)
```

The cache key is the hash of the rule, its version, the input content
hashes, the parameters, and the rate the node renders at — choose a
different take (a one-line diff in your takes file) and only this
conversion and the stems that play it rebuild. `.field/` is local state
and never committed; clone this repo, build it, and you get the same
outputs from the same recipe.

## Listening

`field play` builds whatever needs building, then auditions the results in
order (ctrl-c stops the queue):

```bash
field play //songs/creek/track:pad-sc           # render the pad recipe, then hear it
field play //songs/creek/gen:lead-take-2        # audition a take you generated
field play //songs/tall-grass/track:seven-eight-loop  # the 7/8 groove, rendered
field play //songs/creek/track:all              # every stem in creek, in order
field play //songs/...                          # everything in the project
```

Play something twice and the second run starts instantly — same
content-addressed cache as `field build`. And the arrangement itself is
playable, because a song's output is just another track:

```bash
field play creek     # the bare song name is its output track
```

With the native daemon built (`field upgrade audiod` builds it),
playback runs through `field-audiod` — Field's own Core Audio process,
spawned on demand, one per project — and the terminal shows a live
position readout in musical time (`5.2.1 (0:12.3)`). That unlocks the
transport:

```bash
field devices                                 # list outputs (* = default)
field play creek --from 5.1.1                 # start at the verse
field play creek --device "Volt 476"

# …and from any other terminal, while it plays:
field transport status                        # playing  5.3.1 (0:11.3) + file + device
field transport locate 7.1.1                  # jump to bar 7
field transport stop
```

Bar.beat.tick is projected through the song's tempo map by the CLI — the
daemon only ever hears sample positions. Without the daemon binary,
`field play` quietly falls back to `afplay` (no transport, no `--from`).

## Mixing

A song's output is the track named `main`, which is what the bare song name
resolves to; every audio track is a stem target, and a track sums the tracks
it places, applying each placement's `gain_db` and `pan`. There is nothing
special about the mix but its name — an alternate cut is just another track:

```bash
field build //songs/creek/track:pad           # one pre-fader stem
field build creek                             # everything, summed
field play //songs/creek/track:bed            # an explicit subset: the
                                              # instrumental bed, no vocal
field query 'deps(creek)'                     # sc recipes → stems → output
```

The dependency cut is where the incrementality lives. Stems render
**pre-fader**, so changing `pan: -0.2` on the pad's placement in
`tracks/main.yaml` — a one-line diff — re-runs only the cheap sum; the stems
stay cached. Moving a clip re-renders that one
track's stem and the sum, and no other track. Even the tempo map is precise
about blame: stems are keyed on clip placement *in samples*, so a tempo edit
rebuilds only tracks whose musical clips actually moved.

In creek, the lead vocal places the generated take's own leaf track: the
take's 24 kHz converts at that leaf's edge (see Building, above), placed
at bar 5 with a softened entrance (`fade_in`, in samples), and again at
bar 9 over the stripped-back third pass. And the pad carries under the verse by clipping the same render
twice, the second entering a beat early with fades on both sides of the
seam — two overlapping faded clips **are** the crossfade; it is not a schema
feature.

## Shaping

Field's offline effects — `eq`, `limit`, `reverb` — appear in three
places in creek, one of each:

- **A wrapper track**: `track:kit-punch` runs the kit *recipe* through
  the EQ — one entry playing the whole of `kit-sc`, one `eq` insert (low
  shelf for punch, high shelf for air) — and the drums play the EQ'd
  render through an entry of their own (`track: kit-punch`). Edit the
  shelf, and render → stem → sum rebuild in one pass. This was an `eq`
  *sound* until sounds began folding into tracks (nested-tracks.md
  §1.12, §17, §18); the render is bit-identical.
- **A track insert**: the pad carries a `reverb` insert, so the wash is
  baked into its stem — and rings past the last clip (the stem simply
  grows by the tail).
- **The master chain**: creek's `main` track ends in a `limit` at −1 dB —
  the same `inserts` list as the pad's, on the track that is the song —
  which retired the hand-tuned master gain that used to keep peaks legal.
  The ceiling is now a guarantee, not a measurement.
- **A chain of inserts**: the vocal runs two in series — a low-pass at
  700 Hz into a predelayed reverb, which does not so much darken the
  generated line as bury it: even at that corner the consonants are gone
  (2-8 kHz keeps 0.41% of its energy through the chain) and what is left
  is a shape behind the keys. The 40 ms predelay still puts the dry
  signal ahead of the wash, and the EQ's auto-normalize hands back the
  level the low-pass takes.

The EQ is auto-normalizing by default: compensation is computed from the
curve's own frequency response, so EQ moves change *tone* without
changing *level* — boosting stops being a free loudness win. Set
`normalize: false` to opt out.

## Recipes

`shared/instruments/pad.scd` is the D-minor pad as **code**:
twelve detuned sine voices whose detunes and pans are drawn from a seeded
random stream. The track pins the seed — `songs/creek/tracks/pad-sc.yaml`
in full:

```yaml
# the pad as a recipe: code + seed instead of committed bytes
name: pad-sc
inputs:
  - supercollider:
      source: pad.scd
      seed: 90210
      duration: 10
      channels: 2
```

`field build //songs/creek/track:pad-sc` renders it through SuperCollider's
offline (NRT) mode — and the render is **bit-for-bit reproducible**: wipe
`.field/cache` and rebuild, and you get the identical file, byte for byte.
Edit the program and only its renders invalidate (the code's content hash is
a cache input). Change the seed and you get a sibling performance of the same
recipe.

To iterate on a program before pinning it in a track:

```bash
field sc render shared/instruments/pad.scd --seed 90210 --duration 10
```

And to hear the committed recipe exactly as pinned:

```bash
field play //songs/creek/track:pad-sc
```

And since an entry can place a *track* instead of committed audio, the pad
reaches the arrangement without an imported file existing anywhere — from
`songs/creek/tracks/pad.yaml`:

```yaml
- id: intro-pad-k3m7q
  track: pad-sc
  at: [1]
  duration: [4]
  fade_out: 30000 # one beat, crossfading into the verse pad below
```

Edit the program and rebuild the song: the render, the stem, and the sum
rebuild in one pass — nothing to re-import, nothing stale. This is the
trade the whole system is built around: the repository commits the
*recipe* — code, seed, parameters — and the audio is a build artifact
anyone can regenerate. (Requires
[SuperCollider](https://supercollider.github.io) — for both songs now:
creek's pad and beat, and tall-grass's groove.)

creek's beat is the second recipe: `shared/instruments/creek-kit.scd`
(`track:kit-sc`), two bars of kick, snare, and seeded hats, looped from
the downbeat to the build. It has a
determinism detail the pad didn't need: noise UGens get client-seeded
`RandSeed` args, because scsynth's own noise seeding is time-based —
with them, the beat is bit-reproducible like everything else.

Field is very young — audio import, the build graph, SuperCollider
generation, model generation for music and voice, offline mixing, and
native playback have landed; recording is next. This example grows along
with it, and CI checks it on every change.
