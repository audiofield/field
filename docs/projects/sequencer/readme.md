---
status: in-progress
priority: now
---

# Sequencer

**Goal:** a song holds written parts, notes in bars and beats that play
through their track's instrument. Parts build like every other entry,
and `field seq` plays them live, through their voices or through
external gear, while `field-audiod` sends each note on time.

## 1 Problem

Field turns notes into sound in one way. You play `field keys`, which
makes the computer keyboard the MIDI source `Field Keys`, or a hardware
controller. `field record` captures what you play as a MIDI take, and
the build renders the chosen take through the instrument the track's
`record:` entry names (project-model.md "MIDI takes"). The take is a
record of a performance. Its notes file,
`audio/<track>/take-<timestamp>.notes.yaml`, is timed in samples,
`field record` is its only writer, and the build refuses it once its
bytes change.

So no note in Field can be written, only played. That has three
effects:

- **You cannot write or fix a part.** A wrong note means another take.
  A drum pattern or a bass line typed by hand, or written by an agent,
  has no file to go in.
- **Notes do not follow the tempo.** A take's times are samples, so
  after a tempo edit its notes no longer sit on the beats they were
  played on.
- **Nothing plays notes live in time with the song.** The engine plays
  a MIDI track as its rendered stem. To hear a changed note or a turned
  knob you rebuild, and an instrument that cannot render offline, such
  as a hardware synth, has nothing to play its notes at all.

Written parts are a first-class kind of material, beside recorded and
generated audio. daw-features.md §15 recorded the opposite on
2026-08-21: "Field's material is overwhelmingly recorded and generated
audio rather than sequences". That described the order Field was built
in, which began with recording and generation, not the music it is for.
This plan corrects that record.

## 2 Solution

A part is a notes file you write in musical time, under
`songs/<song>/notes/`. A track names its instrument once, and a
`notes: <name>` entry places a part on it, as `audio: <name>` places
committed sound. The build renders each placement through the track's
instrument with the `voice-render` rule that MIDI takes use, after one
resolver turns the part's bars and beats into samples through the
track's tempo map. Recorded MIDI takes land in the same format, in
ticks, so a take is a part that `field record` wrote and the ledger
pins. To hear parts live, `field seq` plays the tracks you name through
live SuperCollider voices. It compiles each track's notes into a
sample-timed schedule, and `field-audiod` sends the schedule's MIDI on
time from its audio callback, as it already plays the click. The same
schedules reach external gear: `field seq` can send a track's notes to
a hardware synth's MIDI port, and MIDI clock to gear that runs its own
patterns. The voice host moves out of `field keys` into a library under
`field sc`, so `field keys`, `field seq`, and a hardware controller
drive voices the same way.

### 2.1 Writing a part and hearing it

1. You write `songs/creek/notes/riff.yaml`: by hand, with an agent, by
   copying a take (§2.4), or from `field sc notes` (§2.8). You add
   `- notes: riff` with `at: [17]` to `songs/creek/tracks/keys.yaml`,
   whose track names `instrument: pad`.
2. `field check` validates the part against the notes schema and the
   entry against its track: the part exists and the track has an
   instrument. It resolves the instrument's program and checks its knob
   file. The render and `field keys` report a program that does not
   answer `FIELD_MODE=voice`, because only `sclang` can tell (corrected
   2026-10-16: this step had `field check` test that the program
   answers voice mode; §9).
3. `field build creek` resolves the part from the entry's anchor
   through the track's time into sample-timed events, renders them
   through `pad` as the `voice-render` node `//songs/creek/gen:keys`,
   and places the render at bar 17. Editing a note, the tempo map, or
   `pad` renders it again. The action key covers the resolved events
   rather than the anchor, so a second placement that resolves alike
   is a cache hit.
4. `field play creek` plays the rendered stem, as for any entry.
5. To hear the part live, you run `field seq creek/track:keys`. It
   places every notes entry under `keys` on the session's timeline,
   where the session places that track's stem, with loops expanded and
   muted placements left out. It loads the result into the daemon with
   the `midi_out` op, and the daemon publishes the MIDI source
   `Field Seq creek/keys`.
6. `field seq` then starts a voice for `keys` that plays only from that
   source, which exists by the time the voice host connects to its
   sources. It opens the daemon input `seq:creek/keys` for the voice
   and reloads the session. A session compiled with a `seq:` input open
   on a track leaves out that track's notes renders, so you hear the
   part once, live.
7. While the transport plays, the daemon's callback finds the events
   due in each block, early by the output's lead, and a sender thread
   sends each one at its exact time on the virtual source
   `Field Seq creek/keys`. On stop, pause, locate, and loop wrap, the
   daemon ends every note the output holds.
8. You edit `riff.yaml` while it plays. `field seq` sees the change,
   compiles the schedule again, and replaces it under the same name, so
   the source and the voice's connection to it stay. The daemon swaps
   the schedule at the next block and ends the notes the old one held.
   `field build --watch`, if it runs, renders the stem again meanwhile.
9. You quit `field seq`. It closes its output and its input and reloads
   the session, so the rendered stem plays again.

### 2.2 A part is a notes file in musical time

```yaml
# songs/creek/notes/riff.yaml
length: [2]
notes:
  - {at: [1], length: [0, 1], note: C3, velocity: 110}
  - {at: [1, 2], length: [0, 1], note: G3}
  - {at: [1, 3], length: 480, note: 60}
  - {at: [2], length: [1], note: C2, velocity: 90, channel: 2}
controls:
  - {at: [1], cc: 74, value: 64}
bends: []
```

| Field | Meaning |
| --- | --- |
| `length` | The part's span from its start. Optional: omitted, the part ends where its last note ends. A looping entry that omits `every` repeats at `length`. |
| `notes` | Each note: `at`, a position in the part; `length`, a span; `note`, a MIDI number from 0 to 127 or a name in scientific pitch, where `C4` is 60, as `field keys` prints notes; `velocity`, 1 to 127, 100 when omitted; and `channel`, 1 to 16, 1 when omitted. |
| `controls` | Each controller change: `at`, `cc`, `value`, and `channel`. |
| `bends` | Each pitch bend: `at`, `value` from 0 to 16383 with 8192 at rest, and `channel`. |

