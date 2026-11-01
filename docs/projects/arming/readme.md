---
status: in-progress
priority: now
---

# Arming

You arm the tracks you want to play or record, and `field keys` plays
every armed MIDI track's instrument in unison while `field record`
records every armed track, audio and MIDI, in one pass.

## 1 Problem

A song says what plays a part in its track files: a MIDI track is a
track whose `record:` entry names an instrument
([keyboard-instrument.md](../keyboard-instrument/readme.md) §12.2), and
it is that before it has a single take. Two commands act on parts, and
each takes exactly one thing.

- **`field keys <instrument>` takes a program, not a track.** To hear
  the part a track plays, you have to know which program its record
  entry names, and you cannot name a bus above it at all.
- **`field record <track>` records one track per pass.** The daemon
  holds one arm: one `capture`, one `activeCapture`, and one
  `activeMidiCapture` in `native/audiod/src/player.h`. Recording a
  vocal and the keys under it, or two MIDI parts, takes two passes, so
  the takes are two performances, not one.

Justin asked for both on 2026-10-11: play a MIDI track, or a track above
it with effects on it, and record audio, MIDI, or both, with the tracks
you choose armed and every armed MIDI track playing in unison.

## 2 Solution

Arming is a set of tracks. You arm tracks by naming them on the command
line: `field keys` and `field record` each take several targets. A
track resolves to the MIDI tracks it is or contains. `field keys` loads
every armed instrument into its one voice host and plays each key on
all of them at once. `field record` arms each track in the daemon, an
audio track on its own input channel and a MIDI track on the MIDI
sources, starts all of them on one latch, and lands each as its own
take. A lasting arm, set with `field arm` and the UI's arm buttons and
read by both commands, follows in chunk 3. Hearing an armed track
through the effects above it waits on
[live-supercollider](../live-supercollider/readme.md), which owns
getting the voice's audio into the daemon's graph; until then
`field keys` plays an armed track dry and says so.

### 2.1 Playing armed tracks

1. You run `field keys creek/track:keys creek/track:bass`. A target with
   no `track:` is an instrument, resolved as today
   (keyboard-instrument.md §2.1), so `field keys juno` is unchanged.
2. A track target arms the track itself when its record entry names an
   instrument. Otherwise it arms the tracks under it, down its `track:`
   inputs, whose record entries do. A target with none under it is an
   error. A target with more than one under it is an error that lists
   them, so you name the ones you mean: naming is how you choose.
3. The voice host loads every armed instrument's program. Each key
   starts one voice per instrument, and the bend, the modulation wheel,
   sustain, and release apply to all of them, through the voicer as
   today. Saving any of the programs reloads every one
   (keyboard-instrument.md §14); if one does not load, every voice
   stays as it was. *Amended (2026-10-11, live-supercollider.md chunk
   3):* when the tracks play through their effects, each armed track
   gets a voice of its own, even when two share an instrument, because
   each voice goes to its own input; an instrument named without a track
   still sounds once.
4. The instrument's line names each armed track and its instrument, as
   `keys (juno) + bass (bass) live at 48000 Hz on MacBook Pro Speakers`.
   When a track you named has inserts on the way down to its MIDI track,
   it ends `· dry: the effects on keys-bus are not heard yet`.
   *Amended (2026-10-11, live-supercollider.md chunk 3):* the voices now
   pass through the effects, and the note appears only when routing
   them is not possible, as `· dry: the effects on keys-bus are not
   heard (<why>)`.

### 2.2 Recording armed tracks

1. You run `field record creek/track:vox creek/track:keys --at 17`. Each
   target must be a track with a record entry; its instrument decides
   whether it records MIDI or audio, as today.
2. Audio tracks take input channels in the order you name them:
   `--input 1,2` gives the first audio track input 1 and the second
   input 2. With no `--input`, they take 1, 2, and on.
