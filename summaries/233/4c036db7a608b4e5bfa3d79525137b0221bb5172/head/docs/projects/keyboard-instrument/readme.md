---
status: in-progress
priority: now
---

# Keyboard instrument

**Goal:** `field keys` turns the computer keyboard into a MIDI device
that any application can play from, through a keymap you choose or
write yourself, and `field keys <instrument>` plays a SuperCollider
instrument from it live, so you can audition an instrument under your
fingers. Recording what you play comes last.

## 1 The problem

Field makes sound only by rendering. A SuperCollider instrument in
`shared/instruments/` is a program that `sclang` runs offline, in
scsynth's non-realtime (NRT) mode, from a spec passed in environment
variables: seed, duration, sample rate, and channels. It writes one WAV
and exits ([sc-render.md](../sc-render/readme.md) §2). Nothing in Field
takes notes. No code opens a MIDI input, the daemon hands every hosted
plugin an empty `juce::MidiBuffer`, and no command reads the keyboard
as anything but commands.

So the only way to hear an instrument is to edit its program, render
it, and play the file. That loop suits a pad that renders a fixed
chord. It cannot tell you how a sound responds to a player, which is
how a player judges an instrument. The design expects both:
[project-layout.md](../project-layout/readme.md) §4.6 says the same
`.scd` renders from a spec in one place and responds to notes in
another, depending on how it is invoked. Only the first half exists.

## 2 The solution

`field keys` reads key presses and releases from the terminal, finds
the physical key behind each one, and looks it up in a *keymap*: a YAML
file that says what each key plays. Logic Pro's Musical Typing is the
default keymap, two alternatives are built in, and you can write your
own. `field keys` publishes the result as a virtual MIDI source named
`Field Keys`, through a small mode of `field-audiod`. Given an
instrument, it also starts a *voice host*: an `sclang` process that
boots its own `scsynth` on the output device, loads the instrument's
*voice* (one SynthDef that plays one note), and plays it from every
MIDI source. A USB controller therefore plays the same voice as the
keyboard does. Last, recording captures the notes of a performance as a
take, timed by the daemon against the song's transport and rendered
offline through the same voice, so a recorded part builds like any
other node.

Three words carry the design, and each names one thing:

- **Position.** A physical key, written as its W3C `KeyboardEvent.code`
  value, such as `KeyA`, `Semicolon`, `Digit1`, or `Space`. The name
  comes from the key a US keyboard has in that place, but it means the
  place, whatever the key types.
- **Keyboard layout.** The operating system's map from position to
  character: QWERTY, Dvorak, AZERTY. It decides what a key types.
- **Keymap.** Field's map from position to what the key plays: a note,
  a chord, or a control such as transpose or sustain. It ends at MIDI,
  and the instrument decides the sound.

### 2.1 What happens when you play

1. You run `field keys pad` in Ghostty or iTerm2, inside a
   project.
2. `field keys` checks that the terminal speaks the kitty keyboard
   protocol (§2.2). If it does not, the command exits with a message
   that names terminals that do.
3. It loads the keymap: Musical Typing, unless `--keymap` or
   `FIELD_KEYMAP` names another (§2.4). A keymap that fails validation
   stops the command with its errors.
4. It spawns `field-audiod --keys "Field Keys"`. The helper creates the
   virtual source with JUCE's `MidiOutput::createNewDevice`, reports
   the keyboard layout, and prints a ready line (§2.5).
5. It adds `.scd` to an instrument name that has no extension, and
   resolves the result exactly as a `supercollider:` entry resolves
   `source:`, to `shared/instruments/pad.scd`. Then it
   spawns `sclang` on the voice host, `sc/voice-host.scd`, with the
   instrument path, the output device, and an `scsynth` port in the
   environment.
6. The voice host boots `scsynth`, runs the instrument program with
   `FIELD_MODE=voice`, adds the SynthDef the program returns, connects
   every MIDI source, and prints a ready line. The instrument's line in
   `field keys`, above the status line, shows it as live, with the
   device and its sample rate.
7. You press `KeyA`, the key a US keyboard labels `A`. The terminal
   reports the press, and `field keys` finds its position (§2.3),
   whatever your keyboard layout types there. Musical Typing maps
   `KeyA` to note 60 at the current transpose and velocity. `field keys`
   writes a note-on to the helper and remembers that `KeyA` holds note
   60.
8. The helper sends the note-on from `Field Keys`. CoreMIDI delivers it
   to the voice host, which starts a voice with `freq` 261.63, `amp`
   from the velocity, and `gate` 1.
9. You release `KeyA`. `field keys` sends a note-off for the note that
   `KeyA` started, which is 60 even if you transposed while you held
   it. The voice host sets that voice's `gate` to 0, and the voice
   frees itself when its envelope ends.
10. You press `Esc` or `Ctrl-C`. `field keys` sends a note-off for each
    held note and then All Notes Off (CC 123), and restores the
    terminal. It closes the helper's input, which removes `Field Keys`.
    Last, it sends `/quit` to `scsynth` and stops `sclang`.

Without an instrument, `field keys` stops after step 4 and is a MIDI
device for Logic, the SuperCollider IDE, or anything else that lists
MIDI inputs.

Two keys can hold the same note. A chord can share a note with
another key, and a transpose can move one key onto a note that
another key still holds: hold `KeyA`, press `KeyZ`, and `KeyK` plays
60 too. The session counts the keys that hold each note. The first
press sends the note-on, and the note-off waits until the last of
those keys is released, so every note-on gets exactly one note-off.

### 2.2 Key releases come from the kitty keyboard protocol

A terminal normally reports only key presses, as the text they type,
and repeats a held key. A note needs its release. The kitty keyboard
protocol adds press, repeat, and release events for a program that
asks for them. Ghostty, iTerm2 3.5 and later, kitty, WezTerm, and foot
implement it. Apple's Terminal does not.

| Step | Bytes `field keys` writes | Why |
| --- | --- | --- |
| Probe | `CSI ? u`, then `CSI c` | A terminal with the protocol answers `CSI ? <flags> u` before its answer to `CSI c`. A terminal that answers only `CSI c` lacks it. |
| Enable | `CSI > 15 u` | Pushes flags 1, 2, 4, and 8. Flag 2 reports event types. Flag 8 reports letter keys as escape codes, which is what gives them release events. Flag 4 adds the base layout key, one of the two sources of a key's position (§2.3). |
| Focus | `CSI ? 1004 h` | Turns on focus reports. On focus-out (`CSI O`), `field keys` releases every held note, because a terminal that has lost focus never reports the release. |
| Restore | `CSI < u`, `CSI ? 1004 l` | Pops the flags and turns off focus reports, on every exit path, including a thrown error. |

In raw mode `Ctrl-C` never raises `SIGINT`, and under the protocol it
arrives as an escape sequence (`CSI 99;5 u`), so `field keys` handles
it as a key. It ignores repeat events: holding a key holds its note.

### 2.3 Keys are read by position

A keymap is geometry: black keys sit between white keys because of
where the keys are, not because of what they type. So `field keys`
looks up positions, never characters. On Dvorak, `KeyS` types `o`. On
AZERTY, `KeyA` types `q`. Both still play what `KeyS` and `KeyA` play
on QWERTY, and nobody has to switch their keyboard layout back to play.

A terminal sends characters, so `field keys` recovers the position
from two sources:

1. **The terminal's base layout key.** Under flag 4, the kitty protocol
   lets a terminal add the key that has the same physical position on
   the standard PC-101 (US) keyboard. Ghostty sends it. The protocol
   makes it optional, and a terminal leaves it out when it equals the
   typed key. So a missing base layout key means either a QWERTY
   keyboard layout or a terminal that does not send one, and
   `field keys` cannot tell which.
2. **The keyboard layout, read on macOS.** The helper reads the active
   keyboard layout with the Text Input Sources API. macOS key codes
   name positions, not characters: `kVK_ANSI_A` is `KeyA` on every
   keyboard layout. For each position any keymap can bind, the helper
   asks `UCKeyTranslate` what that key code types with no modifiers,
   and notes whether it is a dead key. It sends `field keys` the
   result at start, and again whenever the selected input source
   changes, so switching keyboard layouts mid-session needs no restart.

`field keys` takes the base layout key when the terminal sends one.
Otherwise it looks the reported character up in the keyboard layout
the helper sent. On QWERTY that lookup returns the character's own
position. On Linux there is no helper report in this plan, so
`field keys` relies on the terminal's base layout key alone.

A dead key types nothing on its own and waits to combine with the next
key, such as `'` on U.S. International. The terminal holds it for
composition, so `field keys` may never see it. When the keyboard layout
has a dead key at a position the keymap binds, the status line names
that position as one that cannot play on this keyboard layout, rather
than leaving a silent key.

### 2.4 Keymaps are files, and Musical Typing is the default

A keymap is a YAML file, and the built-in keymaps use the same format
as yours. A zod schema in `src/schema/keymap.ts` checks every keymap
before `field keys` uses it. The built-ins live in `keymaps/` at the
package root, found the way `python/` is.

| Built-in | What it plays | Chunk |
| --- | --- | --- |
| `musical-typing` (default) | Logic Pro's Musical Typing: white keys from `KeyA` to `Quote`, black keys on the row above, controls on `KeyZ` to `KeyV`, `Tab`, and the number row. 18 notes. | 1 |
| `tracker` | The tracker keymap: the `KeyZ` row and the `KeyQ` row as two piano octaves, with black keys on the row above each. Controls on the arrows and `Space`. 32 notes. | 3 |
| `fourths` | An isomorphic grid: one semitone per key to the right, each row a perfect fourth above the row below. Controls on the arrows and `Space`. 27 notes. | 3 |

#### Choosing a keymap

| You give | `field keys` loads |
| --- | --- |
| Nothing | `musical-typing` |
| `--keymap fourths` | The built-in `fourths`. A bare name only ever names a built-in. |
| `--keymap ~/keymaps/mine.yaml` | That file. A value with a `/`, or ending in `.yaml`, is a path, and a leading `~/` means your home directory. |
| `FIELD_KEYMAP=<name or path>` | The same, when there is no `--keymap`. Set it in your shell to make your own keymap the default. |