Time fields take musical-time's two spellings. A scalar is ticks, 960
to the quarter note, and an array is musical. A position in a part
counts from the part's start, so `at: [1]` is the part's first
downbeat and `at: [2, 3]` is beat 3 of its second bar. Positions and
spans advance through the placing track's meter map from the entry's
anchor, as a musical `duration` does, so a part placed across a meter
change keeps its bars whole. `field fmt` keeps the spelling you wrote and
writes one row per note, so two versions of a part diff line by line.

The schema in `src/schema/notes.ts` describes takes and parts both.
A take is a notes file `field record` writes, in scalar ticks from the
take's start. A part is one you write. A notes file that carries
`sample_rate:` is a take recorded before this change, and it plays in
samples as it was recorded.

### 2.3 The instrument is the track's

```yaml
# songs/creek/tracks/keys.yaml
name: keys
instrument: pad
inputs:
  - record:
  - id: verse
    notes: riff
    at: [17]
    duration: [8]
    loop: { mode: overlay }
```

| Field | Change |
| --- | --- |
| `instrument` (new, on the track) | The program the track's notes play through. It resolves as `field keys` resolves an instrument: `.scd` is added to a bare name, and a name without `/` is under `shared/instruments/`. |
| `record:` | Records MIDI when the track has an instrument, and audio when it has none. `field check` refuses `record: { instrument: … }` and names the move to the track. |
| `notes: <name>` (new entry kind) | Places `songs/<song>/notes/<name>.yaml` through the track's instrument. It takes every placement field, `loop:` included. `field check` refuses it on a track with no instrument. |

Each notes entry and each MIDI `record:` entry renders as a `gen:`
node named as generators are named today: `gen:<track>`, or
`gen:<track>-<id>` when the entry carries an `id`. A track that holds
two of them needs `id`s to tell them apart, as a track with two
generators does.

`field keys creek/track:keys` plays the track's instrument. A track
without an instrument plays the instrument tracks under it, down its
`track:` inputs, as a track whose record entry names no instrument does
today.

### 2.4 Takes land in ticks

`field record` converts each captured time to ticks through the song's
tempo map, after it subtracts the output latency, and writes the take
in scalar ticks from the take's start. The takes row keeps
`started_at_samples` as the record of where the take was captured, and
`started_at_ticks`, where the take starts in ticks after its record
entry's `at`. For a MIDI take, `started_at_ticks` and the notes' ticks
are authoritative, so a take moves with its record entry by the same
musical distance, as an audio take moves with its entry, and follows a
tempo edit as a part does (corrected 2026-10-16, Justin: this section
made `musical_position` authoritative, which left a take where it was
captured when its entry moved). A tick is 0.52 ms at 120 bpm, finer
than the timing a player controls.

To edit a take, copy it into a part and place the part where the take
plays, `started_at_ticks` after the record entry's `at`. While the
entry has not moved since the take was recorded, that is the take's
`musical_position`:

```console
$ cp songs/creek/audio/keys/take-20261015-143012.notes.yaml songs/creek/notes/keys-verse.yaml
```

Then mute the track's `record:` entry and add `- notes: keys-verse` at
that position. The part resolves to the take's events, so its render
has the take's action key and comes from the cache. The take stays
pinned and choosable.

### 2.5 The engine sends scheduled MIDI

`field-audiod` gains MIDI outputs. The `midi_out` op opens an output
under a name, or replaces the schedule of one already open. An output
sends from a virtual MIDI source the daemon publishes for it, or to a
MIDI port that already exists, such as a hardware synth's:

```json
{ "op": "midi_out", "name": "seq:creek/keys", "source": "Field Seq creek/keys",
  "rate": 48000, "lead": 192, "lead_input": "seq:creek/keys",
  "events": [ { "sample": 1536000, "midi": [144, 48, 110] },
              { "sample": 1560000, "midi": [128, 48, 0] } ] }
{ "ok": true, "name": "seq:creek/keys", "events": 2 }
```

| Field | Meaning |
| --- | --- |
| `name` | The output's name, which `midi_out_close` and `status` use. |
| `source` | The virtual MIDI source the daemon publishes for the output. An output takes `source` or `destination`, never both. |
| `destination` | Instead of `source`: the name of an existing MIDI output port to send to, such as a hardware synth's. The daemon publishes nothing for it. |
| `rate` | The rate `sample` counts in: the bed's timeline, as the click schedule's `rate` is. |
| `events` | Each MIDI message and the bed sample it belongs to, in time order. At one sample, note-offs come first, then controller changes and bends, then note-ons, as `renderEvents` orders them. |
| `lead` | Samples to send early for what the receiver adds before its sound reaches the daemon. For a SuperCollider voice that is its hardware buffer of 128 frames and one control block of 64. For a `destination`, it is the latency declared for the instrument on that port. |
| `lead_input` | Optional. An input whose reader margin the output also leads by: a block plus 256 frames, which only the daemon knows, because the block can grow. |
| `clock` | Optional. The MIDI clock pulses the output sends beside its events, described below. |

Each block, the callback takes every event whose sample falls in the
block's lookahead window, the block's span moved later by the lead. A
window that crosses the loop's end continues at its start, so the first
notes after a wrap leave on time. The callback pushes each due event
onto a lock-free queue with its exact time, which is the block's start
on `juce::Time::getMillisecondCounterHiRes()` plus the event's offset:
the clock MIDI capture already stamps against. A sender thread sends
each message at its time.