3. The daemon arms every track at once. One `record` starts them all on
   the same latch, so every take starts at the same bed position, and
   `--until` ends them all. Every armed MIDI track hears every MIDI
   source, so two armed MIDI tracks record the same notes: unison, as
   `field keys` plays them.
4. On stop, each transaction finalizes and lands on its own track as
   its own take, chosen, through the landing that exists today.
   `--loop` stays a one-track, audio-only feature in this plan.

### 2.3 Shapes

| Shape | Today | After |
| --- | --- | --- |
| `field keys` | `[instrument]` | `[targets...]`: instruments and tracks, mixed |
| `field record` | `[target]`, `--input <n>` | `[targets...]`, `--input <n>[,<n>...]` |
| `arm` request | `{track, input, device?}` or `{track, kind: "midi"}` | adds `{tracks: [{track, kind: "audio", input} \| {track, kind: "midi"}], device?}`; the one-track forms stay |
| `status.record` | one armed track's fields | adds `armed`, a list with each track's kind, its input when audio, and its level or events; the MIDI sources stay on `status.record`, shared by every MIDI track |
| `take` event and `stop` response | one take | one per armed track, each naming its `track` |

### 2.4 Files

| File | Change |
| --- | --- |
| `src/keys/targets.ts` (new) | Resolves `field keys` targets to armed instruments: a program, a MIDI track, or the MIDI tracks under a bus. |
| `src/commands/keys.ts`, `src/cli.ts` | Several targets; the instrument's line names each armed track and says when effects are not heard. |
| `sc/voice-host.scd`, `src/keys/voice-host.ts` | Several programs: one voice per program per key, a reload per program. |
| `native/audiod/src/player.cpp`, `player.h`, `server.cpp` | An arm set in place of the one arm: a capture per armed track, one latch, one stop. |
| `src/audiod/protocol.ts`, `client.ts` | The arm-set request, status, and takes. |
| `src/commands/record.ts`, `src/cli.ts` | Several targets and `--input` lists; land each take. |
| `docs/keys.md`, `docs/audio-engine.md` | Playing and recording armed tracks. |

## 3 Why this design (DECIDED, 2026-10-11, for Justin's review)

Justin decided the choices that matter, that tracks are armed by choice
and that armed tracks play in unison, and went to bed. The rest are
decided here with the alternative each beat, and any of them can be
overturned in review.

- **Arm by naming, first.** Both commands already take targets, so
  naming several is the smallest change that arms several. Rejected for
  now: a lasting arm state first. Where it lives is a real question
  (§7 question 1), and building it before anyone has armed two tracks
  would decide it blind.
- **A bus with several MIDI tracks under it refuses and lists them.**
  "They should be able to choose which tracks to arm": naming each is
  the choice. Rejected: arming everything under the bus, which would
  play a part you did not ask for.
- **Unison in one voice host.** One `scsynth` on one device, with a
  voice per instrument per key. Rejected: one host per instrument, which
  boots one server per instrument on the same device and multiplies the
  boot time. *Amended (2026-10-11, live-supercollider.md chunk 3):* still
  one host, now with a voice per armed track per key when the tracks
  play through their effects.
- **Every armed MIDI track records every MIDI source.** That is what
  unison means for recording, and it needs no routing. Rejected for now:
  routing by MIDI channel, so the keys and the bass could be played on
  different channels of one controller (§7 question 3).
- **Inputs follow the order you name the audio tracks.** Rejected: a
  per-target suffix such as `creek/track:vox@2`, which no other label
  in Field has.
- **Effects wait for live-supercollider.** The voice plays in its own
  `scsynth`, and a track's inserts run inside `field-audiod`; joining
  them is that plan's work.

## 4 Acceptance criteria