When the keymap is a file you gave by path, `field keys` reloads it
when you save it. The next key press uses the new keymap, and notes
already sounding finish with the notes they started. If the saved file
fails validation, `field keys` keeps the keymap it has and shows the
first error in the status line.

`field keys` watches the directory that holds the keymap, not the file,
and reacts to changes to the keymap's name. Many editors save by
writing a temporary file and renaming it over the original. On macOS
and Linux, Node's `fs.watch` on a file keeps watching the original
file, so a watch on the keymap itself would end at the first such save.
`field keys` reloads only when the file's text has changed, because
macOS can report a write made just before the watch began, or an event
with no file name.

`field keys --print` prints the keymap as a keyboard-shaped diagram,
one line per keyboard row, with the note or control in each key's
place, and exits. It names notes in scientific pitch notation, where
MIDI note 60 is C4. It needs neither the protocol nor the helper, so it
works in any terminal, including while you edit a keymap.

#### The format

```yaml
# keymaps/musical-typing.yaml
name: musical-typing
description: Logic Pro's Musical Typing. White keys on the home row, black keys above.
base: 60
notes:
  KeyA: 0
  KeyW: 1
  KeyS: 2
  KeyE: 3
  KeyD: 4
  KeyF: 5
  KeyT: 6
  KeyG: 7
  KeyY: 8
  KeyH: 9
  KeyU: 10
  KeyJ: 11
  KeyK: 12
  KeyO: 13
  KeyL: 14
  KeyP: 15
  Semicolon: 16
  Quote: 17
controls:
  KeyZ: { transpose: -12 }
  KeyX: { transpose: 12 }
  KeyC: { velocity: -20 }
  KeyV: { velocity: 20 }
  Tab: { cc: 64, value: 127, mode: hold }
  Digit1: { bend: -1 }
  Digit2: { bend: 1 }
  Digit3: { cc: 1, value: 0 }
  Digit4: { cc: 1, value: 25 }
  Digit5: { cc: 1, value: 51 }
  Digit6: { cc: 1, value: 76 }
  Digit7: { cc: 1, value: 102 }
  Digit8: { cc: 1, value: 127 }
```

| Field | Default | Meaning |
| --- | --- | --- |
| `name` | Required | Shown in the status line. |
| `description` | None | One line, shown by `--print`. |
| `base` | 60 | The MIDI note that offset 0 plays before any transpose. |
| `velocity` | 100 | The starting velocity. |
| `channel` | 1 | The MIDI channel, 1 to 16. |
| `notes` | None | Each position to an offset in semitones from `base`, or to a list of offsets, which plays a chord from one key. |
| `grid` | None | Assigns offsets to whole rows by a rule (below). An entry in `notes` or `controls` overrides the grid at that position. |
| `controls` | None | Each position to an action (below). |

A grid writes an isomorphic keymap in one line instead of forty:

```yaml
# keymaps/fourths.yaml
name: fourths
description: One semitone per key, each row a fourth above the row below.
base: 48
grid: { rows: [bottom, home, top, number], column: 1, row: 5 }
controls:
  ArrowLeft: { transpose: -12 }
  ArrowRight: { transpose: 12 }
  ArrowDown: { velocity: -20 }
  ArrowUp: { velocity: 20 }
  Space: { cc: 64, value: 127, mode: hold }
```

| Grid field | Meaning |
| --- | --- |
| `rows` | The rows, lowest first. Each is a named row or a list of positions. The named rows are `bottom` (`KeyZ` to `Slash`), `home` (`KeyA` to `Quote`), `top` (`KeyQ` to `BracketRight`), and `number` (`Digit1` to `Equal`). In a list, `null` skips a column, which aligns rows the way you want. |
| `column` | Semitones per key to the right. |
| `row` | Semitones per row up. |

The offset of a position is `column` times its index in its row, plus
`row` times its row's index. In `fourths`, `KeyZ` plays 48, `KeyA` 53,
`KeyQ` 58, and `Digit1` 63.

| Action | Effect |
| --- | --- |
| `transpose: <n>` | Shifts every new note by n semitones, and stays shifted. `field keys` refuses a transpose that would move any bound note outside 0 to 127. |
| `velocity: <n>` | Changes the velocity by n, kept between 1 and 127. |
| `bend: <x>` | Pitch bend to x, from -1 to 1 of the full range, while held. Back to center on release. |
| `cc: <n>`, `value: <v>`, `mode: <m>` | Controller n. Mode `set`, the default, sends v at each press. `hold` sends v while held and 0 on release. `toggle` alternates v and 0 at each press. `value` defaults to 127. |
| `panic` | Releases every note and sends All Notes Off. It is written as a bare word: `Backquote: panic`. |

The schema enforces these rules, and an error names the position and
the rule it breaks:

- **Every position is a known `KeyboardEvent.code` value.** The
  bindable positions are the four named rows, `Backquote`, `Backslash`,
  `IntlBackslash`, `Space`, `Tab`, and the four arrows.
- **A position is a note or a control, never both.**
- **`Escape` is reserved.** It always quits, and so does `Ctrl-C`, so
  no keymap can trap you. *Amended (2026-10-11, instrument-knobs.md
  chunk 2):* `Escape` cancels a typed knob value and no longer quits;
  with no value open it says that `Ctrl-C` quits. `Ctrl-C` always
  quits, and no keymap binds `Escape` or a `Ctrl` chord, so no keymap
  can trap you still ([instrument-knobs.md](../instrument-knobs/readme.md)
  §2.7, §3.1).
- **Modifiers do not bind.** A key pressed while `Ctrl`, `Alt`, or
  `Cmd` is held does nothing, and a key pressed with `Shift` plays as
  it does without it. Caps Lock and Num Lock change nothing: under
  flag 8 the protocol sets their bits on every key while the lock is
  on, and `field keys` ignores those bits. A release always ends the
  notes its press started, whatever modifiers it carries, so pressing
  `Ctrl` while a note sounds cannot leave the note stuck. Layers that
  `Shift` or another held key switches to are an open question (§7).
- **Every note is in MIDI's range.** Each note at `base` is between 0
  and 127.
- **A keymap plays at least one note.** One with only controls is
  rejected, because it would start a source that can never sound.

Musical Typing's `KeyA` plays MIDI note 60, which Logic names C3 and
most other tools name C4. Its velocity steps by 20, as Ableton Live's
computer keyboard does. Apple's guide says `Tab` turns sustain on or
off, which reads as a toggle. The keymap holds sustain only while `Tab`
is down, as a pedal does. A keymap of your own can choose `toggle`.

One status line shows the keymap's name, the transpose, the velocity,
and last the held notes, so playing changes only the end of the line.
An instrument's state has a line of its own above it, redrawn only when
the state changes. Both are drawn with raw ANSI codes the way
`src/commands/picker.ts` draws, so they need no new dependency.

### 2.5 The helper is the native half of `field keys`

`field-audiod --keys <name>` is a short-lived mode like `--scan`. It is
a separate process from the shared daemon and never touches the
transport. It publishes the virtual source, reports the keyboard
layout, and speaks NDJSON:

| Direction | Line | Meaning |
| --- | --- | --- |
| helper to `field keys` | `{"keyboard":{"name":"Dvorak","keys":{"KeyA":"a","KeyS":"o",…},"dead":[]}}` | The active keyboard layout: the character each bindable position types, and the positions that are dead keys. Sent before `ready`, and again when the keyboard layout changes. macOS only. |
| helper to `field keys` | `{"ready":true,"name":"Field Keys","output":"MacBook Pro Speakers"}` | The virtual source exists. On macOS, `output` names the system output, which the voice host gives `scsynth` when there is no `--device` (§10.1). |
| `field keys` to helper | `{"midi":[144,60,100]}` | Send these bytes now, as one message. |
| helper to `field keys` | `{"error":"…"}`, then exit 1 | The platform cannot create a virtual source, or a line did not parse. |

At the end of its input, the helper closes the source and exits 0. So
when `field keys` exits for any reason, `Field Keys` disappears with
it. The helper knows nothing about notes or keymaps. That logic is
TypeScript, which vitest covers without the native build.

A second mode, `field-audiod --midi-monitor <name>`, prints every
message from the named source as an NDJSON line. The round-trip test
uses it (§4), and it answers "is my controller sending anything" by
hand.

JUCE creates virtual sources through CoreMIDI on macOS and through the
ALSA sequencer on Linux. On Windows it cannot, so the helper reports an
error and `field keys` passes the message on.

### 2.6 The voice contract

An instrument becomes playable by answering a second mode. The render
contract in sc-render.md §2 does not change, and this plan calls it
*render* mode. When `FIELD_MODE` is `voice`, the program must not
render or exit. The value of the file, which is its last expression,
must be a SynthDef with these controls:

| Control | What the voice host sets |
| --- | --- |
| `freq` | The note's frequency in Hz (`note.midicps`) |
| `amp` | `velocity / 127` |
| `gate` | 1 at note-on, 0 at note-off |
| `out` | The output bus, 0. *Amended (2026-10-11, live-supercollider.md chunk 3):* the bus to write to, 0 straight to the device or a private bus through a track's effects; a voice must write to `out`, never to bus 0 itself |
| `mod` | Optional, added in §14: the modulation wheel (CC 1), from 0 to 1 |

The voice writes two channels to `out` and frees itself after `gate`
goes to 0, with an envelope that ends in `doneAction: 2`. The render
variables (`FIELD_OUTPUT`, `FIELD_SEED`, and the rest) are absent in
voice mode, so a program checks `FIELD_MODE` before it reads them:

```supercollider
(
if ("FIELD_MODE".getenv == "voice") {
	SynthDef(\padKey, { |out = 0, freq = 220, amp = 0.5, gate = 1|
		var env = EnvGen.kr(Env.asr(1.5, 1, 2.5, \sine), gate, doneAction: 2);
		var sig = SinOsc.ar(freq) + (0.35 * SinOsc.ar(freq * 2));
		Out.ar(out, Pan2.ar(sig * amp * 0.2 * env));
	})
} {
	// render mode: the program as it reads today
}
)
```

The voice host owns everything between MIDI and voices:

- **One voice per sounding note.** A note-on for a note that is still
  sounding releases the old voice first.
- **Sustain.** While CC 64 is 64 or more, note-offs wait, and lifting
  the pedal releases them.
- **All Notes Off.** CC 123 releases every voice.
- **Pitch bend.** The host sets `freq` on every sounding voice to its
  note bent by up to two semitones either way, so the contract gains no
  control for it.
- **Modulation.** This chunk's host ignored CC 1; §14 gives the
  contract an optional `mod` control for it.
- **Every source and channel.** The host connects every MIDI source at
  start. A controller plugged in later needs a restart.
- **Device and rate.** `scsynth` opens the device from `--device`, or
  the system output when you give none, which is how `field play`
  chooses. The host never sets a sample rate, so `scsynth` runs at the
  device's current rate and never changes it under a running `field
  play`. It asks for a 128-frame hardware buffer.
- **A rate change restarts the server.** A `field play` that starts
  after the host still moves the device to the rate of the song or
  file it plays, when the device can switch (playback.md §3.5). On
  macOS `scsynth` never notices: its CoreAudio driver listens for no
  rate change and keeps computing at the rate it booted at, so every
  voice plays sharp or flat, by about a semitone and a half between
  44.1 and 48 kHz. Each `/status` reply carries both the rate
  `scsynth` booted at and the rate it measures from the device's
  clock, and `sclang` asks for one every 0.7 seconds. When the two
  rates differ by more than 1%, the host quits `scsynth`, boots it
  again on the same port at the device's new rate, adds the voice
  again, and prints its ready line again with the new rate. Notes
  sounding at the switch stop.
- **No inputs.** The host sets no input channels and names the output
  device as `scsynth`'s input device too, so `scsynth` never opens the
  microphone. No input channels alone is not enough: §10.1 records why,
  and this bullet said otherwise until chunk 2 found it.
- **No orphans.** `field keys` chooses the `scsynth` port, so it can
  send `/quit` even if `sclang` has died. The host checks once a second
  that `field keys` is alive, and if it is not, the host quits
  `scsynth` and exits.

If `sclang` exits before its ready line, or the program's value is not
a SynthDef, `field keys` exits 1. It prints the last lines of `sclang`'s
output, because `sclang` reports errors there, as `runScProgram`
already does. It also names the cause: the program does not answer
`FIELD_MODE=voice`.

### 2.7 Recording the keys

The fourth chunk records a performance against the song. It mirrors
audio recording ([recording.md](../recording/readme.md) §3 and §4), and
§7 holds the questions it settles before it starts:

1. You arm a track and play the keyboard while the song plays. The
   voice host is how you hear yourself.
2. The daemon opens the MIDI sources and stamps each event on the
   transport's sample clock. That is the clock that places an audio
   take as `started_at_samples`.
3. On stop, the take lands as an audio take does: a timestamp-named
   file under `audio/<track>/`, a row in `takes.yaml`, and `chosen`,
   which `field choose` moves.
4. The build renders the chosen take offline. `sc/voice-render.scd`
   builds a score from the take's notes with the voicing the voice host
   plays, runs it in NRT mode, and writes audio that the build caches
   like a `supercollider:` render (§12.3).

### 2.8 Files

| File | Change |
| --- | --- |
| `src/keys/terminal.ts` (new) | Probes, enables, and restores the kitty protocol and focus reports, and decodes key events, with their base layout keys, from stdin bytes. The decoder is a pure function over bytes. |
| `src/keys/position.ts` (new) | Finds a key event's position from its base layout key or, failing that, the keyboard layout the helper reported, and finds the dead-key positions the status line names (§2.3). |
| `src/schema/keymap.ts` (new) | The zod schema for keymap files: the fields, the grid, the actions, and the rules in §2.4. It also expands a grid into offsets, because the range rule needs the expanded notes. |
| `src/keys/keymap.ts` (new) | Resolves `--keymap` and `FIELD_KEYMAP` to a built-in or a path, loads and validates the file, and watches the directory of a keymap given by path to reload it. |
| `src/keys/print.ts` (new) | The `--print` diagram. |
| `src/commands/keys.ts` (new) | The interactive shell: probes the terminal and gives it back on every exit, starts the helper, plays key events through positions and the session, draws the status line, and reloads a keymap given by path. |
| `keymaps/musical-typing.yaml` (new) | The default keymap. |
| `keymaps/tracker.yaml`, `keymaps/fourths.yaml` (new, chunk 3) | The other built-ins. Chunk 1's schema tests carry both as fixtures, so the format is known to express them before they ship. |
| `src/keys/session.ts` (new) | The note state: which position holds which notes, transpose, velocity, controller modes, pitch bend, and releasing every note on focus-out and on quit. Emits MIDI bytes. |
| `src/keys/helper.ts` (new) | Spawns and talks to `field-audiod --keys`, found with `daemonBinary()` from `src/audiod/client.ts`, and passes each keyboard layout report to `position.ts`. |
| `src/keys/voice-host.ts` (new) | Resolves the instrument with `programPath()` from `src/generators/supercollider.ts`, picks the `scsynth` port, spawns and waits for the host, and quits it. |
| `src/generators/supercollider.ts` | Extracts the `sclang` lookup (`FIELD_SCLANG`, then `PATH`, then the app bundle) into `sclangCommand()`, shared by `runScProgram` and the voice host. |
| `sc/voice-host.scd` (new) | The voice host (§2.6). Found from the package root, as `python/` is. |
| `src/cli.ts` | `field keys [instrument] [--device <name>] [--keymap <name or path>] [--print]`. |
| `native/audiod/src/keys.cpp`, `keys.h` (new), `main.cpp` | The `--keys` and `--midi-monitor` modes. |
| `native/audiod/src/keyboard-layout.cpp`, `keyboard-layout.h` (new) | Reads the keyboard layout and watches for input-source changes, on macOS. Elsewhere it reports nothing. |
| `native/audiod/CMakeLists.txt` | Links the Carbon framework on macOS, for the Text Input Sources API. |
| `examples/bloom/shared/instruments/pad.scd` | Answers voice mode with a gated version of its voice. The render branch keeps its code. |
| `docs/keys.md` (new) | How to play with `field keys`, the supported terminals, the built-in keymaps, and the keymap format as a reference for writing your own. `docs/README.md` links it. |
| `docs/build-graph.md` | The `supercollider` section gains voice mode beside the render contract. |
| `docs/architecture.md` | The daemon's modes gain `--keys` and `--midi-monitor`. The SuperCollider section's live mode describes the voice host and where its sound goes. |
| `README.md` | `field keys` beside `field play`, linking `docs/keys.md`. |

Chunk 4 adds its files when it appends its section (§6).

## 3 Why this design (DECIDED, 2026-10-10)

- **A virtual MIDI device, not a line straight to SuperCollider.**
  `field keys` could send OSC to `scsynth` and skip MIDI. Going through
  CoreMIDI costs one helper process and well under a millisecond. In
  return, a USB controller plays the voice host with no code of its
  own, and `Field Keys` plays Logic. Recording reads MIDI sources for
  the same reason: it records a controller and the keyboard alike.
- **CoreMIDI through `field-audiod`, not an npm module.** An RtMidi
  binding such as `@julusian/midi` would put the virtual source inside
  the Node process. It would also be the control plane's first native
  npm dependency, with prebuilt binaries per platform and per Node ABI.
  The control plane has three runtime dependencies today, none of them
  native. `field-audiod` already links `juce_audio_devices`, which holds
  `MidiOutput::createNewDevice`, and it already runs short-lived modes
  such as `--scan` and `--render`. The architecture keeps
  hardware-facing work and JUCE inside the daemon, and a mode keeps both
  true. The cost is that `field keys` needs `pnpm build:native`, as
  `field play` already does for everything beyond `afplay`.
- **The kitty protocol, not a guess at releases.** Every alternative is
  worse. Inferring a release from the end of auto-repeat is late by the
  repeat delay, about half a second on macOS, and misses short taps.
  Fixed-length notes make every sustained sound unplayable. Capturing
  the keyboard globally, through `CGEventTap` or IOKit HID, needs the
  Input Monitoring permission, plays notes while another window has
  focus, and moves keyboard handling into native code. Refusing Apple's
  Terminal costs one message.
- **Positions from two sources, not characters.** Looking up characters
  is the obvious version, and it breaks every keyboard layout but
  QWERTY. On Dvorak the home row types `a o e u i d h t n s -`, so the
  white keys would scatter across the keyboard, and the only fix would
  be switching back to QWERTY to play. VMPK, the open-source virtual
  MIDI keyboard, offers both kinds of map and documents the same
  trade: a character map needs adapting for each language, and a
  key-code map does not. The terminal's base layout key alone is not
  enough: the protocol makes it optional, a terminal omits it when it
  equals the typed key, and so its absence cannot be told apart from a
  terminal that never sends it. Reading the keyboard layout alone is
  not enough either, because it reverses the layout's output, which is
  indirect where the terminal can name the position itself. So the
  terminal's answer wins when there is one, and the keyboard layout
  covers every terminal that gives none. The helper reads it because
  the API is native, and the helper is already the native process
  `field keys` runs.
- **Keymaps are data files that the built-ins use too, not tables in
  code.** Keymaps written as TypeScript tables would make the built-ins
  privileged, and a keymap of your own would need a code change and a
  rebuild. A script per keymap would load arbitrary code from a path,
  and could be neither validated nor printed without running it. A data
  format can be validated, printed, diffed, and reloaded on save, and
  new behavior arrives as a new action in the schema. The grid exists
  because an isomorphic keymap is a rule, and forty hand-typed offsets
  invite a typo that the rule cannot make.
- **Positions named by `KeyboardEvent.code`, not by characters.** The
  W3C UI Events specification already gives each physical key one name,
  taken from the US key in that place, which is exactly what a position
  is. Characters fail as names: YAML needs quotes around `'`, `[`, `#`,
  and others, and no character names `Space`, `Tab`, or an arrow.