The daemon passes that exact time on to every receiver, and how it
does so depends on the receiver. On macOS, CoreMIDI schedules a
message sent to a destination for the host time stamped on it, and
`getMillisecondCounterHiRes()` and CoreMIDI's host time both count
`mach_absolute_time()`. So the sender thread hands a destination's
events to CoreMIDI as soon as they are queued, each stamped with its
time, through `MIDISendEventList` rather than JUCE's `MidiOutput`,
which stamps every message with the current time. A virtual source's
receivers can act on a message as it arrives, so the sender thread
sleeps until each of a source's events is due, and does the same for a
destination on other systems. The callback queues only the events due
in its lookahead window, so CoreMIDI holds at most a block and the
lead of a destination's events. On stop, pause, locate, a replaced
schedule, and a close, the daemon unschedules them with
`MIDIFlushOutput` before it sends the held notes' note-offs.

The daemon keeps every note each output has started, and sends its
note-off on stop, pause, locate, loop wrap, a replaced schedule,
`midi_out_close`, and the end of the connection that opened the output.
An output closes with that connection, as an input does. A note that a
locate lands inside is not started again. `status` lists each output
with its events `sent` and `late`, which counts those sent more than a
millisecond after their time. MIDI capture leaves out the daemon's own
outputs, so a take records what you play and not the part playing
beside it. `hello.features` adds `midi-out`.

An output can also carry MIDI clock, for gear that runs its own
patterns, such as a drum machine or an arpeggiator: 24 timing pulses
(`0xF8`) per quarter note. The CLI projects the tempo map into the
pulses' samples, as it projects the click schedule
(`clickScheduleSchema`), so the pulses follow every tempo change:

```json
{ "op": "midi_out", "name": "seq:creek/clock", "destination": "Digitakt",
  "rate": 48000, "lead": 0, "events": [],
  "clock": { "pulses": [0, 1000, 2000, 3000] } }
{ "ok": true, "name": "seq:creek/clock", "events": 0, "pulses": 4 }
```

Pulse `i` sits at tick 40·i, a 24th of the 960-tick quarter note, so at
120 bpm and 48 kHz the pulses are 1000 samples apart, 48 a second.
Pulses go out only while the transport plays, and around them the
daemon sends the transport's changes. Both pass through the lookahead
window and the lead as events do.

| When the transport | The daemon sends |
| --- | --- |
| Plays from pulse 0, the top of the song | Start (`0xFA`) |
| Plays from anywhere else | Song Position Pointer (`0xF2`), then Continue (`0xFB`) |
| Locates or wraps the loop while playing | Stop (`0xFC`), Song Position Pointer, then Continue |
| Stops or pauses | Stop |

Song Position Pointer counts sixteenth notes, 6 pulses each, so the
pulse list is all the position the daemon needs. It names the first
sixteenth at or after the transport's position, `ceil(i / 6)` for the
next pulse `i`, and resumes the pulses at pulse 6 times that, so the
gear's count and the song's agree. Stop comes first on a jump, so gear
that ignores a position while it plays still moves.

The daemon never learns what a note or a bar is. Like the click
schedule, a MIDI schedule and its clock are samples and bytes, and the
CLI projects the tempo map into them.

### 2.6 Voices move into `field sc`

The voice host, `sc/voice-host.scd`, and its TypeScript side in
`src/keys/voice-host.ts` and `src/keys/routing.ts`, move to
`src/sc/voice/` as a library that three commands use:

| Command | Its voices' inputs | Its voices play from |
| --- | --- | --- |
| `field keys <targets>` | `keys:<song>/<track>`, as today | every MIDI source except the `Field Seq` ones |
| `field seq <targets>` | `seq:<song>/<track>` | only `Field Seq <song>/<track>` |
| `field sc voice <targets> [--source <name>]...` (new) | `voice:<song>/<track>` | the sources named, or every source except the `Field Seq` ones |

`field sc voice` plays an instrument from a hardware controller or
another application with no `field keys` running, which makes
`field sc` the synth as a program of its own. Each command starts its
own voice host and stops it when it quits, as `field keys` does.

The voice host gives each voice the set of sources it plays from. It
replaces the one rule it has now, under which every note from every
source plays every loaded voice. `LIVE_INPUT` in
`src/audiod/live-inputs.ts` admits the `keys:`, `seq:`, `voice:`, and
`capture:` prefixes, so every reload keeps all four heard. Session
compile reads a `seq:` input as "this track's notes play live" and
leaves out the track's notes renders. A `keys:` or `voice:` input plays
beside the renders, as `keys:` does now.

### 2.7 `field seq` plays parts live

```console
$ field seq creek/track:keys creek/track:bass
seq   keys (pad) · 2 parts · Field Seq creek/keys → seq:creek/keys
seq   bass (bass) · 1 part, 1 take · Field Seq creek/bass → seq:creek/bass
following creek · stopped at 1.1.1 · field transport play to start
```

- **Targets** resolve as `field keys` resolves tracks. A song alone,
  `field seq creek`, plays every track in it that has an instrument and
  notes. A track's notes are its parts and its chosen MIDI take.
- **It follows the transport.** `field seq` loads the song's live
  session when none is loaded, as `field keys` does, and never starts
  or stops the transport.
- **It watches the files.** An edit to the song's track files,
  `song.yaml`, or a part they place compiles the schedules again. A
  project that fails `field check` keeps the last good schedules, and
  `field seq` prints the errors, as `field build --watch` does.
- **`--midi-only`** publishes the sources and their schedules with lead
  0, starts no voices, opens no inputs, and leaves the session alone.
  Use it to drive another application from parts.
- **`--destination <track>=<port>`** sends a track's notes to an
  existing MIDI port, such as a hardware synth's, instead of a voice:
  `--destination bass="Minilogue XD"`. The track gets no voice and no
  input, so the session keeps playing its rendered stem, as under
  `--midi-only`. Its lead is 0, because nothing declares the synth's
  latency yet.
- **`--clock <port>`** sends MIDI clock to an existing MIDI port, so
  gear that runs its own patterns follows the song. It shares the
  output of a `--destination` on the same port. Repeat it for more
  ports.
