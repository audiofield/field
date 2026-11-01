# Keys: the computer keyboard as an instrument

`field keys` turns your computer keyboard into a MIDI instrument. It
publishes a virtual MIDI source named `Field Keys`, so Logic, the
SuperCollider IDE, or any other application that lists MIDI inputs can
play from it. A *keymap* decides what each key plays: a note, a chord,
or a control such as transpose or sustain. The default keymap,
`musical`, is Field's take on Logic Pro's Musical Typing, and you can
write your own. `field keys` is also a controller with knobs: the arrows
choose a knob and turn it, and every turn goes out as a MIDI controller
message.

```console
$ field keys
  ┌───┬───┐   ┌───┬───┬───┐   ┌───┬───┐   ┌───┐
  │ W │ E │   │ T │ Y │ U │   │ O │ P │   │ ] │
┌─┴─┬─┴─┬─┴─┬─┴─┬─┴─┬─┴─┬─┴─┬─┴─┬─┴─┬─┴─┬─┴─┬─┘
│ A │ S │ D │ F │ G │ H │ J │ K │ L │ ; │ ' │
└───┴───┴───┴───┴───┴───┴───┴───┴───┴───┴───┘
mod   0
Field Keys · musical · transpose 0 · velocity 100 · bend +0 · C4 E4 G4
```

The keyboard above the status line is the keys that play notes, and a
key you hold lights up: here `A`, `D`, and `G`, in reverse video in the
terminal.

Name an instrument and `field keys` plays it too, from the keyboard and
from every other MIDI source, and shows the knobs the instrument has:

```console
$ cd examples/bloom
$ field keys juno
juno live at 48000 Hz on MacBook Pro Speakers
  ┌───┬───┐   ┌───┬───┬───┐   ┌───┬───┐   ┌───┐
  │ W │ E │   │ T │ Y │ U │   │ O │ P │   │ ] │
┌─┴─┬─┴─┬─┴─┬─┴─┬─┴─┬─┴─┬─┴─┬─┴─┬─┴─┬─┴─┬─┴─┬─┘
│ A │ S │ D │ F │ G │ H │ J │ K │ L │ ; │ ' │
└───┴───┴───┴───┴───┴───┴───┴───┴───┴───┴───┘
mod   0  cutoff 2.00 kHz  res 0.300  attack  800 ms  release  1.50 s
Field Keys · musical · transpose 0 · velocity 100 · bend +0 · D4
```