- **A bare name is a built-in, and anything else is a path.** Field
  resolves programs the same way: a bare spelling resolves in one home,
  an explicit spelling escapes, and there is never a search path
  (`programPath()` in `src/generators/supercollider.ts`). A search path
  through a directory of your keymaps would let your file shadow a
  built-in, or a new built-in shadow your file after an upgrade.
  `FIELD_KEYMAP` makes your keymap the default without a config file.
- **No keymap shelf in the project.** A keymap belongs to the player,
  not to a song. The shared shelves that project-layout.md §4.6
  settled hold what makes, is, or changes sound, and a keymap does
  none of those.
- **Musical Typing as the default, with the others built in.** It is
  the keymap musicians already know from a computer keyboard, because
  Logic Pro and Ableton Live share it, and it leaves the number row free
  for pitch bend and modulation. Its weakness is range: 18 notes before
  you transpose. The two other built-ins widen the range and lose the
  default on other counts:

  | Keymap | Range | Who knows it | Why it is not the default |
  | --- | --- | --- | --- |
  | `musical-typing` | 18 notes | Logic and Ableton Live users | Chosen |
  | `tracker` | 32 notes | Tracker users, from FastTracker 2 to Renoise | It spends the number row on black keys and the `KeyZ` row on notes, so its controls move to the arrows and lose pitch bend and modulation. The octaves zig-zag between rows. |
  | `fourths` | 27 notes | Players of Ableton Push in fourths, LinnStrument, bass, and guitar | It is unfamiliar to keyboard players, has no piano shape, and spends every row on notes. Its gain beyond range is that a chord shape plays the same in every key. |

  *Amended (2026-10-11, instrument-knobs.md chunk 1):* `musical`, Field's
  adaptation of Musical Typing, replaces `musical-typing` as the default.
  It keeps every note and the octave, velocity, and sustain keys, moves
  the bend to `Comma` and `Period`, and spends the arrows on knobs,
  where the modulation wheel is the knob `mod`
  ([instrument-knobs.md](../instrument-knobs/readme.md) §2.3, §3.2).

- **`sclang` turns MIDI into voices, not TypeScript.** The voice host
  is SuperCollider's own idiom (`MIDIdef`, `Synth`, `set(\gate, 0)`),
  and `sclang` already reads CoreMIDI. The same code can build an NRT
  score from recorded notes in chunk 4, though §7 question 3 leaves
  that choice open. A TypeScript translator would need MIDI input in
  Node, which is the native dependency rejected above, and an OSC
  encoder for every message.
- **A SynthDef with `freq`, `amp`, and `gate`, not a new instrument
  format.** These are SuperCollider's standard event controls, the same
  names `Pbind` and the default event use, so an existing SynthDef
  usually needs only a gated envelope. One file that answers both modes
  is the shape project-layout.md §4.6 chose for the instruments shelf.
- **Straight to the device, not through the live session.** `scsynth`
  opens the output device itself, and Core Audio mixes it with `field
  play` when both run. The voice skips the session's inserts and master
  chain. Putting `scsynth` inside the graph is the work of
  [live-supercollider](../live-supercollider/readme.md), and needs audio
  to cross between processes. Audition needs the instrument's own sound
  with little latency, which the direct path gives now. The voice
  host's interface, an instrument in and sound out, stays the same when
  live-supercollider changes where the sound goes. Sharing the device
  means sharing its rate, so the host follows the device's rate rather
  than choosing one. Booting `scsynth` at the project's `sample_rate`
  would still be wrong for a song with its own `rate:` and for a file
  at another rate, both of which `field play` switches the device to.
  It would also switch the device under a `field play` that is already
  running.
- **The daemon stamps recorded notes, not the voice host.** A take is
  placed by the transport's sample clock (recording.md §3), and only
  the daemon has that clock. A time from `sclang` or from `field keys`
  would need its own alignment against the transport, with nothing to
  measure the alignment against.

The plan builds on existing code rather than beside it: `daemonBinary()`
for the helper, `programPath()` for the instrument, its bare-name rule
for keymap names, `sclang` discovery shared with `runScProgram`, zod
for the keymap schema as for every project file, and the picker's
raw-mode pattern with its restore on every exit path. It replaces
nothing. The keymap rule adds one test to the bare-name rule:
`programPath()` treats a name as a path only when it contains a `/`,
and a keymap name that ends in `.yaml` is a path too.

## 4 Acceptance criteria

Every criterion in these tables is checked by hand, and the pull
request's Testing section records the ones its chunk covers.

Chunk 1, the MIDI device and keymaps:

| # | Do | Expect |
| --- | --- | --- |
| 1 | In Ghostty, run `field keys`. In another terminal, from the Field checkout, run `native/audiod/build/field-audiod_artefacts/Release/field-audiod --midi-monitor "Field Keys"`. Press and release `KeyA`. | Note-on 60, then note-off 60. `Field Keys` is listed in Audio MIDI Setup. |
| 2 | Hold `KeyA`, press `KeyX`, release `KeyA`. | Note-off 60, not 72. |
| 3 | Hold `KeyA` for two seconds. | One note-on, no repeats. |
| 4 | Hold `KeyA`, then switch to another window. | Note-off 60 when focus leaves. |
| 5 | Hold three keys and press `Ctrl-C`. | Three note-offs, then CC 123. The shell echoes normally. `Field Keys` is gone from Audio MIDI Setup. |
| 6 | Run `field keys` in iTerm2 and repeat criterion 1. | The same. |
| 7 | Run `field keys` in Apple's Terminal. | Exit 1, with a message that names Ghostty, iTerm2, kitty, and WezTerm. The terminal is unchanged. |
| 8 | Switch the macOS input source to Dvorak. In Ghostty, run criterion 1's two commands, and press `KeyS`, which types `o`. | Note-on 62. |
| 9 | Repeat criterion 8 in iTerm2. | The same, whether or not iTerm2 sends a base layout key. |
| 10 | With criterion 8 running, switch the input source to French (AZERTY) without restarting. Press `KeyA`, which types `q`, then `KeyZ`, which types `w`. Then switch to U.S. International – PC, still without restarting. | Note-on 60, then the status line shows a transpose of -12. After the second switch, the status line names `Quote` as a position that cannot play on this keyboard layout. Only the helper's report of the change can name `Quote`. Ghostty sends a base layout key for `KeyA` and `KeyZ`, so the presses before it pass without that report. |
| 11 | Switch the input source to U.S. International – PC, where `'` is a dead key, and run `field keys`. | The status line names `Quote`, the top F, as a position that cannot play on this keyboard layout. Every other position plays. |
| 12 | Hold `Digit2`, then release it. | Pitch bend at 16383 while held, then 8192. |
| 13 | Press `Digit5`, then `Digit3`. | CC 1 at 51, then CC 1 at 0. |
| 14 | Write `~/mine.yaml` with `name: mine`, `notes: { KeyA: 0, KeyF: [0, 4, 7] }`, and run `field keys --keymap ~/mine.yaml`. Press and release `KeyF`. | Note-ons 60, 64, and 67, then three note-offs. |
| 15 | With criterion 14 running, hold `KeyF`, change `KeyA: 0` to `KeyA: 2`, save, release `KeyF`, and press `KeyA`. | Note-offs 60, 64, and 67, then note-on 62. |
| 16 | With criterion 14 running, add `controls: { KeyA: { transpose: 12 } }` and save. | The status line names `KeyA` as both a note and a control. `KeyA` still plays 62. |
| 17 | Run `field keys --keymap mine`. | Exit 1. The message says a bare name names a built-in, lists the built-ins, and asks for a path. |
| 18 | Run `FIELD_KEYMAP=~/mine.yaml field keys`. | The status line shows `mine`. |
| 19 | In Apple's Terminal, run `field keys --print`. | A keyboard-shaped diagram with C4 on `KeyA` and the transpose controls on `KeyZ` and `KeyX`. Exit 0. |
| 20 | Run `field keys` with a keymap that binds `Escape`. | Exit 1. The message names `Escape` as reserved. |

Chunk 2, the voice host:

| # | Do | Expect |
| --- | --- | --- |
| 21 | In `examples/bloom`, run `field keys pad --device "<Apollo>"`. Play a chord, then hold `Tab` and release the keys. | You hear the chord. The notes ring until you release `Tab`. |
| 22 | With criterion 21 running, play a USB controller. | It plays the same voice. |
| 23 | With criterion 21 running, hold `Digit2` over a sounding note, then release it. | The note bends up two semitones and returns. |
| 24 | Run `field keys creek-kit`. | Exit 1. The message says `creek-kit.scd` does not answer `FIELD_MODE=voice`. |
| 25 | Run `field play creek --device "<Apollo>"`, then criterion 21 in another terminal. Stop both, set the Apollo to 44.1 kHz in Audio MIDI Setup, and run them again in the other order. Press `KeyA` before and after `field play` starts. | In the first order you hear both, and starting criterion 21 leaves the Apollo's sample rate alone. In the second, `field play` moves the Apollo to 48 kHz, the instrument's line shows it restarting and then live at 48 kHz, and `KeyA` sounds at the same pitch before and after. A `KeyA` about a semitone and a half sharp after the switch means the host missed the rate change. |
| 26 | With criterion 21 running, `kill -9` the `field keys` process. | Within two seconds, `pgrep scsynth` finds no host server, and `Field Keys` is gone. |
| 27 | In `examples/bloom`, run `field sc render shared/instruments/pad.scd --seed 90210 --duration 10 --output <file>` before and after the edit, and compare the two files with `cmp`. | Identical. A difference means the edit changed the render branch. |

Chunk 3, the other built-in keymaps:

| # | Do | Expect |
| --- | --- | --- |
| 28 | Run `field keys --keymap tracker` with the monitor. Press `KeyZ`, `KeyQ`, and `KeyI`, then `ArrowRight`. | Note-ons 48, 60, and 72, then the status line shows a transpose of 12. |
| 29 | Run `field keys --keymap fourths` with the monitor. Play `KeyZ`, `KeyB`, `KeyD` together, then `KeyX`, `KeyN`, `KeyF`. | Note-ons 48, 52, 55, then 49, 53, 56: the same major-triad shape a semitone higher. |

These vitest tests fail before the change:

- **`src/keys/terminal.test.ts`.** Decodes press, repeat, and release of
  `a`, a Dvorak `o` that carries the base layout key `s`, `Space`, an
  arrow, `Ctrl-C`, `Esc`, focus in and out, and a sequence split
  across two chunks. Reads probe answers with and without the protocol.
- **`src/keys/position.test.ts`.** The base layout key wins over the
  keyboard layout. Without one, the Dvorak layout resolves `o` to
  `KeyS`, and AZERTY resolves `q` to `KeyA`. With no keyboard layout report, a
  character resolves to its own position. A new report applies to the
  next key event. A dead key at a bound position is reported.
- **`src/schema/keymap.test.ts`.** Accepts `musical-typing` and the
  `tracker` and `fourths` fixtures, and expands the `fourths` grid to
  48 on `KeyZ`, 53 on `KeyA`, 58 on `KeyQ`, and 63 on `Digit1`. Rejects
  an unknown position, a position that is both a note and a control, a
  bound `Escape`, and a note outside 0 to 127. Lets a `notes` entry
  override the grid, and a `null` skip a grid column.
- **`src/keys/keymap.test.ts`.** A bare name resolves only to a
  built-in. A path and `FIELD_KEYMAP` resolve to the file, with `~/`
  expanded. A saved change applies to the next key press, including
  two saves in a row that each rename a temporary file over the
  keymap, and a saved file that fails validation leaves the previous
  keymap in place.
- **`src/keys/session.test.ts`.** Covers a transpose while a key is
  held, ignored repeats, a chord pressed and released, two keys that
  hold the same note released in either order, a release that carries
  `Ctrl`, a press with the Caps Lock bit set, each controller mode,
  pitch bend held and released, release on focus-out, the quit
  sequence, and the transpose bounds.
- **`src/keys/print.test.ts`.** The `musical-typing` diagram matches a
  stored copy.
- **`src/keys/helper.test.ts`.** Runs against a stub helper. Checks a
  keyboard layout report before the ready line, a second report
  mid-session, an error line, and the stub seeing end of input when
  `field keys` closes it.
- **The native round trip.** Runs `--keys` and `--midi-monitor`
  together and checks that a note arrives. On macOS it also checks that
  the first line from `--keys` reports a character for every bindable
  position. The test probes for a MIDI service first, and where there
  is none, such as a Linux container without the ALSA sequencer, it
  reports itself skipped by name. A green run without a MIDI service
  never reads as coverage.

The voice host has no automated test, because it needs `sclang` and an
audio device, and CI has neither. Chunk 4 writes its own criteria when
it appends its section.

## 5 Cost

CPU cost does not matter here. A key event is a few dozen bytes
through a pipe and one CoreMIDI send, at the rate a person types.
Reading the keyboard layout is about fifty lookups, at start and at
each input-source change. Reloading a keymap parses one small YAML file
per save. Latency from key to sound is what matters, and it is an
estimate until criterion 21 is played:

| Stage | Expected |
| --- | --- |
| Terminal to `field keys` | Depends on the terminal; not measured |
| Pipe and CoreMIDI | Well under 1 ms |
| `sclang` to `scsynth`, sent without a timestamp | Up to one control block of jitter: 64 samples, 1.3 ms at 48 kHz |
| `scsynth`'s hardware buffer | 128 frames, 2.7 ms at 48 kHz, plus the device's output latency |

If playing feels late, the hardware buffer is the first thing to
reduce. The one build cost is the `pad` edit. Its content
hash is a cache input, so every song that places it renders the pad
once more.

## 6 Rollout

Each chunk is one pull request, in order:

1. **`field keys` as a MIDI device.** The terminal, positions and the
   keyboard layout report, the keymap format with its schema, loader,
   reload, and `--print`, the `musical-typing` keymap, the session, the
   helper and its monitor mode, and `docs/keys.md`. It is useful alone,
   with Logic, and with a keymap of your own.
2. **The voice host.** `field keys <instrument>`, the voice contract,
   `pad` in voice mode, and the docs.
3. **The other built-in keymaps.** `tracker` and `fourths` move from
   chunk 1's test fixtures into `keymaps/`, with their criteria and
   their entries in `docs/keys.md`.
4. **Recording.** It starts by settling §7 questions 1 to 3 and
   appending its design, files, and criteria as a new numbered section.
   Then it builds them.

## 7 Open questions

1. **The take's file format (chunk 4).** A Standard MIDI File opens in
   Logic and rides LFS like audio. A text list of notes with sample
   times diffs in review, and an agent can edit it. It also carries the
   sample time that places a take, which a MIDI file has no field for.
   The recommendation is the text list, with `field export` writing a
   MIDI file when you need one elsewhere. §12.1 answers it with the
   text list and defers the MIDI export.
2. **The entry that plays a take (chunk 4).** It could be a `record:`
   entry with an `instrument:` field, or a new entry kind for a part
   that drives an instrument, which nested-tracks.md §18 decision 4
   expects. recording.md §4 keeps `record:` empty until a field earns
   its place, and an instrument would be the first that does. §12.2
   answers it with the `instrument:` field.
3. **Who builds the NRT score (chunk 4).** In chunk 4, the voice host
   builds the score for a recorded take. sc-render.md §2 rejected Field
   generating scores, because the program is the recipe. The voice
   contract narrows what Field knows to `freq`, `amp`, and `gate`. The
   alternative is a third mode that hands the program the notes and
   lets it render. §12.3 answers it with Field's renderer.
4. **Hearing the voice through the mix.** The voice skips inserts and
   the master chain until live-supercollider puts `scsynth` in the
   graph. This is deferred to that project on purpose. Answered
   (2026-10-11): live-supercollider.md chunk 3 routes a track's voice
   through its effects and every track's above it.
5. **Reloading the voice when its file changes.** The voice host could
   re-run the program and add the new SynthDef while you play, as a
   keymap given by path already reloads. §14 answers it: it reloads.
6. **A control for modulation.** The voice host ignores CC 1, because
   the contract has no control for it. Adding an optional `mod` control,
   which a voice may leave out, would let an instrument respond to the
   modulation keys and a controller's mod wheel. §14 answers it with
   that control.
7. **Layers.** A keymap could bind a second set of positions that
   applies while `Shift` or another key is held, which would double its
   range without a transpose. The format leaves room for a `layers`
   field, and the rules in §2.4 keep `Shift` unbound until then. Justin
   decides when a keymap needs it, and his own keymap may be the first.
8. **Linux keyboard layouts.** On Linux, `field keys` relies on the
   terminal's base layout key. Reading xkb's layout data through
   xkbcommon would match macOS. This is deferred until someone plays
   `field keys` on Linux with a keyboard layout other than QWERTY.

## 8 Background

- **No MIDI input exists.** A search of the tracked code finds no
  CoreMIDI or JUCE `MidiInput` use. `native/audiod/src/hosting.cpp`
  passes an empty `juce::MidiBuffer` to each plugin's `processBlock`
  (the member is declared in `hosting.h`). The `type: midi` track kind
  was retired as a placeholder that rendered nothing (nested-tracks.md
  §18 decision 4).
- **The two stub plans do not cover this.**
  [live-supercollider](../live-supercollider/readme.md) puts `scsynth`
  in the real-time graph, and
  [external-instruments](../external-instruments/readme.md) sends MIDI
  out to hardware. Neither takes notes in.
- **Terminal support.** The kitty protocol's own documentation lists
  Ghostty, iTerm2, kitty, WezTerm, and foot as implementations, and
  iTerm2's 3.5 releases carry fixes to its kitty key reporting. Release
  events are opt-in under flag 2, and letter keys report them only
  under flag 8. Criteria 1 and 6 confirm both terminals by hand.
- **The base layout key.** The kitty protocol defines it as "the key
  corresponding to the physical key in the standard PC-101 key layout",
  and a terminal "can" send it, so it is optional. Ghostty fixed its
  reporting for keyboard layouts other than US in 2025, with tests
  against Cyrillic. No source found says whether iTerm2 sends it, which
  is why the helper reads the keyboard layout and why criterion 9 runs
  in iTerm2. The spec also suggests detecting a partial implementation
  by setting the flags and then querying them, but a terminal that
  accepts flag 4 may still omit the key when it equals the typed one,
  so that check cannot replace the helper's report.
- **Musical Typing's reach.** Apple's Logic Pro guide documents `Z` and
  `X` for octaves, `C` and `V` for velocity, `1` and `2` for pitch
  bend, `3` to `8` for modulation, and `Tab` for sustain. Third-party
  guides to Ableton Live document the same home-row piano with `Z` and
  `X` for octaves and `C` and `V` for velocity in steps of 20. Neither
  source spells out the note keys, which come from the keymap Musical
  Typing draws on screen.
- **The name.** VMPK calls its key-to-note files keyboard maps, and
  editors call key bindings keymaps. Field uses *keymap* so that
  *layout* keeps the meaning macOS gives it, and so that it does not
  collide with this repository's project-layout plan. On Linux, xkb uses
  "keymap" for the keyboard layout itself, which Field meets only in §7
  question 8.
- **The instruments today.** The three in `examples/bloom` are NRT
  programs that render whole passages. `pad.scd` builds a
  D-minor chord from twelve sine voices under `Env.linen`, a fixed-length
  envelope. Its voice is already one SynthDef, and a gated envelope
  makes it playable.

## 9 Chunk 1 as built (2026-10-10)

`field keys` plays the computer keyboard as the MIDI source `Field
Keys`, through any keymap, built-in or yours. The built-in is
`musical-typing`; `tracker` and `fourths` wait for chunk 3 as planned.

### 9.1 What implementation settled

- **A release takes the position its press resolved to.** An
  end-to-end run through CoreMIDI under a ColemakC keyboard layout
  showed the problem: a release resolved afresh can land on another
  position when its base layout key is missing or the input source
  changes while the key is held, and the note sounds until focus-out
  or quit. `PressedKeys` in `src/keys/position.ts` remembers each
  pressed key's position by the key the terminal reported.
- **The grid expands in the schema file.** `src/schema/keymap.ts`
  expands grids because the range rule needs the expanded notes, and
  `src/keys/keymap.ts` resolves, loads, and watches.
- **The interactive shell is `src/commands/keys.ts`.** §2.8 gains the
  row.