- **Ctrl-C quits.** `field seq` closes its outputs and inputs and
  reloads the session.

A synth on a `--destination` is not an instrument of its track yet.
Spelling an external instrument on a track, with its port, channel,
latency, and the inputs its audio returns on, and the realtime bounce
that renders it, stay with
[external-instruments](../external-instruments/readme.md). That project
builds on this plan's `destination` and clock.

Live playback approximates the build in four places, and the build
stays exact in each:

- A live input reaches its track once (audio-engine.md "Live inputs"),
  so placements of one track at different levels or pans cannot each
  keep their own while the track plays live.
- A `truncate` loop ends each repetition's notes at its slot, where the
  build cuts the render with a fade, so a release tail rings on live.
- A note that a locate lands inside stays silent until its next onset.
- The first notes after play or a locate leave late by up to the lead.

### 2.8 SuperCollider patterns write parts

`field sc notes` runs a program under `FIELD_MODE=notes`, in which the
program returns a Pattern. The harness, `sc/notes-render.scd`, plays
the pattern under the seed for the number of quarter notes `--beats`
gives, with no server, and prints its events as a part in scalar ticks
on stdout. The part's first line is a comment naming the command that
wrote it.

```console
$ field sc notes shared/instruments/creek-groove.scd --seed 4 --beats 16 > songs/creek/notes/groove.yaml
```

A pattern writes a part rather than playing live, so the part it
writes is ordinary text you can edit, and the build renders it like
any other.

### 2.9 Files

| File | Change |
| --- | --- |
| `src/schema/notes.ts` | One schema for takes and parts: musical-time fields, note names, the velocity default, and `sample_rate` only on takes recorded in samples. `formatNotesFile` writes ticks. |
| `src/time/notes.ts` (new) | The resolver: a notes placement and its track's time to sample-timed events. The graph and `field seq` both call it. |
| `src/time/clock.ts` (new) | The clock's projection: the tempo map to pulse samples, as `beatGrid` in `src/commands/click.ts` projects the click. |
| `src/schema/track.ts` | `instrument` on the track, the `notes` entry kind in the arity check, and `loop` without `every` on a notes entry. |
| `src/schema/record.ts` | `instrument` leaves the record entry. |
| `src/model/project.ts` | Loads parts from `songs/<song>/notes/`, and validates notes entries, track instruments, and the moved field. |
| `src/graph/graph.ts`, `src/generators/voice-render.ts` | A `voice-render` node per notes entry and per MIDI take, keyed on resolved events. |
| `src/commands/record.ts`, `src/commands/land.ts` | Arm for MIDI by the track's instrument, and land a take in ticks. |
| `src/commands/fmt.ts` | Format parts, keeping their spellings. |
| `src/keys/targets.ts` | Read the instrument from the track. |
| `src/sc/voice/` (new; from `src/keys/voice-host.ts`, `src/keys/routing.ts`), `sc/voice-host.scd` | The voice library, and the sources each voice plays from. |
| `src/audiod/live-inputs.ts`, `src/graph/live.ts` | The four input prefixes, the `seq:` claim, and the schedule compile that places notes where the session places stems. |
| `native/audiod/src/midi_out.cpp`, `midi_out.h` (new) | Outputs to sources and destinations, their schedules and clocks, the sender thread, and the notes each output holds. |
| `native/audiod/src/player.cpp`, `server.cpp`, `keys.cpp` | The callback's lookahead, the ops and the status, the `midi-out` feature, capture leaving out the daemon's own outputs, the virtual-source code `--keys` shares, and `--midi-monitor` printing each message's host time, with a `--destination` mode that publishes a virtual destination through CoreMIDI for tests and prints the timestamp each message carries. |
| `src/audiod/protocol.ts`, `src/audiod/client.ts` | `midi_out` with its `destination` and `clock`, `midi_out_close`, and the outputs in `status`. |
| `src/commands/seq.ts` (new), `src/commands/sc.ts` (new, from `src/cli.ts`), `src/cli.ts` | `field seq` with `--destination` and `--clock`, `field sc voice`, and `field sc notes`. |
| `sc/notes-render.scd` (new) | The pattern harness. |
| `docs/sequencer.md` (new), `docs/tracks.md`, `docs/project-model.md`, `docs/build-graph.md`, `docs/audio-engine.md`, `docs/keys.md`, `docs/cli.md`, `docs/README.md`, `AGENTS.md` | Parts, the track's instrument, takes in ticks, MIDI outputs, voices, and `field seq`, each in the chunk that ships it. |
| `docs/projects/daw-features/readme.md` §15, `docs/projects/key-conforming/readme.md` | The corrected premise: parts conform by arithmetic and audio through the model. This plan's change makes it. |

## 3 Why this design

### 3.1 The sequencer is its own program, and the engine keeps the deadline (DECIDED, 2026-10-15, Justin)

The sequencer does three jobs, and each pulls toward a different
program. Holding notes is a file's job (§3.2). Writing them is every
tool's job: `field record`, an editor, an agent, `field sc notes`, and
later a piano roll. Playing them on time needs the clock, and the clock
is `field-audiod`'s. So `field seq` is a program of its own that knows
parts, tracks, voices, and musical time. The engine only meets the
deadline, as it does for audio files and the click. The click schedule
is the precedent. "The CLI projects the tempo map into it; the daemon
synthesizes the ticks in the callback and never learns what a bar is,"
its comment in `src/audiod/protocol.ts` says. The player stays
artifacts-only (playback.md §1). The architecture's own rule points
the same way: C++ for everything with a deadline.