| # | Do | Expect |
| --- | --- | --- |
| 1 | In `examples/bloom`, give `creek` a track `keys` whose record entry has `instrument: juno` and no takes, and run `field keys creek/track:keys`. | `juno` plays, and the instrument's line names `keys`. |
| 2 | Add a track `keys-bus` whose only input is `track: keys`, with an insert, and run `field keys creek/track:keys-bus`. | `juno` plays, and the line says the effects on `keys-bus` are not heard yet. *Amended (2026-10-11, live-supercollider.md chunk 3):* `juno` plays through `keys-bus`'s insert, and the line says nothing about effects; with routing not possible, it says `· dry: the effects on … are not heard (<why>)`. |
| 3 | Add a track `bass` whose record entry has `instrument: bass`, put it under `keys-bus` too, and run `field keys creek/track:keys-bus`. | Exit 1, listing `keys` and `bass`. |
| 4 | Run `field keys creek/track:keys creek/track:bass` and press a key. | Both instruments sound the note at once. A held key and its release reach both. |
| 5 | Run `field keys creek/track:pad-sc`, a track with no record entry and nothing under it that has one. | Exit 1: no MIDI track there. |
| 6 | Run `field record creek/track:vox creek/track:keys --at 2`, play, sing, and stop. | Two takes land, one per track, both chosen, both starting at bar 2. |
| 7 | Run `field record creek/track:vox creek/track:vox2 --input 1,2`. | Each take holds its own input. |
| 8 | Run `field record creek/track:keys creek/track:bass` and play. | Both MIDI takes hold the same notes. |

Criteria 1 to 5 belong to chunk 1, 6 to 8 to chunk 2.

## 5 Cost

Unison multiplies voices: each key starts one voice per armed
instrument, and a chord of five keys on three instruments is fifteen
voices, which `scsynth` runs without strain. Recording several tracks
adds one capture per track: a lock-free queue the callback writes and a
writer thread that drains it, as one audio take uses today. A mono
float take is 192 KB/s at 48 kHz, so eight armed tracks write about
1.5 MB/s. The callback's added work is one copy per armed audio track
per block.

## 6 Rollout

1. **`field keys` on tracks, in unison.** Targets, the bus rule, the
   voice host with several programs, and the line. Criteria 1 to 5.
2. **`field record` on several tracks.** The daemon's arm set, the
   protocol, the client, `--input` lists, and landing each take.
   Criteria 6 to 8.
3. **A lasting arm.** `field arm` and `field disarm`, the arm set held
   where §7 question 1 decides, the UI's arm buttons, and both commands
   playing or recording the armed set when given no targets.

## 7 Open questions

1. **Where a lasting arm lives (chunk 3).** The daemon, so the UI and
   both commands share it while it runs, or `.field/`, so it survives
   the daemon. Justin decides before chunk 3.
2. **Loop takes on several tracks.** Chunk 2 refuses `--loop` with more
   than one armed track. Deferred until someone loops a pass with two
   parts.
3. **Routing MIDI by channel.** Arming `keys` on channel 1 and `bass` on
   channel 2 of one controller, instead of unison. Deferred until a
   controller with split zones is in use.

## 8 Background

- `resolveInstrument` in `src/commands/keys.ts` resolves a program
  name or path; nothing resolves a track to its instrument.
- `recordNodeFor` in `src/commands/land.ts` finds a track's one record
  entry; `resolveRecordTarget` in `src/commands/record.ts` accepts
  exactly one label.
- The voice host loads one program into `voiceDef`
  (`sc/voice-host.scd`); the voicer's `start` returns one voice, and
  any value works as a voice, so a list of synths is a voice too.
- The daemon's single arm is `armedTrack`, `armedInput`, `capture`,
  `activeCapture`, `activeMidiCapture`, and `standbyCapture` in
  `native/audiod/src/player.h`; an arm of the other kind replaces it
  (`docs/audio-engine.md` "MIDI capture").

## 9 Chunk 1 as built (2026-10-11)