- **`panic` is a bare word**, and **a keymap plays at least one note**
  (§2.4).
- **Reload happens only when the keymap's text changes**, because macOS
  can report a write made just before the watch began (§2.4).
- **The probe waits two seconds** for the terminal's answers. Every
  terminal answers the device-attributes query, so the wait matters
  only for one that answers nothing, and a slow SSH link needs more
  than one second.
- **The helper's modes are subprocesses in `native/audiod/src/keys.cpp`
  and `keyboard-layout.cpp`.** The layout code includes no JUCE headers,
  so Carbon's and JUCE's never meet.

### 9.2 What was verified, and how

| Check | Result |
| --- | --- |
| The vitest tests §4 lists for chunk 1 | Pass: schema 13, keymap 10, print 3, terminal 13, position 11, session 20, helper 6. |
| The native round trip, `src/keys/helper-native.test.ts` | 8 pass on macOS against the built binary. It fails against a binary without `--keys`. |
| `field keys` in a pseudo-terminal, against a stub helper that reports a Dvorak layout | Eleven scripted key events sent exactly the predicted MIDI, including the note a transpose left under a held key, the focus-out release, sustain, bend, an ignored Ctrl-chord, and All Notes Off. The protocol flags were pushed at start and popped at exit. |
| `field keys` in a pseudo-terminal with the real helper, under this Mac's ColemakC layout, heard by `--midi-monitor` through CoreMIDI | `o` played E5 through the layout report, `r` with base layout key `d` played E4, and `e` played C5, each with its own note-off, then All Notes Off. `Field Keys` was gone the moment the command exited. |
| The layout change report | `--keys` printed a new report when the input source switched from ColemakC to U.S. and back. macOS posted the switch twice, so a switch can produce two reports. |
| Dead keys | A read-only `UCKeyTranslate` check of U.S. International – PC marks `Quote` and `Backquote` dead. `musical-typing` binds `Quote` and not `Backquote`, so criterion 11 holds as written. |

### 9.3 What is still owed

- **Criteria 1 to 20 by hand at a real keyboard.** The runs above typed
  the protocol's bytes into a pseudo-terminal, so they prove the
  decoding, the positions, the session, and the helper, but not how
  Ghostty, iTerm2, and Apple's Terminal behave with real keys. Criteria
  6, 9, and 10 decide whether iTerm2 sends base layout keys and whether
  the layout report reaches `field keys` in time.
- **Linux.** `--keys` has not run on Linux; CI's runner has no ALSA
  sequencer, so the round trip skips there by name.
- **A one-off CoreMIDI failure.** The first `--keys` start on this Mac
  printed `CoreMIDI error: 580` (`MIDIClientCreate` returned -304) and
  could not create the source; about sixty later starts did not. JUCE
  keeps a failed client for the life of the process, so the remedy is
  to run `field keys` again, which `docs/keys.md` says.

## 10 Chunk 2 as built (2026-10-10)

`field keys <instrument>` plays a SuperCollider instrument through the
voice host in `sc/voice-host.scd`, and `pad` answers voice
mode.

### 10.1 scsynth opens the microphone unless told otherwise

The first run of the voice host never became ready. `scsynth` printed
its sample rate and stopped there, with "MacBook Pro Microphone" chosen
as its input device, although the host asks for no input channels
(`-i 0`). Booted alone, with the same arguments, under a pseudo-terminal,
it stalled at the same line and ignored `/quit`. Booted with the
speakers named as its device (`-H "MacBook Pro Speakers"`), it printed
`SuperCollider 3 server ready.` and quit on `/quit`.

So on macOS `scsynth` opens the default input device whatever the input
channel count, and opening it waits on the microphone permission, which
a process with no way to ask never gets. In a terminal that can ask,
the user would see a microphone prompt for a keyboard instrument. The
host therefore names one device for both directions, `inDevice` and
`outDevice`, so `scsynth` never touches the microphone. With no
`--device`, `field-audiod --keys` reports the system output's name on
its ready line (§2.5), through JUCE's CoreAudio device type, the same
way the daemon follows the default output. §2.6's "No inputs" bullet is
corrected to match.

### 10.2 What implementation settled

- **A failure is the last thing its branch does.** `sclang`'s `exit`
  does not stop the code that called it: a host that failed to load its
  voice kept going and began to boot a server before it exited. The
  host puts everything after loading the voice in one function that
  runs only when the voice loaded.
- **A load error names the cause first.** An instrument without a voice
  mode, such as `creek-kit`, fails in its own render code under voice
  mode, with an error such as `Message 'asInteger' not understood`. The
  host reports `creek-kit.scd does not answer FIELD_MODE=voice: running
  it in voice mode failed with ...`, and `field keys` adds what `sclang`
  printed after its startup banner, leaving out the class library's
  compile messages.
- **Field reads only `@field ` lines.** `sclang` prints freely to stdout,
  so each host line is `@field ` followed by one JSON object: `ready`
  with the device and rate, `restarting`, `error`, and, under
  `FIELD_VOICE_TRACE`, `voice_on` and `voice_off`, which made the host
  testable without sound.
- **`sclang` runs in daemon mode (`-D`)**, so it reads no input, and
  `field keys` starts the host after the helper, so `Field Keys` exists
  when the host connects its MIDI inputs. The keyboard plays while the
  host boots.
- **`sclangCommand()`** in `src/generators/supercollider.ts` resolves
  `FIELD_SCLANG`, then `PATH`, then the app bundle, for renders and the
  host alike.
- **The host watches its own boot.** `waitForBoot`'s `onFailure` never
  runs in SuperCollider 3.14.1, so a server that exits while it boots
  would leave the host waiting forever. The host fails when the server's
  process exits before the server answers, or after 20 seconds, naming
  the device.
- **A server is stopped by its process too.** The host reports each
  server's process on a `server_pid` line. A server still booting has not
  bound its port and misses `/quit`, so `field keys` signals the process
  after `/quit`, and the host does the same before it exits.
- **The device name is checked before boot.** `scsynth` falls back to
  the default input and output for a name it does not find, which opens
  the microphone, and SuperCollider passes the name to a shell between
  bare double quotes. The host refuses a name `ServerOptions.outDevices`
  does not list, and one that contains `"`, `` ` ``, `$`, or `\`.
- **Quitting never waits for the host.** `VoiceHost.start` resolves once
  `sclang` runs, and `ready` says when the host goes live, so `Esc`
  closes a host that is still booting.

### 10.3 What was verified, and how

| Check | Result |
| --- | --- |
| `src/keys/voice-host.test.ts`, against a stub `sclang` | 11 pass: resolution, the OSC `/quit` bytes, the host's lines, ready, an error with the output after the banner, a silent exit, a restart then a death after ready, and a missing `FIELD_SCLANG`. Close delivers `/quit` to the port the stub was given. |
| The host on this Mac with a silent voice, `Field Keys` from the real helper | Live at 48000 Hz on MacBook Pro Speakers about two seconds after start. A note through CoreMIDI started a voice, and its note-off ended it. Nothing outlived the close. |
| The host with `still-water-pad`, no notes played | Live at 48000 Hz; its voice loads as a SynthDef. |
| The host with `creek-kit` | Rejected with the message in §10.2, and nothing left running. |
| The parent killed with `SIGKILL` while the host ran | `sclang` and its `scsynth` were both gone within three seconds. |
| Criterion 27 | `field sc render shared/instruments/still-water-pad.scd --seed 90210 --duration 10` before and after the edit: identical bytes (`cmp`). |

### 10.4 What is still owed

- **Criteria 21 to 26 by ear.** Playing a chord, sustain, bend, a USB
  controller, `field play` beside the host, and the rate restart all
  make sound, so no run here played them. The restart in criterion 25
  also needs a device whose rate moves; the logic that drives it runs
  only in `sclang`.

## 11 Chunk 3 as built (2026-10-10)

`tracker` and `fourths` ship in `keymaps/`, exactly as chunk 1's schema
tests carried them, and those tests now read the shipped files. Both
put transpose and velocity on the arrows and sustain on `Space`; neither
binds pitch bend or modulation, as §3 says.

| Check | Result |
| --- | --- |
| The schema and keymap tests | `tracker` plays 32 notes with `KeyZ` 48, `KeyQ` 60, and `KeyI` 72; `fourths` expands to 27 notes with `KeyZ` 48, `KeyA` 53, `KeyQ` 58, and `Digit1` 63. Every built-in resolves by its bare name and loads. |
| Criterion 28, in a pseudo-terminal through the real helper and CoreMIDI, typing as this Mac's ColemakC layout does | `z`, `q`, and `u` (which is `KeyI` there) played 48, 60, and 72, each with its own note-off, and `ArrowRight` moved the transpose to +12. |
| Criterion 29, the same way | `z b s` together played 48, 52, and 55, and `x k t`, one key to the right, played 49, 53, and 56: the same major-triad shape a semitone higher. |
| `field keys --keymap <name> --print` | Both diagrams put C3 under `KeyZ`. `tracker` puts C4 under both `KeyQ` and `Comma`; `fourths` puts F3 under `KeyA`, A#3 under `KeyQ`, and D#4 under `Digit1`. |

Still owed: criteria 28 and 29 at a real keyboard in Ghostty and
iTerm2. The runs above typed the protocol's bytes into a
pseudo-terminal, as §9.3 explains for criteria 1 to 20.

## 12 Chunk 4: recording the keys (DECIDED, 2026-10-10)

Justin asked for the whole plan to be built without stopping, so this
section answers §7 questions 1 to 3, with §7's recommendation where
it made one, and records each as a decision with the alternative it
beat. Merging
the chunk is his review of them, and any of the three can be overturned
before that.

A MIDI take reuses everything about an audio take that is not audio:
the transaction directory, the timestamped take name, `takes.yaml` with
`chosen`, `field choose`, the placement arithmetic, and the latency
subtraction. It differs where it must: the daemon captures MIDI
messages instead of samples, the take lands as a text file of notes,
and the build renders the chosen take through the instrument instead
of summing its bytes.

### 12.1 The take is a text list of notes (DECIDED)

A MIDI take lands as `audio/<track>/take-<timestamp>.notes.yaml`:

```yaml
sample_rate: 48000
length: 412800
notes:
  - { at: 0, length: 24000, note: 60, velocity: 100 }
  - { at: 12000, length: 9600, note: 64, velocity: 90, channel: 2 }