Rejected (DECIDED, 2026-10-15, Justin): **a `clock` event from the
daemon, followed by a native helper, `field-audiod --seq`, that sends
MIDI by it.** It keeps timing out of the engine by rebuilding the
engine's clock in a second process: a host-time anchor broadcast,
lookahead and flushes, wrap prediction from the loop region, notes late
after play and locate by the time the event takes to arrive, and drift
correction. The schedule needs none of that. The daemon also closes a
gap the helper cannot: a hosted plugin instrument takes MIDI inside the
callback, and a schedule already there feeds it with no round trip
through a virtual source. What the schedule gives up is an event that
tells other programs the host time of each position. MIDI clock (§2.5)
gives them the tempo and the position, pulse by pulse. Add the `clock`
event when a program needs more.

External gear does not change the answer. A hardware synth's port is
one more place a schedule goes, as a `destination` (§2.5), and on macOS
CoreMIDI schedules each message the daemon stamps for its time, so a
port keeps time at least as well as a virtual source. Gear that runs
its own patterns needs MIDI clock, and the clock is one more schedule:
pulses the CLI projects from the tempo map and the engine sends. The
`clock` event serves programs, not instruments, so it stays deferred.
When external-instruments builds the realtime bounce that
build-graph.md "Render strategies" describes, in which "Field plays the
MIDI at 1×, captures the return", the MIDI it plays is this same
`midi_out` schedule.

Rejected: **`field seq` sends MIDI on Node timers.** Garbage-collection
pauses and timer jitter run to milliseconds, which is why
architecture.md keeps deadlines out of TypeScript.

Rejected: **SuperCollider's own clock plays parts live.** It is a
second clock, which drifts from the device the daemon plays, and it
plays only SuperCollider instruments. Patterns write parts instead
(§2.8).

Rejected: **sequencing inside `field keys`.** `field keys` is the
keyboard, and a sequencer needs no terminal. The two share the
virtual-source code and the voice library instead.

### 3.2 Parts are files of their own (DECIDED, 2026-10-15, Justin)

A part is the file every writer and every player of notes agrees on.
Writers write it whole: `field record` by copy, an editor, an agent, a
filter with `>`, and later a piano roll. Players read it whole: the
build and `field seq`. One part can be placed by many entries, as
`audio: <name>` places one asset many times, and an authored file
referenced by name and hashed as a build input already exists in
`supercollider: source:`.

Rejected: **notes inline in the track file.** A track file is
structure, edited through comment-preserving document code. Every
writer of notes would have to edit a section of it, and no filter
could write one with `>`.

Rejected: **editing takes.** A take is a record of a performance,
pinned so the build can trust it. Copying it into a part (§2.4) keeps
the record and gives you the notes.

Rejected: **Standard MIDI Files**, for the reasons
keyboard-instrument.md §12.1 records: they diff as bytes, and an agent
cannot quantize or transpose a message stream without pairing its
note-ons and note-offs first.

### 3.3 One notes format, in ticks (DECIDED, 2026-10-15, Justin)

This changes keyboard-instrument.md §12.1, which put takes in samples
because samples are exact and need no tempo map. With parts in ticks,
takes in samples would mean two time bases, two placement rules, and a
take that cannot become a part by copying it. Ticks also make MIDI
follow a tempo edit, as it does in every DAW that records MIDI. The
cost is rounding to the nearest tick, at most 0.26 ms at 120 bpm.

Rejected: **parts in samples.** A tempo edit would leave written notes
off the grid.

Takes that carry `sample_rate:` keep playing as they were recorded, so
no migration rewrites a pinned file.

### 3.4 The instrument is the track's (DECIDED, 2026-10-15, Justin)

This changes keyboard-instrument.md §12.2, which put `instrument` on
`record:` because the instrument decides the kind of take. On the
track, it still decides that. The overview already says "an instrument
is a leaf track carrying its program", and live routing already gives
each track one voice. An instrument on each entry lets one track name
two, which no live path can play, and makes changing an instrument an
edit to every entry.

Rejected: **an instrument on each `notes:` entry, as on `record:`.**
Two places name a track's sound, and a track would need two voices.

### 3.5 One resolver serves the build and `field seq`

`src/time/notes.ts` is the one place a notes placement becomes sample
times, so a part plays live where it renders. The voicing is already
shared: `sc/voicer.scd` plays notes the same way live and offline
(keyboard-instrument.md §12.3). The rest is reuse:

- **`voice-render`** renders parts as it renders takes, through
  `renderEvents` and `sc/voice-render.scd`.
- **Loop expansion** in `planTrack` (clip-looping.md decision 6) places
  a looping part's render, as it places any looping entry's.
- **The live-input naming** in `src/audiod/live-inputs.ts` carries the
  `seq:` claim to every reload.
- **The solo filter's shape** in `src/model/solo.ts`, a session-only
  change made at compile, is the shape of the `seq:` filter.
- **MIDI capture's queue**, from the MIDI thread into the callback, runs
  the other way for outputs: from the callback to the sender thread.
- **`--keys`'s virtual source** in `keys.cpp` is the code a MIDI output
  publishes its source with.
- **The click's projection**, `beatGrid` in `src/commands/click.ts`,
  projects each beat through the tempo map, as the clock's projection
  does each pulse.

### 3.6 The live claim is the input's name

A `seq:` input tells every reload, in `field play --watch`, `field ui`,
and `field record`, that the track plays live, because each reload
already compiles in the inputs the daemon lists. It needs no new daemon
state, and it ends with the connection, so a killed `field seq` leaves
no claim behind. Until the next reload, the track's part is silent, as
a killed `field keys` leaves its input silent today.

Rejected: **a session field beside `solo`.** The daemon would have to
echo it in `status` for reloaders, and it would outlive a dead
`field seq`.

### 3.7 One source per track, not a channel per track

Channels belong to a part's content, because a part can use several,
and there are only 16. A source named for its track keeps each track's
stream separate for any application that lists MIDI sources.

### 3.8 Each command hosts its own voices

`field keys`, `field seq`, and `field sc voice` each start a voice host
and stop it when they quit, as `field keys` does today. Running two of
them runs two `scsynth` processes.