To keep what you play, record it into a track; see
[Record what you play](#record-what-you-play).

## Before you start

- **A terminal with the kitty keyboard protocol.** A terminal normally
  reports only key presses, and a note needs its release. Ghostty,
  iTerm2 3.5 and later, kitty, and WezTerm report releases through the
  kitty keyboard protocol. Apple's Terminal does not, and `field keys`
  refuses to start there with a message that says so.
- **`field-audiod`.** The virtual MIDI source belongs to the native
  binary, so build it first with `field upgrade audiod`.
- **macOS or Linux.** On Linux the virtual source needs the ALSA
  sequencer (`/dev/snd/seq`). Windows has no virtual MIDI sources, and
  `field keys` reports that.
- **SuperCollider, to play an instrument.** `field keys` finds `sclang`
  the way `field build` does: `FIELD_SCLANG`, then your `PATH`
  (`sclang.exe` on Windows), then where the SuperCollider installer put
  it, which is the macOS app bundle or the newest
  `SuperCollider-<version>` folder under Program Files on Windows.

You do not need to be inside a Field project.

If `field keys` says it cannot create a virtual MIDI source on macOS,
run it again. CoreMIDI has refused the first source a new process asked
for, once, and a new process gets a new MIDI client.

## Play

1. Run `field keys` in a supported terminal.
2. In the application you want to play, choose `Field Keys` as the MIDI
   input. In Logic, `Field Keys` appears with your other MIDI inputs.
3. Play. Above the status line, `field keys` draws the keys that play
   notes as keycaps, each with its key's letter, and lights each key in
   reverse video while you hold it. The row above the home row sits
   half a key to the left, so its keys fall between the home row's as a
   piano's black keys do, and a key that plays nothing leaves a gap. It
   draws the keyboard for a keymap whose notes are all on those two
   rows, such as `musical`, and only on a terminal wide enough for it,
   48 columns for `musical`; other keymaps go without it for now.
   The status line shows the keymap, the transpose, the velocity,
   the pitch bend when the keymap has keys that bend or the bend is
   away from rest, and last the notes sounding, so playing changes only
   the end of the line. The bend runs from `-1` to `+1`. It always
   carries its sign and as many decimal places as the finest bend in
   the keymap needs, up to four, so bending a chord does not move the
   notes: with a `0.25` bend in the keymap, the bend at rest reads
   `+0.00`. The knob line above it shows the modulation wheel and the
   other knobs ([Turn knobs](#turn-knobs)). With a keymap that binds no
   knob keys, the knob line is absent, and the status line shows the
   wheel, from 0 to 127, when the keymap has keys that set it or it is
   away from 0. The bend and the knobs show what `field keys` last
   sent; a USB controller's bender and knobs do not change them. On a
   narrow terminal the text before the notes is shortened, and the notes
   only when they alone are wider than the terminal.
4. Press `Ctrl-C` to quit. `field keys` sends a note-off for every held
   note and then All Notes Off, so nothing is left sounding, and
   `Field Keys` disappears. `Esc` does not quit: it cancels a value
   you are typing ([Type a value](#type-a-value)), and with none open
   it puts `Ctrl-C quits` on the status line.

Holding a key holds its note; the terminal's key repeat does nothing.
When the terminal loses focus, `field keys` releases every held note,
because a terminal that has lost focus never reports the release.

To check that notes go out, watch the source from another terminal.
`field-audiod` is not on your `PATH`, because installing Field links
only `field`; run it from your Field checkout, or through
`$FIELD_AUDIOD` if you set that:

```console
$ native/audiod/build/field-audiod_artefacts/Release/field-audiod --midi-monitor "Field Keys"
{"ready":true,"name":"Field Keys"}
{"midi":[144,60,100],"host_ms":5702312.481}
{"midi":[128,60,0],"host_ms":5702519.027}
```

The monitor prints every MIDI message from the source you name, so it
also checks a USB controller: give it the controller's name. Each line
gives the message's bytes and `host_ms`, when it arrived, in
milliseconds on the high-resolution clock the daemon stamps MIDI
against.

With `--destination`, the monitor publishes a virtual MIDI destination
under the name instead, and prints each message sent to it, which checks
a daemon MIDI output with a `destination`
([audio-engine.md](audio-engine.md) "MIDI outputs"). On macOS each line
adds `timestamp_ms`, the host time the message carries, which CoreMIDI
delivers it at:

```console
$ native/audiod/build/field-audiod_artefacts/Release/field-audiod --midi-monitor "Test Synth" --destination
{"ready":true,"name":"Test Synth"}
{"midi":[144,48,110],"host_ms":5731020.112,"timestamp_ms":5731020.004}
```

## Turn knobs

`field keys` has knobs, as a hardware controller does. Each knob is a
MIDI controller (CC) with a name and a range, and the knob line, between
the instrument's line and the status line, shows every knob and its
value. The first knob is always `mod`, the modulation wheel (CC 1), from
0 to 127. An instrument adds its own knobs from its knob file.

1. Press `ArrowRight` or `ArrowLeft` to choose a knob. The chosen knob is
   in reverse video. The choice wraps past either end and sends nothing.
2. Press `ArrowUp` or `ArrowDown` to turn the chosen knob one step up or
   down. A step is one controller value, so a knob has 128 positions. On
   a knob with a `step`, a step moves to the next controller value whose
   value rounds differently. `field keys` sends the knob's controller
   with its new value on the keymap's channel.
3. Hold `ArrowUp` or `ArrowDown` to keep turning. After 300 ms the knob
   turns a step every 40 ms, two steps from one second, and four from
   one and a half, so a knob crosses its whole range in about 2.3
   seconds. It stops at either end and when you release the key.

A knob you have not turned shows its default, and its first turn starts
from the controller value nearest the default. Knob values last for the
session.

Each value keeps its width as it changes, so turning a knob never moves
the knobs after it or the notes. On a terminal too narrow for every
knob, the line shows the knobs around the chosen one, with `‹` or `›`
where knobs are hidden; the window moves only when the choice leaves
it. The knob line appears whenever the keymap binds `knob`, `turn`, or
`type` ([Actions](#actions)), which `musical` does.

The knobs are MIDI, so they turn whatever listens to `Field Keys`: an
instrument `field keys` plays, Logic, or a hardware synth. A take you
record keeps every turn ([Record what you play](#record-what-you-play)).

### Type a value

To move a knob far, type where you want it. In `musical` the number row
types; it plays no notes.

1. Choose the knob, then type its value in the units its knob file
   names: `800` for 800 Hz on `cutoff`, or `0.8` for 800 ms on
   `attack`. `mod` takes 0 to 127. The knob shows what you have typed in
   place of its value, as in `cutoff  800_ Hz`, and nothing is sent yet.
2. Press `Enter`. `field keys` clamps the number to the knob's range and
   takes the controller value whose value is nearest it, because a
   controller carries only 128 values: `800` on `cutoff` lands on
   `810 Hz`, `99999` on `15.0 kHz`, and `20` on `50.0 Hz`.
3. The knob glides there. `musical` crosses a knob's whole range in one
   second, so 15.0 kHz to 810 Hz takes about half a second, sending one
   control change every 40 ms. A keymap with `glide: 0` sets the value
   at once.

While you type:

- **`.` types the decimal point.** With no value open, `.` does what
  the keymap binds there, which in `musical` is the bend up, so a value
  cannot start with it: type `0.5`, not `.5`. `-` types a minus sign,
  only first. A key that would make the number malformed, such as a
  second `.`, does nothing.
- **`Backspace` deletes the last character**, and closes an empty value.
- **`Esc` cancels the value** and leaves the knob as it was.
- **A knob key completes the value first.** `ArrowLeft` or `ArrowRight`
  completes it, and then moves the choice while the knob glides on.
  `ArrowUp` or `ArrowDown` completes it and then turns, which stops the
  glide it started.
- **Every other key plays as usual.** Notes sound and the octave,
  velocity, sustain, and bend keys work, so you can type over a held
  chord. A value stays open until you close it.

A glide runs on its own, one per knob, so you can type a value on
another knob while the first glides. Turning the gliding knob stops its
glide where it is and turns from there, and a new value on it glides
from where it is. A panic, a keymap reload, and quitting stop every
glide.

Typing keys are positions, as every key in a keymap is, so `.` and `-`
are where QWERTY has them whatever your layout prints there. The
numeric keypad does not type.

### Knob files

A *knob file* describes an instrument's knobs. `field keys` reads it
beside the instrument's program, `juno.knobs.yaml` for `juno.scd`, and
adds its knobs after `mod` in the file's order:

```yaml
# shared/instruments/juno.knobs.yaml
knobs:
  - { name: cutoff, cc: 74, min: 50, max: 15000, curve: exp, units: Hz, default: 2000 }
  - { name: res, cc: 71, min: 0, max: 0.95, curve: lin, default: 0.3 }
  - { name: attack, cc: 73, min: 0.005, max: 4, curve: exp, units: s, default: 0.8 }
  - { name: release, cc: 72, min: 0.02, max: 8, curve: exp, units: s, default: 1.5 }
```

| Field | Default | Meaning |
| --- | --- | --- |
| `name` | Required | Shown on the knob line. |
| `cc` | Required | The controller that turns the knob. |
| `min`, `max` | 0 and 127 | The knob's range. A turn stops at its ends. |
| `curve` | `lin` | How the 128 controller values spread over the range: `lin` evenly, `exp` by equal ratios, for a frequency or a time. |
| `step` | 0 | The quantum the knob's values round to; 0 for none. A turn moves to the next value that rounds differently, so a knob with two positions moves in one press. |
| `units` | None | Shown after the value. |
| `default` | `min` | The value the instrument starts at. |

Controller value `v`, from 0 to 127, means `min + (max - min) * v / 127`
on a `lin` knob and `min * (max / min) ** (v / 127)` on an `exp` knob,
rounded to `step`: SuperCollider's `ControlSpec.map` for its warps of
the same names. An `exp` knob prints three significant digits, with `k`
from 1000 up and, for a knob in seconds, `m` below 1, as in `2.00 kHz`
and `800 ms`. A `lin` knob prints the decimal places that give the end
of its range farthest from zero three significant digits, or its
`step`'s places when it has more, so a `step` of 2.5 prints `2.5`. A
knob with a whole `step` prints whole numbers.

`field keys` checks a knob file before it plays, as it checks a keymap,
and names each error:

- **The controller is free.** It is from 2 to 119, and not 6, 32, 38,
  64, or 96 to 101: bank select, data entry, sustain, and the
  parameter-number controllers. CC 1 is `mod`, and 120 to 127 are
  channel mode messages.
- **No name or controller appears twice** in one file, and no knob is
  named `mod`.
- **An `exp` range does not touch or cross zero.**
- **`min` and `max` differ, and `default` is inside the range**, ends
  included.

Saving a knob file while `field keys` plays takes its new knobs at once.
Each controller keeps its value, and the choice stays on the knob of the
same name. A save that fails the check keeps the knobs you had and names
the error on the status line. A save that passes also reloads the
instrument's voice, because the voice maps its controllers through the
file ([Make an instrument playable](#make-an-instrument-playable)).

`examples/bloom`'s `juno` and `bass` have the four knobs above, on
General MIDI 2's sound controllers, so a hardware controller set up for
General MIDI turns them too. Controllers 20 to 31 and 102 to 119 have no
assigned meaning and suit knobs of your own.

### Knobs for another instrument

Give `--knobs` a knob file to turn knobs on an instrument `field keys`
does not play, such as a hardware synth or an instrument in Logic. Write
the file to match the instrument's MIDI implementation; `field keys`
only shows the values, and the instrument decides what each controller
does.

```console
$ field keys --knobs ~/knobs/ju-06a.yaml
mod   0  cutoff 2.00 kHz
Field Keys · musical · transpose 0 · velocity 100 · bend +0 · –
```

A bare name, as in `--knobs juno`, is `shared/instruments/juno.knobs.yaml`
in the project. A value with a `/`, or ending in `.yaml`, is a path, and
a leading `~/` means your home directory. Repeat `--knobs` for more than
one file. With knobs from more than one instrument or file, each knob
after `mod` carries the name of where it came from: the track, the
program, or the file's name without `.knobs.yaml`, or without `.yaml`
when it does not end in `.knobs.yaml`, as in `keys.cutoff` or
`ju-06a.cutoff`. Two knobs on one controller share its value, and each
shows it through its own range.

## Play an instrument

`field keys <instrument>` plays a SuperCollider instrument from the
project's `shared/instruments/` shelf, by the name a `supercollider:`
entry gives it; `.scd` is added to a name with no extension. A path
works too. Inside a project it resolves from the project root, as a
`supercollider:` entry's `source:` does, so give it from the root even
in a subdirectory; outside a project a path is the only way to name an
instrument, and it resolves from where you are.

1. `field keys` publishes `Field Keys`, then starts a *voice host*:
   `sclang` running Field's `sc/voice-host.scd`. The instrument's line,
   above the status line, says it is starting.
2. The host boots its own `scsynth` on the output device: the one you
   give with `--device` (`field devices` lists them), or the system
   output. It runs at the device's current sample rate and never
   changes it, so `field play` and `field keys` can share a device.
3. The host loads the instrument's voice and plays it from every MIDI
   source except the `Field Seq <song>/<track>` ones, each of which
   carries one track's parts for that track's own voice, so a USB
   controller plays it too. The instrument's line shows it live, with
   its device and rate.

The voice's sound goes straight to the device, beside `field play`'s
rather than through the song's inserts and master chain. If something
moves the device to another sample rate while you play, such as a
`field play` of a song at another rate, the host restarts its server at
the new rate, and notes sounding at the switch stop. Without that
restart every note would play sharp or flat.

An instrument that cannot play stops `field keys` with the reason, such
as `creek-kit.scd does not answer FIELD_MODE=voice`. A name that is not
on the shelf lists what is, split into the instruments that play from
notes and those that only render, by whether each program reads
`FIELD_MODE`:

```console
$ field keys organ
field keys organ: no instrument program at …/examples/bloom/shared/instruments/organ.scd
In shared/instruments/:
  plays from notes: bass, juno, pad
  renders only:     creek-kit, seven-eight-loop (no FIELD_MODE=voice branch; Field's docs/keys.md says how to add one)
```

### Make an instrument playable

An instrument program renders from a spec when Field builds it. To play
it from notes as well, give it a voice mode: when `FIELD_MODE` is
`voice`, its value, the file's last expression, must be a SynthDef with
these controls, and it must not render or exit.

| Control | What the voice host sets |
| --- | --- |
| `freq` | The note's frequency in Hz |
| `amp` | The velocity divided by 127 |
| `gate` | 1 at note-on, 0 at note-off |
| `out` | The bus to write to: 0 when the voice plays straight to the device, a private bus when it plays through a track's effects. A voice must write to `out`, never to bus 0 itself |
| `mod` | Optional: the modulation wheel (CC 1), from 0 to 1, at note-on and whenever it moves |
| `cc<n>` | Optional: controller n, for every n from 2 to 119 but the sustain pedal (64), from 0 to 1, as `cc74`, at note-on and whenever it moves |

A voice may leave `mod` or any `cc<n>` out, and then that controller
does nothing to it. The voice writes two channels and frees itself after
`gate` goes to 0, with an envelope that ends in `doneAction: 2`. The
render variables are absent in voice mode, so check `FIELD_MODE` before
you read them:

```supercollider
(
if ("FIELD_MODE".getenv == "voice") {
	SynthDef(\myKey, { |out = 0, freq = 220, amp = 0.5, gate = 1|
		var env = EnvGen.kr(Env.asr(0.01, 1, 0.5), gate, doneAction: 2);
		Out.ar(out, Pan2.ar(SinOsc.ar(freq) * amp * 0.2 * env));
	})
} {
	// render mode: the program as it reads today
}
)
```

The host owns everything between MIDI and voices: one voice per
sounding note, the sustain pedal (CC 64), All Notes Off (CC 123), pitch
bend, which it applies to `freq` on every sounding voice, up to two
semitones either way, the modulation wheel, which it sets as `mod`, and
every other controller from 2 to 119 but the sustain pedal, which it
sets as `cc<n>`. It sets each controller's last value, one per
controller across every channel, on every sounding voice and on each
new one. The host knows nothing about knobs.

A voice maps each control it takes to a parameter of its own, as a
hardware synth maps a controller. To map a knob through its knob file's
range, so the range is written once, read the copy of the knob file that
`FIELD_KNOBS` names. Field sets it in voice mode when the instrument has
a knob file, live and in a render, and leaves it unset otherwise. The
copy is one that passed the knob file's check, with every field spelled
out, so a voice never reads a file `field keys` rejected. `juno.scd`
reads it this way:

```supercollider
var knobs = "FIELD_KNOBS".getenv.parseYAMLFile["knobs"];
var knob = { |name, fixed|
	var each = knobs.detect { |knob| knob["name"] == name };
	if (each.isNil) { fixed } {
		var spec = ControlSpec(each["min"].asFloat, each["max"].asFloat, each["curve"].asSymbol, each["step"].asFloat);
		spec.map(("cc" ++ each["cc"]).asSymbol.kr(spec.unmap(each["default"].asFloat), 0.05))
	}
};
```

Inside the SynthDef, `knob.("cutoff", k[\vcfFreq])` is then the cutoff
as a signal, from 50 Hz to 15 kHz, starting at its default. A knob file
can leave out any knob, so when it has no `cutoff`, the voice keeps
`k[\vcfFreq]`, the fixed cutoff. `parseYAMLFile` reads every number as a
string, hence `asFloat`, and the lag smooths the steps between
controller values. A knob must be a value the graph uses as a signal; a
setting the graph tests with `if` stays a constant.

Saving the program while `field keys` plays loads it again. The next
note plays the new voice, and notes already sounding finish as they
started. A save that does not load, such as one with a syntax error,
leaves the last voice that loaded playing, and the instrument's line
says why:

```console
juno kept its last voice: juno.scd does not compile: syntax error, unexpected end of file
```

The next save that loads puts `· reloaded` on the line instead.

`examples/bloom` has three instruments that answer voice mode:

- **`pad`** — the song's sine pad; its render branch is
  unchanged and renders the same bytes as before.
- **`juno`** — the JU-06A, a model of the Roland Juno's chain from
  [okamnesiac/offset](https://github.com/okamnesiac/offset), set to the
  classic Juno pad: saw and pulse with the width swept, a slow attack,
  and the chorus on. The modulation wheel adds vibrato, as the lever on
  a Juno's bender does, and its knobs turn the filter's cutoff and
  resonance and the envelope's attack and release.
- **`bass`** — the same JU-06A set as offset's bass: a saw with a square
  sub an octave down, a short envelope that opens the filter on each
  note, and no chorus. The modulation wheel opens the filter, up to four
  times its cutoff, and its knobs are `juno`'s four. It plays at true
  pitch, so in `musical` press `Z` to drop an octave.

### Write parts from a pattern

A program can also write parts. When `FIELD_MODE` is `notes`, its value,
the file's last expression, must be a Pattern of note events, and it
must not render or exit. `field sc notes` plays that pattern with no
server and prints a part ([cli.md](cli.md) "Write a part from a
pattern"). The render variables are absent in notes mode, as they are in
voice mode, so check `FIELD_MODE` before you read them:

```supercollider
(
if ("FIELD_MODE".getenv == "notes") {
	Pbind(\midinote, Pseq([36, Prand([43, 46, 48], 1)], inf), \dur, 0.5, \amp, Pwhite(0.5, 0.9))
} {
	// voice and render modes: the program as it reads today
}
)
```

Each event that is not a rest writes one note for each pitch it sounds:

| Part field | What the event gives it |
| --- | --- |
| `at` | Where the event starts, the sum of the `dur` values before it |
| `length` | Its `sustain` |
| `note` | The pitch it sounds, rounded to a MIDI note, however the pattern spells it: `\midinote`, `\note`, `\degree`, `\freq`, `\ctranspose`, or `\harmonic` |
| `velocity` | Its `amp` times 127, from 1 to 127, because the voice host plays a velocity at `amp` velocity / 127 |
| `channel` | Its `chan` plus 1, because a pattern counts channels from 0 |

`field sc notes` stops with the reason when a program's value is not a
Pattern, when the pattern fails as it plays, when an event's `dur` is
negative or not a number, when a note falls outside MIDI's 0 to 127 or a
`chan` outside 0 to 15, or when 100,000 events go by without reaching
the last beat.

## Play a track

Name a track instead of an instrument, and `field keys` plays the
track's `instrument:`, whether or not the track has any takes or parts
yet. Name several, and every key plays all of them at once:

```console
$ field keys creek/track:keys creek/track:bass
keys (juno) + bass (bass) live at 48000 Hz on MacBook Pro Speakers
mod   0  keys.cutoff 2.00 kHz  keys.res 0.300  keys.attack  800 ms  keys.release  1.50 s  bass.cutoff 1.20 kHz ›
Field Keys · musical · transpose 0 · velocity 100 · bend +0 · C3
```

A target with `track:` in it is a track; anything else is an
instrument, so you can mix the two. A track with no instrument plays
the track with one under it, down its `track:` inputs, so naming a bus
plays the part it carries. If more than one track with an instrument is
under it, `field keys` lists them and stops, and you name the ones you
mean.

A track you name plays through its effects and the effects of every
track above it, up to `main`'s, as the song would play it. `field keys`
opens an input for the track in `field-audiod`, loads the song's live
session with it, and the voice host writes the track's voice into that
input through FieldOut, a SuperCollider plugin that ships with Field
([audio-engine.md](audio-engine.md) "Live inputs"). With the song
stopped, you play over silence; press play in another terminal
(`field transport play`) and you play over the song. When you quit,
`field keys` closes the inputs and loads the song again without them,
keeping the loop, region, and solo another terminal set.

Each track gets a voice of its own, even when two share an instrument.
An instrument you name without a track still plays straight to the
device. The voice plays on the daemon's device, so the two share a
clock, and reaches the speakers late by the daemon's block plus 256
frames, the margin its reader keeps, and the latency of the limiters
and hosted plugins on its way up, a few milliseconds for the built-in
limiter. `field play`, its `--watch`, `field ui`, and `field record`
keep the voice routed when they load the song again, and the inputs
close with `field keys`, even when it is killed.

When a track's voice cannot go through the daemon, it plays straight to
the device, and the instrument's line says why, and which effects on its
way to the speakers, from `main` down, you are not hearing:

```console
keys (juno) live at 48000 Hz on MacBook Pro Speakers · dry: the effects on main, keys-bus are not heard (FieldOut is not built: run field upgrade audiod)
```

With no effects on its way, the line ends `· dry (<why>)`.

That happens when FieldOut is not built, on Windows, which has no
POSIX shared memory, when the daemon predates live inputs, when the
tracks you name are in two songs, because one session plays one song,
when `--device` names a device other than the daemon's, when the
device cannot run at the song's rate and the daemon converts it, or
when `FIELD_FIELDOUT` names a directory with no FieldOut in it. If
FieldOut does not load in `scsynth`, the ring stays empty, and the line
says so within two seconds of the voice going live.

## Record what you play

A track's `record:` entry records what you play when the track has an
instrument. The take keeps the notes, not the sound, and the build
renders them through the instrument, so changing the instrument
changes every take recorded for it.

1. Give the track an instrument and a record entry:

   ```yaml
   # songs/creek/tracks/keys.yaml
   name: keys
   instrument: pad
   inputs:
     - record:
   ```

2. In one terminal, play the instrument so you hear it while you
   record: `field keys pad`.
3. In another, record against the song. With nothing playing, `field
   record` loads the song as the bed. Press Ctrl-C to stop.

   ```console
   $ field record creek/track:keys --at 17
   live    creek
   armed   MIDI from Field Keys  (48000 Hz, latency out 512 samples)
   recording take-20261010-143012 from 17.1.1 (0:32.0)
     17.3.2 (0:33.2)  14 events 1.2s
   take    creek/keys ← take-20261010-143012 at bar 17, chosen (audio/keys/take-20261010-143012.notes.yaml, 4.2 s, 31 events)
   ```

4. `field build creek` renders the take through the instrument, and
   `field play creek` plays it in the mix.

A MIDI take listens to every MIDI source on the machine when
`field record` arms, so a controller records too. Start `field keys`
and connect controllers first: a source that appears after the arm is
not heard. `--at`, `--until`, `--click`, and `--count-in`
work as they do for audio; `--input`, `--device`, and `--loop` are for
audio takes only. The take lands in ticks, with the output latency
alone taken off its notes, because you play in time with what you hear,
so it stays on the beats you played after a tempo edit. `field choose`
picks among takes as it does for audio. For the files a take leaves,
and how to copy one into a part you can edit, see
[project-model.md](project-model.md) "MIDI takes" and "Parts".

Name several tracks to record them in one pass: every track with an
instrument that you name records the same notes, and an audio track records its own input,
so you can sing and play at once:

```console
$ field record creek/track:vox creek/track:keys --at 17
```

A take records every knob you turn while it runs, and its render turns
the instrument's knobs where you did. It also starts where your knobs
are. Run inside a project, `field keys` keeps the controllers it has
sent, the wheel among them, in `.field/keys.json`, and removes the file
when it quits. When it cannot write the file, it keeps playing and names
the error on the status line, and a take starts without those knobs.
`field record` passes them to the daemon when it arms, and the daemon
writes them at the take's first sample with every control change that
arrives after the arm and before the start, including during a
count-in. So a knob you turned before the take, on
`field keys` or a hardware controller, renders where you left it. A
daemon that predates this starts a take with every knob at its default:
`field transport quit`, then record again, and it respawns on the new
build.

## Keys are read by position

A keymap binds *positions*: physical keys, named by their W3C
`KeyboardEvent.code` value, such as `KeyA`, `Semicolon`, `Digit1`, or
`Space`. The name comes from the key a US keyboard has in that place,
but it means the place, whatever your keyboard layout types there. On
Dvorak, `KeyS` types `o`; on AZERTY, `KeyA` types `q`. Both still play
what `KeyS` and `KeyA` play on QWERTY, so you never switch layouts to
play.

`field keys` finds the position from the terminal's *base layout key*
when the terminal sends one, which Ghostty does. Otherwise, on macOS, it
reads your keyboard layout and works back from the character typed. It
follows a layout switch while you play. On Linux it relies on the
terminal alone.

A dead key types nothing on its own and waits for the next key, such as
`'` on U.S. International. The terminal holds it for composition, so it
may never reach `field keys`. When your layout has a dead key where the
keymap binds one, the status line names that position as one that
cannot play.

## The default keymap

`field keys --print` draws a keymap as a keyboard, with the note or
control in each key's place, and lists what each control does. Notes are
in scientific pitch notation, where MIDI note 60 is C4. Logic names the
same note C3.

```console
$ field keys --print
musical: Field's take on Logic Pro's Musical Typing. White keys on the home row, black keys above, the arrows choose and turn knobs, and the number row types a knob's value.

·     1     2     3     4     5     6     7     8     9     0     -     ·
   cc64  ·     C#4   D#4   ·     F#4   G#4   A#4   ·     C#5   D#5   ·     F#5   ·
          C4    D4    E4    F4    G4    A4    B4    C5    D5    E5    F5
             T-12  T+12  V-20  V+20  ·     ·     ·     B-1   B+1   ·

← K-1   → K+1   ↑ R+1   ↓ R-1
```

| Keys | What they do |
| --- | --- |
| `A S D F G H J K L ; '` | White keys, C4 up to F5 |
| `W E`, `T Y U`, `O P`, `]` | Black keys, C#4 up to F#5 |
| `Z`, `X` | Transpose down or up an octave |
| `C`, `V` | Velocity down or up by 20, between 1 and 127 |
| `,`, `.` | Pitch bend fully down or up while held |
| `Tab` | Sustain (CC 64) while held |
| `←`, `→` | Choose a knob |
| `↑`, `↓` | Turn the chosen knob, faster while held |
| `1` to `0`, `-` | Type the chosen knob's value; `.` types the decimal point while you type |
| `Enter`, `Backspace`, `Esc` | Complete, edit, or cancel the value you are typing |
| `Ctrl-C` | Quit |

`musical` plays every note where Musical Typing does, adds F#5 on `]`,
the next black key after `'`, and keeps its octave, velocity, and
sustain keys. Logic's guide describes `Tab` as
turning sustain on or off; this keymap holds sustain only while `Tab` is
down, as a pedal does. The bend moves to `,` and `.`, the keys that show
`<` and `>`, the modulation wheel is the knob `mod`, which the arrows
turn, and the number row types a knob's value. To bend on `1` and `2`
and set the wheel in steps on `3` to `8`, as Logic does, copy `musical`
into a keymap of your own ([Write a keymap](#write-a-keymap)) with these
controls in place of the bend's and the typing keys:

```yaml
  Digit1: { bend: -1 }
  Digit2: { bend: 1 }
  Digit3: { cc: 1, value: 0 }
  Digit4: { cc: 1, value: 25 }
  Digit5: { cc: 1, value: 51 }
  Digit6: { cc: 1, value: 76 }
  Digit7: { cc: 1, value: 102 }
  Digit8: { cc: 1, value: 127 }
```

No built-in copies Musical Typing exactly, so `--keymap musical-typing`
fails as any unknown name does, with a message that lists the
built-ins.

## The other built-in keymaps

Two more keymaps ship with Field. Each puts octave and velocity on the
arrows and sustain on `Space`, because notes take the rows `musical`
keeps for controls, so neither has knob keys or a knob line. A keymap of
your own can bind the knob actions.

| Keymap | What it plays | Range |
| --- | --- | --- |
| `tracker` | The layout trackers use, from FastTracker 2 to Renoise: the `Z` row and the `Q` row as two piano octaves, each with its black keys on the row above. `Z` plays C3. | 32 notes |
| `fourths` | An isomorphic grid: one semitone per key to the right, and each row a perfect fourth above the row below, as on a bass guitar or Ableton Push. A chord shape plays the same in every key. `Z` plays C3. | 27 notes |

Run `field keys --keymap tracker --print` or `--keymap fourths --print`
to see either one laid out on the keyboard.

## Choose a keymap

| You give | `field keys` loads |
| --- | --- |
| Nothing | `musical` |
| `--keymap tracker` | The built-in of that name. A bare name only ever names a built-in. |
| `--keymap ~/keymaps/mine.yaml` | That file. A value with a `/`, or ending in `.yaml`, is a path, and a leading `~/` means your home directory. |
| `FIELD_KEYMAP=<name or path>` | The same, when there is no `--keymap`. |

To make your own keymap the default, set it in your shell profile:

```sh
export FIELD_KEYMAP=~/keymaps/mine.yaml
```

## Write a keymap

A keymap is a YAML file. This one plays C and E on two keys, a C major
chord on a third, and toggles sustain with the space bar:

```yaml
name: mine
base: 60
notes:
  KeyA: 0
  KeyS: 4
  KeyF: [0, 4, 7]
controls:
  Space: { cc: 64, mode: toggle }
```

Run it with `field keys --keymap ~/keymaps/mine.yaml`. While it runs,
saving the file reloads it: the next key press uses the new keymap, and
notes already sounding finish as they started. A controller you toggled
on, such as this example's sustain, goes back to 0 on the reload, so the
notes it was holding end. If the saved file has an error, `field keys`
keeps the keymap it has and shows the error in the status line.
`field keys --keymap ~/keymaps/mine.yaml --print` draws it without a
supported terminal, which helps while you design one.

### Fields

| Field | Default | Meaning |
| --- | --- | --- |
| `name` | Required | Shown in the status line. |
| `description` | None | One line, shown by `--print`. |
| `base` | 60 | The MIDI note that offset 0 plays before any transpose. |
| `velocity` | 100 | The starting velocity. |
| `channel` | 1 | The MIDI channel, 1 to 16. |
| `glide` | 0 | The seconds a typed value takes to cross a knob's whole range; a shorter move takes its share. 0 sets a typed value at once. |
| `notes` | None | Each position to an offset in semitones from `base`, or to a list of offsets, which plays a chord. |
| `grid` | None | Offsets for whole rows by a rule. An entry in `notes` or `controls` overrides the grid at that position. |
| `controls` | None | Each position to an action. |

### Grids

A grid writes an isomorphic keymap, where every interval has the same
shape everywhere, in one line. This one puts a semitone between
neighboring keys and a perfect fourth between rows:

```yaml
name: fourths
base: 48
grid: { rows: [bottom, home, top, number], column: 1, row: 5 }
controls:
  ArrowLeft: { transpose: -12 }
  ArrowRight: { transpose: 12 }
```

| Grid field | Meaning |
| --- | --- |
| `rows` | The rows, lowest first. Each is a named row, or a list of positions in which `null` skips a column so you can align rows. The named rows are `bottom` (`KeyZ` to `Slash`), `home` (`KeyA` to `Quote`), `top` (`KeyQ` to `BracketRight`), and `number` (`Digit1` to `Equal`). |
| `column` | Semitones per key to the right. |
| `row` | Semitones per row up. |

A position's offset is `column` times its index in its row, plus `row`
times its row's index. In the example, `KeyZ` plays 48, `KeyA` 53,
`KeyQ` 58, and `Digit1` 63.

### Actions

| Action | Effect |
| --- | --- |
| `{ transpose: <n> }` | Shifts every new note by n semitones, and stays shifted. A transpose that would move any note outside 0 to 127 is refused. |
| `{ velocity: <n> }` | Changes the velocity by n, kept between 1 and 127. |
| `{ bend: <x> }` | Pitch bend to x, from -1 to 1, while held; back to center on release. |
| `{ knob: <n> }` | Moves the knob choice n knobs to the right, or to the left when n is negative, wrapping past either end. |
| `{ turn: <n> }` | Turns the chosen knob n steps up, or down when n is negative, at the press, and keeps turning faster while held ([Turn knobs](#turn-knobs)). Pressing a second turn key turns with it and stops the first. |
| `{ type: <c> }` | Types c into the chosen knob's value ([Type a value](#type-a-value)): a digit, written as a number from 0 to 9 as in `type: 1`, or `"-"`. The decimal point is no action: `Period` types it while a value is open, in every keymap. |
| `{ cc: <n>, value: <v>, mode: <m> }` | Controller n. Mode `set`, the default, sends v at each press. `hold` sends v while held and 0 on release. `toggle` alternates v and 0, and goes back to 0 when you quit, press `panic`, or reload the keymap. `value` defaults to 127. |
| `panic` | Releases every note, stops a held turn and every glide, and sends All Notes Off. Write it as a bare word: `Backquote: panic`. |

`knob` and `turn` take a whole number other than 0. A keymap that binds
`knob`, `turn`, or `type` shows the knob line.

### Rules

`field keys` checks a keymap before it plays, and names the position
and the rule each error breaks:

- **Every position is one a keymap can bind.** That is the four named
  rows, `Backquote`, `Backslash`, `IntlBackslash`, `Space`, `Tab`, and
  the four arrows.
- **A position is a note or a control, never both.**
- **`Escape` is reserved.** It cancels a typed value, and `Ctrl-C`
  always quits, so no keymap can trap you. `Enter` and `Backspace` act
  only on a typed value and are not positions a keymap binds either.
- **Every note is in MIDI's range** at `base`, and the keymap plays at
  least one note.
- **Modifiers do not bind.** A key pressed with `Ctrl`, `Alt`, or `Cmd`
  held does nothing, and `Shift` plays as without it. A release always
  ends the notes its press started.
- **Two keys can share a note.** The note sounds from the first press
  until the last of those keys is released.