controls:
  - { at: 30000, cc: 64, value: 127 }
bends:
  - { at: 50000, value: 12288 }
```

| Field | Meaning |
| --- | --- |
| `sample_rate` | The rate `at`, `length`, and the other times count in: the device's rate during the take. |
| `length` | The take's length in samples, from its start to the stop. |
| `notes` | Each note: its onset `at`, its `length`, `note`, `velocity`, and `channel`, 1 when omitted. A note still held at the stop lasts to the end; a note-off whose note-on came before the take is dropped. |
| `controls` | Each controller change: `at`, `cc`, `value`, and `channel`. |
| `bends` | Each pitch bend: `at`, `value` from 0 to 16383, and `channel`. |

Times are samples from the take's start, as an audio take's frames are.
The file is pinned in the song's ledger by hash like any take, with no
WAV facts, and stays out of LFS because it is text. Rejected: a
Standard MIDI File, which opens in Logic but diffs as bytes and has no
field for the sample time that places a take; and raw note-on and
note-off events, which are what the daemon captures but which an agent
cannot quantize or transpose without pairing them first.

`field export` writing a Standard MIDI File from a take, which §7
recommended beside the text list, is deferred, not dropped. Nothing in
this plan reads one, and the notes file holds everything it needs, so it
is an addition to `field export` alone, for when a take must open in
Logic as notes. Until then a take reaches Logic as audio:
`field export creek/gen:keys` copies its render.

Changed on 2026-10-15 by [sequencer](../sequencer/readme.md) §3.3: a
take lands in scalar ticks, in the notes format parts share, with the
output latency taken off its notes as it lands, so it follows a tempo
edit and copies into a part. A notes file with `sample_rate:` is a take
recorded before that, and plays as recorded.

### 12.2 The entry is `record:` with an instrument (DECIDED)

```yaml
# songs/creek/tracks/keys.yaml
name: keys
inputs:
  - record:
      instrument: pad
```

A `record:` entry with `instrument:` records MIDI takes, and one
without records audio, as today. `instrument` resolves exactly as
`field keys` resolves one (§2.1). Every other part of a record entry
holds: its placement fields, `takes.yaml`, `chosen`, `field choose`,
and silence before the first take. Rejected: a new entry kind for a
part that drives an instrument. It would need its own takes, choosing,
and placement machinery to do what `record:` already does, and
recording.md §4's rule that a field enters `record:` only once it earns
its place is met: the instrument is what decides the kind of take.

A takes row for a MIDI take carries `sources`, the MIDI sources the
daemon listened to, in place of an audio take's `device` and `input`:

```yaml
- asset: take-20261010-200000
  started_at_samples: 806400
  musical_position: [17]
  latency: 240
  sources: [Field Keys]
  recorded_at: 2026-10-10T20:00:00.000-04:00