Rejected for now: **one voice service per song, with the daemon-lite
lifecycle** that `field-audiod` and the workers have: spawned on
demand, one per project, exiting when idle. It would share one
`scsynth` among every program, but it needs a socket protocol and a
lifecycle of its own. Revisit it when start-up time or memory says so.

## 4 Acceptance criteria

| Do | Expect |
| --- | --- |
| Place `riff` at `[17]` on a track with `instrument: pad`, and run `field build creek`. | `field explain creek/gen:keys` names a `voice-render` with the part and `pad` as inputs, and the render plays from bar 17. |
| Change one note, then the tempo, then `pad`. | Each change renders again. After the tempo edit, every note still starts on its beat. |
| Place the same part at bars 1 and 17 of a constant-tempo song. | The second placement is a cache hit. |
| Place a part across a meter change from 4/4 to 7/8. | The part's second bar starts at the bar line after the change, in a resolver unit test. |
| Run `field check` on a notes entry on a track without an instrument, a missing part, a note name that is not one, and `record: { instrument: pad }`. | Four errors. The last names the move to the track. |
| Record a MIDI take, then edit the tempo, then move its record entry. | The take lands in ticks and follows the tempo edit. It moves with its entry by the same musical distance. A take with `sample_rate:` renders as before, and its tests pass unchanged. |
| Copy a take into a part and place it at the take's position (§2.4). | The part's render has the take's action key. |
| Load a schedule with lead 0 and record a MIDI take from its source in the same daemon. | Every captured note lies within 48 samples (1 ms at 48 kHz) of its scheduled sample, across a loop wrap too, and `status` reports 0 `late`. |
| Stop, pause, locate, wrap, replace the schedule, close the output, and drop its connection, each with notes sounding. | Every note-on the source sent has its note-off. |
| Give an output a `lead` and a `lead_input`. | Its events leave earlier by the lead plus the input's margin, in a unit test of the callback's selection with a fake clock. |
| Arm a MIDI take while an output plays. | The take records `Field Keys` and none of the output's notes. |
| Load one schedule into an output with a `source` and into one with a `destination`, a virtual destination that `field-audiod --midi-monitor --destination` publishes, and monitor both. | Each message's timestamp at the destination lies within 1 ms of the same message's arrival from the source, across a loop wrap too. The sender thread handed each destination event to CoreMIDI before its time. |
| Stop the transport with a `destination` output's events handed over early. | None of them reaches the destination after the stop, in a unit test with a fake CoreMIDI. |
| Project a clock from a song at 120 bpm, then from one that changes tempo at bar 5. | 48 pulses a second at 120 bpm. After the change, the pulses are spaced by the new tempo, in a projection unit test. |
| In a 4/4 song, with `--midi-monitor` reading a clock from a virtual source: play from the top, stop, play from bar 3, locate to beat 2 of bar 9 while playing, wrap the loop, and pause. | Start; Stop; Song Position Pointer 32 and Continue; Stop, Song Position Pointer 132, and Continue; at the wrap, Stop, the loop start's position, and Continue; Stop. After each Continue, the next pulse is 6 times the position. No pulse goes out while stopped. |
| Compile a session with `seq:creek/keys` open, then with `keys:creek/keys` open. | The first leaves out the track's notes renders and keeps its audio entries. The second keeps the renders. |
| Run `field seq creek/track:keys`, then reload from `field play --watch`, then quit `field seq`. | The part plays once, live, through the reload. After the quit, the rendered stem plays. |
| Edit a part while `field seq` plays it. | The new notes play from the next pass, with no stuck notes. |
| Run `field keys` while `field seq` plays. | The keys voice plays what you type and ignores the `Field Seq` sources. The existing `field keys` tests pass. |
| Run `field sc voice creek/track:keys --source "Field Keys"`. | The voice plays from `Field Keys` alone. |
| Run `field sc notes` twice with one seed. | The same bytes both times, and they pass the notes schema. |
| By hand: play a part through `field seq` beside a copy of its track playing the rendered stem, and record the output through a loopback device. | Onsets in the two agree within 2 ms. |

These tests fail before the change: the resolver tests, the notes
entry and track `instrument` schema tests, the clock projection test,
the `midi_out` daemon tests (timing, note-offs, lead, capture
exclusion, destinations, and the clock), the session compile test for
`seq:` inputs, and the voice-host source test. The daemon tests
skip by name where the machine has no virtual MIDI, as the
`field keys` round trip does in a Linux container without the ALSA
sequencer.

## 5 Cost

- **Building a part** costs what building a MIDI take costs: one
  `sclang` run in non-realtime mode per distinct resolved event list.
  A tempo edit renders every part in the song again, as it does every
  tempo-synced plugin chain, because the resolved times change.
  Resolution is linear in the number of notes.
- **The audio callback** advances a cursor through each output's
  sorted events and pushes the due ones onto a queue: work in
  proportion to the events due, with no allocation. A loaded schedule
  is built off the audio thread and swapped in by pointer, and the old
  one is freed off it. A session with no outputs pays one empty check
  per block.
- **Loading a schedule** sends about 40 bytes of JSON per event, so a
  five-minute part of 5,000 notes, which is 10,000 events, is about
  400 KB. Loads happen when `field seq` starts and when a file
  changes.
- **The sender thread** sleeps between events, and hands a
  destination's events to CoreMIDI as they are queued.
- **A clock** is 24 pulses per quarter note, 48 a second at 120 bpm:
  one cursor step per pulse in the callback, and about 130 KB of JSON
  for five minutes at 120 bpm, which is 14,400 pulses.
- **Voices** cost one `scsynth` per running command that hosts them
  (§3.8).

## 6 Rollout

Each chunk is its own pull request. Chunks 1, 3, and 4 do not depend
on each other.

1. **One notes format.** The instrument moves to the track, takes land
   in ticks, the resolver exists, and `voice-render` keys on resolved
   events.