`field keys` takes any number of targets. `src/keys/targets.ts`
resolves them, holding `resolveInstrument` and the shelf listing too,
which moved there from `src/commands/keys.ts`. A target with `track:`
in it goes through `resolveRecordTarget`, and then down the track's
`track:` inputs to the tracks whose record entries name an instrument.
The voice host takes `FIELD_INSTRUMENTS`, a JSON list, loads each
program, and renames each SynthDef for its place in the list, so two
programs that name their voices alike both play. Each key starts a
voice from every program; the voicer needs no change, because a list of
synths is a voice. A save of any program reloads them all, and if one
does not load, every voice stays as it was.

| Check | Result |
| --- | --- |
| `src/keys/targets.test.ts` | A MIDI track with no takes arms its instrument; a bus with an EQ over it arms the track under it and names `keys-bus` as unheard; a bus over two MIDI tracks lists both and stops; a track with none under it says so; several targets, mixed and repeated, arm each once. |
| `src/keys/voice-host.test.ts` | The host receives `FIELD_INSTRUMENTS` as a JSON list. |
| The real host with two silent programs that both name their SynthDef `\quiet`, a note from `field-audiod --keys` | Live, then a voice on and a voice off for the note, with no error. |

Still owed: criterion 4 by ear, hearing two instruments sound one key.

## 10 Chunk 2 as built (2026-10-11)

`field record` takes any number of tracks. `planArm` in
`src/commands/record.ts` resolves each to its record entry and kind,
refuses a track named twice, tracks in two songs, MIDI-only sets with
audio flags, and `--loop` with more than one track, and gives each audio
track its `--input` in order. One track arms as before; several arm
through the daemon's `arm` with `tracks`.

In the daemon, the first armed track is the *primary*, and every capture
rule that existed runs on it unchanged: the latch, the count-in,
punch-out, and loop takes. The others are *companions* in fixed slots
the callback reads through atomics. They start on the primary's latch,
an audio companion pushes the same span of its own input, and they end
with its pass. An audio track is the primary whenever one is armed, so
`--until` still cuts audio on its exact sample. The MIDI clock's
stamping, which a MIDI take had inline, is now one step that a MIDI
primary's companions mirror and that an audio primary's MIDI companions
run on their own. Those end a block after the audio, as a MIDI take
ends, and the pass finalizes when every take has. `stop` returns every
manifest, `status.record` lists `armed`, and `recordings` and `recover`
know every take in flight. The null input presents each armed channel
in order, so a test can tell input 1's sawtooth from input 2's constant.

| Check | Result |
| --- | --- |
| `src/commands/record-tracks-daemon.test.ts`, against the daemon in null mode | Two audio tracks on inputs 1 and 2: one take holds the sawtooth, the other the constant, with the same start and length; an input or a track armed twice is refused, and so is a loop over two; a set the daemon refuses leaves the arm before it as it was. An audio and a MIDI track: both takes start together, and the MIDI one holds the note. A punch-out at 24000 over a live session: the audio take is 24000 frames, the MIDI take ends a block later at 24000, and both land. Two MIDI tracks hold the same notes. `field record` with an audio and a MIDI track lands both, each on its own track, `field transport status` names both while they record, and `field check` is clean. The MIDI cases skip on Windows, which has no virtual MIDI ports. |
| `src/commands/record-plan.test.ts` | Inputs 1, 2, and on by default, `--input` in order, and each refusal. |
| The existing daemon tests (`record-daemon`, `punch-daemon`, `record-midi-daemon`, `click-daemon`, `play-daemon`) | All pass against the reworked daemon: one track records exactly as before. |

Found along the way, and not this chunk's: an audio punch-out against a
*file* bed ends 3 samples short of `until` (24000 asked, 23997 taken),
with one track as with several. A live session's position is exact, so
the punch-out tests, which use one, never saw it. A file bed's position
comes from JUCE's transport, which reports a few samples ahead of what it
has delivered. audiofield/field#194 tracks it. Still owed: criteria 6
to 8 by hand, on a real interface with two inputs and a controller.