```

`latency` is the output latency alone. A player presses a key in time
with what they hear, which runs behind the playhead by the output
latency, and MIDI has no input latency worth the name. Placement
subtracts it exactly as it does an audio take's.

Changed on 2026-10-15 by [sequencer](../sequencer/readme.md) §3.4: the
instrument is the track's `instrument:`, and `record:` stays bare. The
track's instrument decides the kind of take, as the entry's did, and
`field check` refuses `instrument:` under `record:`.

### 12.3 Field's renderer builds the score (DECIDED)

The build renders the chosen take through `sc/voice-render.scd`, which
loads the instrument's voice under `FIELD_MODE=voice` and drives it
with `sc/voicer.scd`, the same voicing the live host uses: one voice
per note, sustain, All Notes Off, and pitch bend. A take therefore
renders as it sounded while it was played. sc-render.md §2 rejected
Field generating scores because the program is the recipe; the voice
contract narrows what Field knows to `freq`, `amp`, and `gate`, and the
voicer is the one place those rules live. Rejected: a third mode that
hands each program the notes, which would make every instrument
re-implement sustain and bend, and let a take render differently from
how it was heard.

The render is a `gen:` node, minted for a record entry with an
instrument whose chosen take is a notes file. Its inputs are the notes
file's hash, the instrument program's content hash, and the content
hashes of `sc/voice-render.scd` and `sc/voicer.scd`, so editing any of
them re-renders. It renders at the track's rate, two channels, for the
take's length plus a 4-second release tail, and the stem places it
where the take started, less its latency.

### 12.4 Capture in the daemon

`arm` takes `kind: midi`. The daemon then opens every MIDI input it can
see, and no audio input, so arming for MIDI never asks for the
microphone. Each message goes from JUCE's MIDI thread into a lock-free
queue with its arrival time. The audio callback drains the queue and
stamps each message with the transport position at that time, from the
block's position and the time the block began; the same latch that
starts an audio take starts a MIDI take, and messages before the start
or after `until` are dropped. A writer thread appends each message to
`take.midi.ndjson` in the transaction directory as
`{"at":<samples from the start>,"midi":[...]}`, so a crash loses at most
the last partial line, which recovery drops. Loop takes stay audio only.

| Protocol | For a MIDI take |
| --- | --- |
| `hello.features` | adds `record-midi` |
| `arm` | `{track, kind: "midi"}` → `{kind: "midi", sources, sample_rate, output_latency}` |
| `status.record` | `kind: "midi"`, `sources`, and `events`, the messages captured so far; `frames` counts the samples elapsed |
| the take manifest | `kind: "midi"`, `file` ending `take.midi.ndjson`, `sources`, `sample_rate`, `timeline_rate`, `output_latency`, `started_at_samples`, `frames`, and `events`, with no audio fields |

### 12.5 The flow

1. In one terminal, run `field keys pad`, which plays the
   voice you hear and publishes `Field Keys`.
2. In another, run `field record creek/track:keys --at 17`, as for
   audio. The entry's instrument makes it arm for MIDI, so `--input`
   and `--device` are refused.
3. The song plays; you play. `field record` shows the events captured.
4. On stop, the take lands: the notes file, its ledger row, and its
   row in `takes.yaml`, chosen.
5. `field build creek` renders the chosen take through the instrument
   and mixes it where you played it.

### 12.6 Files

| File | Change |
| --- | --- |
| `native/audiod/src/player.cpp`, `player.h` | Arm for MIDI, the MIDI queue and its stamping in the audio callback, and the status fields. |
| `native/audiod/src/capture.cpp`, `capture.h`, `server.cpp` | A MIDI capture beside the WAV one: the NDJSON writer, its manifest, list, recovery, and the feature. |
| `src/audiod/protocol.ts`, `client.ts` | The MIDI arm, status, and manifest shapes, and `armMidi`. |
| `src/schema/record.ts` | `instrument` on the entry, and the MIDI takes row. |
| `src/schema/notes.ts` (new) | The notes file's schema, and pairing captured messages into it. |
| `src/commands/record.ts`, `land.ts`, `src/cli.ts` | Arming by the entry's kind, the MIDI status line, and landing a notes file. |
| `src/graph/graph.ts`, `src/generators/voice-render.ts` (new), `src/generators/index.ts` | The render node for a chosen MIDI take, and its generator. |
| `src/model/project.ts` | Validation: a MIDI take only on an entry with an instrument, and the instrument's program exists. |
| `docs/keys.md`, `docs/tracks.md`, `docs/project-model.md`, `docs/build-graph.md`, `docs/audio-engine.md` | Recording the keys, the entry, the take, the render node, and MIDI capture. |

## 13 Chunk 4 as built (2026-10-10)

`field record` now records what you play when the track's record entry
names an instrument, lands the take as a notes file, and the build
renders the chosen take through that instrument where you played it.
Everything §12 decided holds; this section adds the criteria §6 said
chunk 4 would append, and what building it settled and proved.

### 13.1 Acceptance criteria

Each runs in a project whose song builds, with a track `keys` whose
record entry has `instrument: pad`.

| # | Do | Expect |
| --- | --- | --- |
| 30 | Run `field keys pad` in one terminal and `field record creek/track:keys --at 17` in another. Play a few notes, then press Ctrl-C. | The armed line lists `Field Keys` among its sources, the position line counts events, and the take lands as `audio/keys/<take>.notes.yaml`, chosen. `field check` says ok. |
| 31 | `field build creek`, then `field play creek`. | You hear what you played, through the pad, where you played it against the song. |
| 32 | Run criterion 30's `field record` with `--input 2`, then with `--device <name>`, then with `--loop --until 19`. | Each is refused before anything arms: `keys records MIDI for pad: --input, --device, and --loop are for audio takes`. |
| 33 | Edit `pad.scd` and build again; then build once more without an edit. | The first build renders `creek/gen:keys` again; the second is a cache hit. |
| 34 | Change the instrument to `ghost`, which has no program, and run `field check`. Then remove `instrument:` while a MIDI take is chosen, and run it again. | `input 1 ("record") instrument file not found: shared/instruments/ghost.scd`, then `take "<take>" is a MIDI take, and input 1 ("record") names no instrument to play it`. |
| 35 | Hold a note through the stop. | The notes file has it last to the take's end, and its render rings on through the 4-second tail. |
| 36 | Hold sustain (`Tab` in `musical-typing`, `Space` in `tracker` and `fourths`) across a few note releases while you record. | The render holds them as the live voice did. |

### 13.2 What implementation settled

- **Landing is shared.** `src/commands/land.ts` splits what every take
  needs (the checks, the record node, the ledger, the placement, the
  musical position, and the `takes.yaml` write) from what each kind
  adds. `landMidiTake` pairs the captured lines into a notes file with
  `notesFromMessages`, writes it with `formatNotesFile`, and pins it
  with no WAV facts. `landAnyTake` picks by the manifest, and every
  landing path in `field record` uses it: the take event, the stop, the
  recordings fallback, `--recover`, and `--land`.
- **The kinds stay apart.** A take of the other kind than its entry
  records refuses to land, and `field check` makes it an error, as it
  does an instrument with no program. `field record` refuses `--input`,
  `--device`, and `--loop` on a MIDI entry before it connects.
- **The entry's canonical form is block style.** `field fmt` writes
  `instrument:` on its own line under `record:`, as for a
  `supercollider:` entry, so §12.2's example and the docs use that
  form.
- **The render is stereo at the track's rate, 4 seconds past the
  take.** The tail is fixed, `RELEASE_TAIL_SECONDS`, because the voice
  contract carries no release time. scsynth writes whole control
  blocks in NRT, so a render runs one 64-sample block past its
  duration, as every sc-render does; the block is silence after the
  tail.
- **A dropped count means messages for a MIDI take.** `field record`
  says so, and that a lost note-on is a missing note and a lost
  note-off holds its note to the take's end.
- **The first review settled six behaviors.** The voicer's reset is
  `forgetVoices`, because an Event entry named `clear` loses to
  `Set.clear`, which emptied the voicer and left `field keys` silent
  after a rate restart. A note whose on and off share a sample
  releases right after its own on in a render. A MIDI take's `until`
  converts from the bed's samples to the device's, so a 44.1 kHz song
  on a 48 kHz device ends on time. The writer flushes each 20 ms tick
  to the kernel, so a daemon crash loses at most a partial line. The
  instrument resolves through the `supercollider:` path rule in
  `field check`. A take render unsets the render variables before it
  loads the instrument, so voice mode looks the same as live. From its
  suggestions, a MIDI stop waits two callback blocks before it detaches,
  so a message that arrived before the stop is never skipped, and the
  docs say a take hears only the sources that exist when it arms.
- **`still-water-pad` is `pad` now** (#183). The rows in §10.3 and
  §13.3 keep the old name, because that is the name the runs used.
- **CoreMIDI can refuse a new source for a moment.** Run whole,
  `src/commands/record-midi-daemon.test.ts` saw its last
  `field-audiod --keys` refused every time, right after earlier tests
  killed their helpers and daemons, and the same name was accepted
  500 ms later. The test's publish retries for up to a second on
  macOS. `field keys` itself does not retry: nothing outside that
  churn has shown the refusal.

### 13.3 What was verified, and how

| Check | Result |
| --- | --- |
| `src/schema/notes.test.ts` | 9 pass: pairing by channel and note, a velocity-0 note-on as a note-off, a retrigger ending the earlier note, an unmatched note-off dropped, a held note lasting to the end, the file's text, and the render events' order and units. |
| `src/commands/land.test.ts`, MIDI cases | A take started at song sample 432000 on a track placed at bar 5 lands at 48000 with latency 128, the output's alone, and is placed at 47872. The notes file, the row with `sources`, and the ledger pin are exact, and `field check` is clean. Either kind refuses the other's entry, and `field check` reports both errors in criterion 34. |
| `src/generators/voice-render.test.ts` | The node's inputs are the notes asset, the instrument, and both harness files, and an instrument edit renders again. Through real `sclang`: a half-second take renders 216064 frames (the take, the tail, and one block), the same bytes from a cold cache, and the track builds over it. |
| `src/commands/record-midi-daemon.test.ts` | The daemon's four capture tests, and `field record` end to end through the null output with a published source: the refusal in criterion 32, the armed, recording, and event-count lines, and a landed notes file holding the sent note on channel 16. |
| By hand, the CLI on this Mac under ColemakC, in a scratch project with `still-water-pad`, through the null output | `field record creek/track:played --at 1.2.1` armed `MIDI from Field Keys Verify`, recorded from 1.2.1, and landed `take-20261010-203009` with 4 events. Two notes sent 0.4 s apart and held for 1.0 s and 0.8 s landed at 14579 and 34088, 48231 and 38356 samples long: within 5 ms of the script's sleeps. `field build creek` rendered the take through `still-water-pad`: first sound 1054 samples after the first note (the pad's attack), placed exactly 24000 samples later in the track, peaking at -17.8 dBFS. A cold-cache render had the same SHA-256. A second take recorded over a live session holding the first one's render, landed, and was chosen; `field choose creek/played --take take-20261010-203009` then built the first render from the cache, with the same SHA-256. |

### 13.4 What is still owed

- **Criteria 30, 31, 35, and 36 by ear,** on a real output device. The
  runs above used the null output so that nothing played aloud, which
  also means the output latency they subtracted was 0; the subtraction
  itself is checked with 128 in `land.test.ts`.
- **A take as a MIDI file.** `field export` writing a Standard MIDI
  File is deferred, as §12.1 says; a take reaches Logic as its render
  until a take must open there as notes.
- **Editing a notes file by hand.** The build refuses an edited notes
  file, as it refuses any pinned file whose bytes changed, and
  `field import` takes audio only, so there is no way yet to pin an
  edit. A command that re-pins a notes file is the follow-up if editing
  notes turns out to matter.

## 14 Voice reload and the modulation wheel (2026-10-11)

§7 deferred questions 5 and 6 "until chunk 2 has been played with".
Justin has played with it, and asked for both. Saving an instrument's
program while `field keys` plays now loads it again, and the modulation
wheel reaches the voice as an optional `mod` control.

### 14.1 What was built

- **Reload.** `field keys` watches the instrument's program the way it
  watches a keymap given by path: `watchText` in `src/keys/watch.ts`,
  which `watchKeymap` now uses too, watches the directory and calls only
  when the text changes. On a change, Field sends `/field/reload` to
  `sclang`'s own port, which it chooses and passes with `-u`, as it
  already chooses `scsynth`'s. The host loads the program again with
  `sc/voice-load.scd`, the loader its first load and the take render
  also use. A voice that loads is what the next note plays, and notes
  already sounding finish as they started. One that does not leaves the
  last good voice playing, and the instrument's line says why, with
  `sclang`'s own `ERROR:` line attached when the program does not
  compile.
- **The modulation wheel.** CC 1 divided by 127 is `mod`, which the
  voicer passes to each new voice and sets on every sounding voice when
  it moves, live and in a take's render. The voicer's `setFreq` became
  `set.(voice, control, value)`, which carries both `freq` and `mod`. A
  voice may leave `mod` out; `scsynth` ignores a control a SynthDef does
  not have. `juno` turns it into vibrato, up to half a semitone at
  5.5 Hz, as the lever on a Juno's bender does; `bass` opens its filter,
  up to four times its cutoff; `pad` has none.
- **Renders.** `juno`'s and `bass`'s render branches pass no `mod`, so
  their graphs, and their renders, are unchanged.

### 14.2 Decisions (DECIDED, 2026-10-11)

- **Field watches; the host loads.** Rejected: `sclang` polling the
  program's modification time, which would be a second watcher with
  one-second resolution and none of the rename-on-save handling the
  keymap watch already proves.
- **The reload is an OSC message to `sclang`'s port,** accepted only
  from `127.0.0.1`. Rejected: `sclang`'s standard input, which `-D`
  turns off.
- **A failed reload keeps the last good voice.** Silence, or a host
  that exits, would end the session over a typo.
- **`mod` is one value for every channel,** as the voicer's bend is.

### 14.3 Acceptance criteria

| # | Do | Expect |
| --- | --- | --- |
| 37 | In `examples/bloom`, run `field keys juno`. Hold a note, change `juno.scd`'s `level` from 0.12 to 0.05, and save. Play another note. | The instrument's line ends `· reloaded`. The held note keeps sounding as it started; the new note is quieter. |
| 38 | Save `juno.scd` with a syntax error, then play. | The line reads `juno kept its last voice: juno.scd does not compile: …`, and the keys still play `juno`. Fixing the file brings back `· reloaded`. |
| 39 | With `field keys juno`, hold a note and press `8`, then `3`. | Vibrato appears, then stops. |
| 40 | With `field keys bass`, hold a note and press `8`. | The filter opens. |
| 41 | Record a take on a track whose record entry has `instrument: juno`, moving the wheel while you play, then build. | The render has the vibrato where you played it. |

### 14.4 What was verified, and how

| Check | Result |
| --- | --- |
| `src/keys/voicer.test.ts`, through real `sclang` | A note starts with `mod` 0; CC 1 at 127 sets 1.0 on the sounding voice, a new voice starts with 1.0, and CC 1 at 0 sets 0.0 on both. The voicer still plays after `forgetVoices`. |
| `src/keys/voice-host.test.ts`, against a stub `sclang` | `sclang` starts with `-u <port> -D <script>`; `reload` sends `/field/reload` to that port, and the host's answers become `reloaded` and `reload-failed` with `sclang`'s `ERROR:` line attached. |
| `src/generators/voice-render.test.ts`, through real `sclang` | With a voice whose level is `mod`, a take with no CC 1 renders silent, and one with CC 1 at 127 before its note renders sound. The render's cache inputs now include `sc/voice-load.scd`. |
| `juno` and `bass` render branches | With seed 1 and 4 s, in stereo and mono, the same bytes as before `mod`. |
| `field keys juno` in a pseudo-terminal, with the real host and no keys pressed | Live at 48000 Hz on this Mac's speakers. A good save of `juno.scd` showed `· reloaded`; one without a semicolon showed `juno kept its last voice: juno.scd does not compile: syntax error, unexpected …`; restoring the file showed `· reloaded` again. |

### 14.5 What is still owed

- **Criteria 37 to 41 by ear.** The runs above pressed no keys.
- **A save in the first seconds of a session** can arrive before
  `sclang` has registered its reload responder, and is then lost; the
  next save reloads.
- **A wheel left up before a take starts** plays live but not in the
  take: the daemon records only what arrives once the take has started,
  so the render starts at `mod` 0. `docs/keys.md` says to set the wheel
  after the take starts. Carrying the wheel's position into a take would
  still miss one set before `field record` arms, which it does just
  before the take, so it waits until a lasting arm (arming.md chunk 3)
  keeps the MIDI sources open between takes. *Amended (2026-10-11,
  instrument-knobs.md chunk 3):* a take now starts where `field keys`
  left the wheel. `field keys` publishes the controllers it sent,
  `field record` passes them in `arm`, and the daemon writes them at
  the take's first sample, so `docs/keys.md` drops its advice to set
  the wheel after the take starts. Only a hardware wheel moved before
  the arm is still missed
  ([instrument-knobs.md](../instrument-knobs/readme.md) §2.8).