2. **Parts.** The `notes:` entry, part files, `field check`, and
   `field fmt`. Needs chunk 1.
3. **Voices in `field sc`.** The library, the sources each voice plays
   from, and `field sc voice`.
4. **MIDI outputs in the engine.** `midi_out`, `midi_out_close`, the
   sender thread, held notes, lead, destinations, MIDI clock, and
   capture leaving out the daemon's own outputs.
5. **`field seq`.** Needs chunks 2, 3, and 4. Includes `--destination`,
   `--clock`, and the clock's projection. Writes `docs/sequencer.md`.
6. **`field sc notes`.** Needs chunk 2.

## 7 Open questions

1. **Parts in their own files** (§3.2). Decided 2026-10-15 by Justin:
   one file per part at `songs/<song>/notes/<name>.yaml`, placed by
   `- notes: <name>`.
2. **The engine sends MIDI from a schedule, rather than a clock event
   and a helper** (§3.1). Decided 2026-10-15 by Justin, and extended to
   external instruments: the engine sends every instrument's notes from
   schedules, to virtual sources and hardware destinations alike, and
   sends MIDI clock for external gear (§2.5).
3. **The instrument moves to the track, and takes land in ticks**
   (§3.3, §3.4). Decided 2026-10-15 by Justin: the instrument is the
   track's, and MIDI takes land in ticks.
4. **Names.** Decided 2026-10-15 by Justin: the directory
   `songs/<song>/notes/` and the `notes:` entry keep the name `notes`,
   because the entry names what it plays, as `audio:` does, and takes
   and parts share one notes file format and `notesFileSchema`. `part`
   was the alternative, and `clip` already means any placed window
   (clip-looping.md decision 1). Justin accepted `field sc voice` and
   `field sc notes` on 2026-10-15 as fine for now, and `field seq`, the
   `Field Seq <song>/<track>` sources, and `field seq --destination`
   and `--clock` on 2026-10-16 as fine for now. Blocks nothing.
5. **Editing commands, such as quantize and transpose, and a piano
   roll.** Deferred: parts are text meanwhile, and the editor belongs
   to [detail-pane](../detail-pane/readme.md).
6. **Hardware synths.** `field seq --destination` sends a track's
   notes to a synth's MIDI port, `--clock` sends MIDI clock to gear
   that runs its own patterns, and `--midi-only` still drives other
   applications through the virtual sources. Spelling an external
   instrument on a track, with its port, channel, latency, and the
   inputs its audio returns on, and its realtime bounce stay with
   [external-instruments](../external-instruments/readme.md), which
   builds on `destination` and the clock.
7. **Hosted plugin instruments.** Deferred to
   [plugin-hosting](../plugin-hosting/readme.md), which hosts inserts
   only. A schedule is already the shape their MIDI takes, live and in
   `--render`.
8. **Parts under `shared/`.** Deferred until a project places one part
   in two songs.
9. **Windows.** It has no virtual MIDI sources (keys.md), so
   `field seq` refuses there, as `field keys` does. Deferred with
   [windows-portability](../windows-portability/readme.md).

## 8 Background

Read on 2026-10-15, at `566d90c`:

- **Takes are performances.** `src/schema/notes.ts` times a notes file
  in samples at `sample_rate`, and `formatNotesFile` is its only
  writer, because the ledger pins its bytes. project-model.md "MIDI
  takes" says the build refuses a notes file edited by hand.
- **The render already exists.** `src/generators/voice-render.ts` turns
  a take into `renderEvents` and runs `sc/voice-render.scd` with
  `sc/voicer.scd`. `src/graph/graph.ts` mints it for a record entry
  whose chosen take is MIDI, from `entry.record.instrument`.
  `record.instrument` is read in five files: `land.ts`, `record.ts`,
  `graph.ts`, `targets.ts`, and `project.ts`. No track in
  `examples/bloom` names an instrument.
- **One note plays every voice.** `sc/voice-host.scd` calls
  `MIDIIn.connectAll`, and its note-on starts a synth for every loaded
  voice, each on its own bus, so a voice cannot tell one source's
  notes from another's.
- **The keys helper sends at once.** `src/keys/helper.ts` writes
  `{"midi": …}` lines to `field-audiod --keys`, which sends each as it
  arrives, with no time attached.
- **The engine plays schedules and knows no bars.**
  `native/audiod/src/player.h` describes the player as artifacts-only,
  knowing "file paths and samples — never clips, tracks, or tempo
  maps", and `clickScheduleSchema` in `src/audiod/protocol.ts` is a
  list of sample positions. MIDI capture stamps each message against
  the block's start on `juce::Time::getMillisecondCounterHiRes()`
  (`Player::processBlock`, `Player::stampMidiBlock`).
- **JUCE sends MIDI at once.** JUCE 8.0.4's `MidiOutput` stamps each
  CoreMIDI packet with the current host time, and its `MidiInput`
  stamps each message with its arrival rather than the packet's
  timestamp (`juce_CoreMidi_mac.mm`). `getMillisecondCounterHiRes()`
  reads `mach_absolute_time()` on macOS (`juce_SystemStats_mac.mm`),
  the clock CoreMIDI's host time counts.
- **The daemon publishes no clock.** The `position` event is a bare
  sample count, sent from a 250 ms timer in `native/audiod/src/main.cpp`
  while the transport plays, with no time of day attached.
- **Reloads carry live inputs.** `LIVE_INPUT` in
  `src/audiod/live-inputs.ts` matches `keys:` and `capture:` inputs,
  and `compileWithInputs` compiles every open one into each reload.
- **Musical time is ticks.** `PPQ` is 960 in `src/constants.ts`, and
  tracks.md "Local time and rate" puts every `at` in a track file in
  that track's time.
- **Loops can let tails ring.** clip-looping.md decision 4's `overlay`
  mode lets each repetition ring over the next.
- **Nothing overlapped this plan.** No plan under `docs/projects/` and
  no open pull request covered sequencing.

## 9 Notes and parts, as built

Chunks 1 and 2 are built together, on branch `seq-notes`, as the
bottom layer of a stack of four pull requests: chunks 1 and 2, then 3
with 6, then 4, then 5. Each chunk alone was too small to be worth a
review cycle. Chunks 1 and 2 are one argument, notes you write and the
build that renders them, and chunk 6 is a small `field sc` command that
rides with the `field sc` library of chunk 3. §6 still lists the chunks
in the order they depend on each other.

Building them settled these points, which §2 left open or stated
loosely:

- **A take starts where its capture did.** `field record` takes the
  output latency off each note, not off the take's start, so a take
  recorded from bar 17 has `musical_position: [17]` and counts its ticks
  from there. A note heard before that point, because it was pressed in
  the take's first moments, starts with the take; a note that ended
  before it is dropped.
- **A MIDI take starts `started_at_ticks` after its record entry.**
  `field record` converts captured times through the recording track's
  tempo map, which is the song's for every track without `time:` (§2.4
  says "the song's"). It writes where the take started as
  `started_at_ticks`, counted from the tick the record entry's window
  starts on; an absolute entry counts from the whole tick its sample
  falls on. The take plays from there, so moving the record entry moves
  the take by the same musical distance, and a tempo edit keeps its
  notes on their beats (Justin, 2026-10-16: a take that its entry could
  not move "sounds totally wrong"). `musical_position` records where the
  take started on its track, in the track's own time, so while the
  entry has not moved it is the `at` that places a copy of the take as
  a part on the same track (§2.4). An audio take's `musical_position`
  stays what the song's map said at capture. A take in samples has no
  `started_at_ticks`, and moves with its entry by its sample row, as an
  audio take does.
- **The render is keyed on events and on the notes file.** A
  `voice-render` node's parameters are the instrument and `events`, the
  notes resolved for the placement in samples from its start. The notes
  file is an input by content hash as well: a take as the ledger source
  it was, so the build still refuses a take whose pinned bytes changed,
  and a part hashed in place, so `field explain` names the part as §4
  asks. A byte copy of a take has the take's hash, which keeps the copy
  on the take's action key. The cost is that an edit to a part's
  comments or spellings alone renders it again. Justin accepted this
  as built on 2026-10-16.
- **Rows are written without spaces inside the braces.** `field fmt`
  writes `{at: [1], length: [0, 1], note: C3}`, because the emitter pads
  maps and arrays alike or neither, and track files write `[12, 2]`.
  §2.2's example is spelled that way. A row never breaks across lines,
  however many fields it spells out. `field record` writes takes with the
  same formatter, so a copied take is already a formatted part. Justin
  accepted this as built on 2026-10-16.
- **A musical position counts within the bar it lands in.** `[2, 3]`
  advances one bar from where the part is placed, then two beats, and
  the beat and tick must exist in the meter of that bar. The check runs
  per placement, because a beat that exists in one placement can be
  missing in another, and `field check` reports it against the track
  file whose entry places the part.
- **An absolute entry places a part from the tick its sample falls
  on.** Its loop's `every`, when omitted, is the part's length in
  samples, as every absolute time is.
- **Each repetition of a looping part resolves where it starts.**
  Loop expansion places a render in each repetition's slot
  (clip-looping.md decision 6), and each slot plays what the part
  placed there by hand would: the repetitions start `every` apart in
  the entry's anchor units (decision 3), and each resolves from its own
  start. Repetitions that resolve alike play one render, so a loop in a
  steady song is one render, and the repetitions after a tempo or meter
  change play their own, `gen:<name>-<n>`, named for the first
  repetition `<n>` that plays it. `field check` resolves every
  repetition, so a beat that a later bar lacks is reported, and refuses
  a generator that has a repetition's render name. `partRenders` in
  `src/generators/stem.ts` does this for the build, and `field seq`
  resolves a looping part with it too (§3.5).
- **Note names** are scientific pitch with `#` or `b`, from `C-1` (0) to
  `G9` (127). A part's file name must be a lowercase slug, the only
  name a `notes:` entry can spell.
- **`field check` does not test that the instrument answers voice
  mode** (§2.1 step 2). Only `sclang` can tell, and the text test
  `field keys` uses to sort its shelf would refuse a program whose last
  expression is a SynthDef without reading `FIELD_MODE`. `field check`
  resolves the program and checks its knob file, and the render and
  `field keys` report a program that has no voice. Justin accepted this
  as built on 2026-10-16, and §2.1 step 2 says so.
- **Takes in samples render once more.** Their events join the action
  key, and `voice-render` is version 3, so each takes one new render;
  they play as they did.

The first seven rows of §4 pass, each in a test:

| §4 row | Test |
| --- | --- |
| A part placed at `[17]` on a track with `instrument: pad` | `src/graph/parts.test.ts`, "renders through the track's instrument, with the part and the instrument as inputs" |
| A note, the tempo, then `pad` changes | `src/graph/parts.test.ts`, "renders again when a note, the tempo, or the instrument changes" |
| One part at bars 1 and 17 of a steady song | `src/graph/parts.test.ts`, "is one render where two placements resolve alike" |
| A part across a change from 4/4 to 7/8 | `src/time/notes.test.ts`, "starts the part's second bar at the bar line after a meter change" |
| The four `field check` errors | `src/graph/parts.test.ts`, "refuses a notes entry with no instrument, a missing part, a note name that is not one, and an instrument on record:" |
| A MIDI take, then a tempo edit, then its entry moved; a take in samples | `src/commands/land.test.ts`, "writes the take in ticks" and "counts started_at_ticks from the tick its record entry starts on"; `src/generators/voice-render.test.ts`, "follows a tempo edit there", "moves with its record entry by the same musical distance", and "plays a take recorded in samples as it was recorded" |
| A take copied into a part at its position | `src/graph/parts.test.ts`, "has the take's action key when it is placed at the take's position" |
