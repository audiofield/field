# Audio engine

`field-audiod` exists today as the daemon that plays and captures:
device I/O, a sample-accurate transport, audition of built labels, live
evaluation of the session graph with the build cache as automatic track
freezing ([projects/realtime/readme.md](projects/realtime/readme.md)),
hosted plugins, the input side of recording — arm, record, stop, a
crash-safe transaction and its recovery — described in
[architecture.md](architecture.md) and under
[Capture as built](#capture-as-built) below, and MIDI outputs that send
scheduled MIDI and MIDI clock on time ([MIDI outputs](#midi-outputs)). Takes land in the project
and build in place
([projects/recording/readme.md](projects/recording/readme.md));
monitoring through the engine is `field record --monitoring host`
([Monitoring](#monitoring-host-vs-apollo-direct)), and comping is later
work. This
document records the decisions already settled so the phases that build
it start from agreement, not from scratch. Language and framework
decisions (C++/JUCE, and the alternatives rejected) also live in
[architecture.md](architecture.md).

## Responsibilities

Device discovery and I/O (Core Audio, Apollo), sample-rate and buffer
management, transport and timeline clock, playback, recording,
low-latency monitoring, metronome/count-in/looping/pre-roll/punch,
multitrack sync, AU discovery/hosting/parameter/state management, UAD-2
and UADx execution, plugin latency reporting and delay compensation,
routing/buses/sends, real-time automation, offline rendering where
supported, safe file writing, crash recovery, and peak generation.

Sends did not wait for this engine:
[projects/nested-tracks/readme.md](projects/nested-tracks/readme.md) §19
renders them offline, and that shipped first. A label links exactly one
send to one receive, the edge carries a level and a tap point and never
an offset, and a receive may sit only where its path to the cable's
common ancestor accumulates zero time displacement — which is what makes
arrival times derivable rather than invented (the ambiguity §14
recorded). The engine inherits that schema unchanged: routing/buses/
sends stays on the responsibility list above as the live half of the
same design, and plugin latency compensates to the same answer the
offline render reaches.

## Three real-time paths

During recording, three related but distinct paths run simultaneously:

- **Playback**: existing tracks → instruments/generated nodes → inserts
  → buses → monitor output.
- **Monitoring**: live input → optional monitor effects → cue/monitor
  bus → output. Monitor effects are not printed.
- **Capture**: live input → recording tap → safe disk writer → take
  asset. Capture takes the dry input by default; printed capture
  (`capture.mode: printed`) requires explicit user action because it is
  destructive.

## Monitoring: host vs. Apollo direct

- **Host monitoring** — input through Field's engine and effects, out to
  the interface. Fully project-visible and controllable; costs buffer
  plus plugin latency.
- **Apollo direct** — input monitored in the Apollo's DSP (Console) at
  near-zero latency while Field handles playback and capture.

Host monitoring as built: `field record --monitoring host` arms each
audio track with `monitor`, a name, and the daemon opens a *capture
input* under it that reads that track's armed channel. The song is
loaded again with an input window on the track naming it, so the input
travels the same way a [live input](#live-inputs) does: through the
track's inserts, each bus above it, and `main`, beside the rendered
song, playing or stopped. The capture tap still takes the dry channel.
Disarming closes the capture inputs, and `field record` loads the song
again without them, while the daemon still plays it and no other take
records. The bypass-and-report latency policy below is not built: what
you hear is late by the input and output buffers and the limiters and
hosted plugins on the path.

**Decision — Console is configured manually in V1.** Console is the
mixer in the Apollo's DSP and matters only on the input side (preamp
gain, Unison, direct monitoring, cue mixes); for playback and mixing the
Apollo is just an output device. UA publishes no Console API, so Field
references an expected Console preset (`monitoring.mode: apollo-direct`,
`console_preset: vocal-tracking`) and does not promise automation.

## Latency

Latency is explicit and observable: input, output, buffer, plugin, and
look-ahead latencies, total host-monitoring latency, recorded-file
placement offset, and playback delay compensation are all tracked and
reportable. A latency policy can bypass or substitute high-latency
plugins (look-ahead limiters, linear-phase EQ) when entering record
mode; any changes made for low-latency mode are clearly reported.

## Live inputs

A live session can carry an *input*: a source outside the session that
the daemon reads every block, such as the voice `field keys` plays. An
input window names its source and has a gain and a pan, but no place on
the timeline:

```json
{ "input": "keys-voice", "gain_db": 0 }
```

An armed input is the other source: `field record --monitoring host`
names each armed audio track's input `capture:<song>/<track>`
([Monitoring](#monitoring-host-vs-apollo-direct)), and the daemon reads
it straight from the block its callback is in, one channel on both
sides.

The song still renders as before. The input travels beside it: its
track and each track above it run a second instance of their chain on
what the input carries, and `main` adds the result to its own mix before
its own chain. The input reaches each track once, however many times
the arrangement places its track. Where it reaches a track along paths
of unequal latency, the shorter ones are delayed to match the longest,
and it reaches `main` late by that longest path's limiters and hosted
plugins.
[live-supercollider.md](projects/live-supercollider/readme.md) §9
describes the overlay and what it gives up.

The daemon feeds an input from a ring that FieldOut, a UGen in the
voice host's scsynth, writes. The `input` op makes the ring under a
name and answers its number, which FieldOut takes:

```json
{ "op": "input", "name": "keys-voice" }
{ "ok": true, "name": "keys-voice", "ring": 4213871, "capacity": 8192, "channels": 2, "sample_rate": 48000 }
```

A session whose input window names an open input reads it every block;
one that names no open input is refused. With the transport stopped,
the daemon still plays what the inputs reach, through a second instance
of the output's chain, so you play over silence while the song's own
chain and position stay where they were. A gain ramp on a window the
input passes through glides on a clock of the overlay's own, which keeps
moving while the transport is stopped, so the glide finishes either way.
A stop or a pause clears that second chain, so what you play next over
silence carries nothing from before play. That idle path needs the device
at the session's rate; under converted delivery a stopped session is
silent and reads nothing. The reader keeps a block plus 256 frames in
hand, the block being the largest it has been asked for, drops the
oldest frames when the writer runs fast enough to hold twice that, and
when the writer stops, plays what it holds and waits to fill again.
When nothing read for longer than the ring holds, about 170 ms at
48 kHz, the writer drops what does not fit, and the reader starts again
at the present rather than play the past. `status` lists each open
input with its counters: frames `written`, `read`, and `dropped` for
want of room, the reader's `underruns` and `skipped` frames, and the
`peak` it read since a client last asked. `input_close` frees the name;
a session still reading the ring keeps it until the session goes, and an
input closes on its own when the connection that opened it drops, so a
`field keys` killed outright leaves nothing open.
A daemon that does this lists `live-input` in `hello.features`. The ring
is POSIX shared memory, so Windows has no live inputs yet.

`field-audiod --render-live` feeds an input from a file instead,
`--ring-feed` writes a file into an open input's ring at real-time pace
as FieldOut would, and `--ring-selftest` checks the reader against the
writer FieldOut runs:

```sh
field-audiod --render-live session.json out.wav --input keys-voice=take.wav
field-audiod --ring-feed 4213871 take.wav
field-audiod --ring-selftest
```

FieldOut lives in `native/sc-fieldout`, under GPL-3.0, because it builds
against SuperCollider's plugin interface; its
[README](../native/sc-fieldout/README.md) says how to build and load
it.

## Crash-safe recording

Recording is transactional: a `.field/recording/<transaction-id>/`
directory holds a manifest, a journal, and audio written continuously in
recoverable chunks. A normal stop finalizes the asset and writes a take
manifest (timeline placement, device, latency, session metadata),
and the take's row records how it was monitored; after a crash, Field
recovers any valid audio from the transaction.

## Capture as built

The daemon opens its device output-only until something arms
([recording.md](projects/recording/readme.md) §5), so a playback-only
session never asks for the microphone. `arm` names a track, an input
device, and a channel counted from 1; the daemon reopens the device
with that one input channel active and reports the input and output
latency the device declares, in samples. `record` starts a take: it
opens the take's transactions, locates the bed to `at` when you give
one, with no block between the jump and the start, starts the transport
if it is stopped, and captures from the next callback block. The callback
latches that block's transport position as `started_at_samples`, so the
first captured sample and the position it is placed at describe the
same instant. `stop` and `pause` finalize the take and return its
manifest; a `take` event carries the same manifest to every connected
client, which is how a `field record` blocking in one terminal learns
that `field transport stop` in another ended its take.

A transaction is one directory, `.field/recording/take-YYYYMMDD-HHMMSS/`:

- `take.wav` — float32 mono at the device's rate, appended block by
  block. The header's sizes read zero until finalize patches them,
  which is what marks a transaction incomplete on disk.
- `journal.json` — the frames `fsync` has reached the disk with,
  rewritten once a second, and the frames the FIFO refused.
- `manifest.json` — track, device, input, the take's rate and the bed's,
  both latencies, `started_at_samples`, and `complete: true` with
  `frames` once finalized.

The audio callback copies the armed channel into a lock-free FIFO and
does no I/O. A writer thread drains the FIFO to the file every 20 ms. If
the writer falls more than the FIFO holds behind — about twenty seconds
at 48 kHz — the frames that did not fit are counted in `dropped` rather
than blocking the callback, and the manifest carries the count.

To recover a take a dead daemon left behind:

1. Start the daemon. Any `field record` or `field play` does; it lists
   incomplete transactions in `.field/audiod.log`.
2. Run `field record --list` to see every transaction with the frames
   on disk.
3. Run `field record --recover <id>`. The daemon patches the header from
   the file size and marks the manifest `recovered`.

An armed or recording daemon never idle-exits. While a take runs, the
daemon refuses `locate`, `load`, `device.select`, a second `arm`, and
`disarm`, and it defers default-output following and sample-rate
switching until the take ends, because each would restart the device
and gap the capture. A session swap is allowed: it carries the
transport.

## The metronome

`field play --click` and `field record --click` put a metronome in the
output, and `field record --count-in <bars>` counts a performer in
([recording.md](projects/recording/readme.md) §7). The CLI projects the
song's tempo map into a schedule — `{rate, ticks: [{sample, accent}]}`,
positions on the bed's timeline at the rate the daemon's positions count
in — and sends it with the `click` op. The daemon synthesizes each tick
in the callback against the same block-start position the capture
latches on: 15 ms of sine, G6 on the downbeat and C6 elsewhere, decaying
over 4 ms, added to every output channel and never to the capture or to
anything `field build` renders. A schedule belongs to a bed: `load` and
a fresh `session` clear it, a session swap keeps it and the watch loop
re-sends it when the map may have moved, and the CLI clears it when its
play or take ends. Positions scale into the device's rate when they
differ, so a 48 kHz schedule lands on the same instants through a
44.1 kHz device.

A count-in is a pre-roll: `record` takes a `start` beside `at`, the
transport locates to `start` and plays, and the callback begins the
take on the first sample at or after `at` — mid-block, so
`started_at_samples` is `at` exactly — while `status` reports the take
as `pending`. `--count-in N` schedules ticks only over the N bars before
`--at`; `--click` schedules the whole bed. The same `start` is the
punch-in the plan's chunk 4 builds on.

`field-audiod --render-live <session> <out> --click <schedule.json>`
runs the same click layer offline at the session rate, which is how the
suite proves tick positions to the sample; it is never used for a
golden.

## Punch-out and loop takes

`record` takes an `until` beside `at`
([recording.md](projects/recording/readme.md) §10.4): the callback
ends the take on that exact sample, mid-block, and the heartbeat
finalizes it on the message thread while the transport keeps rolling.
`field record creek/track:lead-vocal --at 17 --until 21` lands exactly
bars 17 to 20 and then stops the transport, the way ctrl-c does. An
`at` is exact in the other direction too: the request is armed before
the transport starts, so the first rolling block latches on `at`
itself, and a take asked for on a bed already rolling toward `at`
waits for it as a punch-in.

With `loop`, the live session loops the region `[at, until)` and every
pass is a take. The next transaction is opened ahead of each wrap, so
the callback hands the frames after the wrap point to it inside the
same block: the pass that ends and the pass that begins meet on
consecutive samples, which the suite proves on the null clock's
sawtooth. Each take reaches every client as a `take` event as it
finalizes, and `field record --loop` lands them as they arrive, the last
one chosen, until ctrl-c — whose partial pass is a take too.

The heartbeat finalizes each take the callback has ended since its
last tick, however many there are. It opens the next pass's
transaction before it finalizes, so a slow finalize costs no pass. A
pass that begins with no transaction open is skipped whole and counted
in `record.missed`. That happens when the region is shorter than a
heartbeat tick, or when the message thread falls behind. The
transaction opened late begins at the following wrap, and `status`
reports it as `pending` until then, so every take is a whole pass that
starts at `at`. `field record` reports the skipped passes on its live
line and in its closing tally.

A `session` swap during a loop take, such as the one `field play
--watch` sends after an edit, carries the take's region onto the
incoming session, as it carries the transport. The daemon refuses a
session that the region does not fit, and the take goes on against the
session already playing.

The region loop is the live session's own (`loop {from, to}`, `to`
defaulting to the content's extent): the clock wraps from `to` back to
`from` with the chains ringing across the wrap exactly as they do at
the declared extent, `status` reports `loop_from` and `loop_to`, and a
load or a fresh session clears it. `field play <song> --from 5 --loop`
rides it now instead of being refused. A file bed loops only whole.

## MIDI capture

`arm` with `kind: "midi"` arms for a MIDI take
([keyboard-instrument.md](projects/keyboard-instrument/readme.md)
§12.4). The daemon opens every MIDI input the system lists at that
moment and no audio input, so arming for MIDI never asks for the
microphone; a source that appears later, such as a restarted
`field keys`, is not heard until the next arm. It leaves out the
virtual sources of its own [MIDI outputs](#midi-outputs), so a take
records what you play and not the part playing beside it. It answers
`{kind: "midi", sources, sample_rate, output_latency}`, where `sources`
names the inputs it opened. With no MIDI input to open, `arm` refuses
and tells you to start `field keys` or connect a controller. `disarm`
closes the inputs, and an `arm` of the other kind moves the arm. A
daemon that does this lists `record-midi` in `hello.features`.

Each message goes from JUCE's MIDI thread into a lock-free queue with
its arrival time on the host's high-resolution clock. The callback
notes the time each block begins and drains the queue there: a message
lands at the block's position plus the time between the block's start
and its arrival, at the device's rate. Because a message is drained at
the start of the block after it arrives, it is placed no earlier than
the previous block's start and no later than the current block's end,
and messages keep their arrival order. A take records channel messages
of one to three bytes; it leaves out system messages such as SysEx,
clock, and active sensing.

`record` starts a MIDI take with the same latch, `at`, `start`, and
`until` as an audio take, and refuses `loop`: loop takes record audio
only. The take counts the device's samples from its start, as an audio
take counts frames, so each message's `at` is in `sample_rate`. Messages
before the start, including during a count-in, and at or after `until`
are left out, except as the chase below keeps them. A take with `until`
ends at the first block that begins at or past it, and `stop` lets one
more block begin before it ends the take, so every message that arrived
in time is placed.

A MIDI take starts where the controllers were
([instrument-knobs.md](projects/instrument-knobs/readme.md) §2.8). From
the arm, the daemon keeps the latest value of each controller from 0 to
119 on each channel: first those `arm` passes in `controllers`, a list
of `{channel, cc, value}` with `channel` from 1 to 16, then every
control change that arrives, whether before a take, during one, or past
its `until`. At a take's first sample it writes one line per channel
and controller, at `at: 0` and ahead of every other line, in the order
the values last arrived, with the ones `arm` passed and nothing replaced
first. A change the take records is in the table only after those
lines, so it is never written twice, and a second take on one arm
starts each controller where the first take left it. Every MIDI take of
a pass gets the same lines. Controllers 120 to 127 are channel mode
messages, which act once, and are never chased. The table is 16
channels by 120 controllers, updated in constant time per message by
the callback, and each arm starts it over. `arm` refuses `controllers`
that are out of range. A daemon that does this lists `midi-chase` in
`hello.features`.

The transaction is a directory, `.field/recording/take-YYYYMMDD-HHMMSS/`,
as for audio:

- `take.midi.ndjson` — one line per message,
  `{"at":<samples from the start>,"midi":[<bytes>]}`, in `at` order,
  appended by the writer thread every 20 ms.
- `journal.json` — the samples elapsed, the lines `fsync` has reached
  the disk with as `events`, and `dropped`, rewritten once a second.
- `manifest.json` — `kind: "midi"`, `sources`, the take's rate and the
  bed's, `output_latency`, `started_at_samples`, and `complete: true`
  with `frames` and `events` once finalized. `frames` is the samples
  from the start to the stop or to `until`, and `events` is the lines
  written. It has none of an audio take's fields: no `device`, `input`,
  `channels`, `bit_depth`, `format`, or `input_latency`.

While the daemon is armed for MIDI, `status.record` reports `kind` and
`sources` in place of `device` and `input`, and `input_peak` is 0.
During a take it adds `events`, the messages captured so far, and
`frames` counts the samples elapsed. `recordings` lists a MIDI
transaction with its whole lines as `events_on_disk` and
`frames_on_disk: 0`. `recover` drops a partial last line, which is all
a crash can leave behind, and marks the manifest `recovered`; its
`frames` is the journal's count or one past the last message's `at`,
whichever is larger.

## Several armed tracks

`arm` with `tracks` arms several tracks at once
([arming.md](projects/arming/readme.md) §2.2). Each entry is
`{track, kind: "audio", input}` or `{track, kind: "midi"}`, and
`device` names the input device for the audio ones. The device opens
with every armed input active, and the MIDI ones hear every MIDI
source, so two armed MIDI tracks record the same notes. The answer
lists `armed`, the primary first: the first audio track, or the first
track when none is audio. The rest are companions. A daemon that does
this lists `record-tracks` in `hello.features`, and `arm` with one
track and `kind: "midi"` are one-entry forms of the same thing.

One `record` starts every armed track on the primary's latch, so every
take starts at the same bed position, and its answer adds `takes`, each
track's transaction. Every rule above runs on the primary, and the
companions follow it: an audio companion pushes the same span of its own
input, and `until` ends them all. MIDI companions of an audio primary
end a block later, as a MIDI take always does, and the pass finalizes
when every take has ended. `loop` refuses a set of more than one track.
`stop` and `pause` answer with `takes`, every track's manifest, beside
`take`, the primary's, and each take is its own `take` event.
With more than one track armed, `status.record` adds `armed`: each
track's kind, its input and meter, and while recording its transaction
and progress. When any of them records MIDI, `status.record` also lists
the MIDI `sources` they all hear.

## Landing a take

When a take finalizes, `field record` lands it
([project-model.md](project-model.md) "Recorded takes"): the bytes move
to `audio/<node>/<take>.wav` and pin in the song's ledger, a row goes
into `audio/<node>/takes.yaml` placing the take on the recording
track's timeline, the new take is chosen, and the transaction directory
is removed. The daemon reported the start on the bed's timeline; landing
subtracts the track's origin on that timeline — the `at`s down its first
placement path from the output track — and then the record entry's own
window start, so the row counts from the entry's `at` the way the graph
reads it back; the device's declared round trip, input plus output
latency, is recorded beside it, and both are converted into the track's
rate. A MIDI take lands as a notes file instead,
`audio/<node>/<take>.notes.yaml`, in ticks from where the take started
on the track, with the output latency taken off its notes. Its row's
`started_at_ticks` counts that start in ticks from the record entry's
`at`, which is where the take plays from, and `musical_position` says
where it was in the track's own time
([project-model.md](project-model.md) "MIDI takes"). `field record
--recover <id>` lands what it recovers, and `field record --land <id>`
lands a finalized transaction nothing landed.

## MIDI outputs

The daemon sends MIDI on time from schedules
([sequencer.md](projects/sequencer/readme.md) §2.5). Like the click, a
schedule is samples and bytes: the CLI projects the tempo map into it,
and the daemon never learns what a note or a bar is. The `midi_out` op
opens an output under a name, or replaces the schedule of the output
open under that name:

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
| `source` | The name of a virtual MIDI source the daemon publishes for the output. |
| `destination` | Instead of `source`: the name of an existing MIDI output port, such as a hardware synth's. An output takes one or the other. |
| `rate` | The rate `sample` counts in: the bed's, as the click's `rate` is. |
| `events` | Each `{sample, midi}`, a message of 1 to 3 bytes that starts with a status byte, in time order. At one sample, put note-offs first, then controller changes and bends, then note-ons. SysEx is refused. |
| `lead` | Samples to send each event early, for the time the receiver takes before its sound reaches the daemon. |
| `lead_input` | Optional. An input whose reader margin, a block plus 256 frames, the output leads by too. The input can open after the output. |
| `clock` | Optional. `{pulses}`, the samples of MIDI clock pulses, described below. |

A replaced schedule keeps the output's port, so whatever listens to a
source stays connected. The daemon refuses a replacement that names
another port, a second output on a source or destination already in
use, and a 65th output. `midi_out_close` with the `name` closes an
output, and an output closes on its own when the connection that opened
it drops, as an input does. Windows has no virtual MIDI sources, so
there the daemon refuses a `source` and sends only to destinations.

Each block, the callback takes the events whose sample falls in the
block's lookahead window: the block's span on the bed's timeline, moved
later by the lead. A window that crosses the end of a loop, the live
session's region or its own, or a looping file's, continues at the
loop's start, so the first notes after a wrap leave on time. The
callback pushes each event onto the output's queue, with no allocation
and no lock, with its time: the block's start on the high-resolution
clock MIDI capture stamps against, plus the event's offset, less the
lead. An event that the lead puts before the block's start, which only
the first block after play or a jump has, leaves at the block's start,
so the first notes after play or a locate leave late by up to the lead.
A schedule is built off the audio thread, swapped in by pointer at a
block's start, and freed off it.

A sender thread, at realtime priority, sends each event to a virtual
source at its time. On macOS it hands a destination's events to
CoreMIDI as soon as they are queued, each stamped with its host time,
which CoreMIDI delivers it at; `getMillisecondCounterHiRes()` and
CoreMIDI's host time both count `mach_absolute_time()`. Elsewhere it
sends a destination's events at their times, as it does a source's.

The daemon keeps the notes each output has started, and sends a
note-off for each on stop, pause, a locate, a loop wrap, a replaced
schedule, `midi_out_close`, and the end of the connection that opened
the output. A note that a locate lands inside is not started again.
Before the note-offs of anything but a wrap, the daemon unschedules
what CoreMIDI still holds for a destination with `MIDIFlushOutput`, so
nothing queued for a bed that stopped or jumped reaches the synth. It
flushes only when CoreMIDI holds something, because a flush reaches a
virtual destination as a System Reset (`0xFF`). The callback queues only
the events of the block it is in, so CoreMIDI holds some only when
blocks run back to back.

An output's `clock` lists the samples of its MIDI clock pulses (`0xF8`),
24 to the quarter note, which the CLI projects from the tempo map as it
projects the click. Pulses go out only while the transport plays,
through the same window and lead as events, and around them the daemon
sends the transport's changes:

| When the transport | The daemon sends |
| --- | --- |
| Plays from pulse 0 | Start (`0xFA`) |
| Plays from anywhere else | Song Position Pointer (`0xF2`), then Continue (`0xFB`) |
| Locates or wraps the loop while playing | Stop (`0xFC`), Song Position Pointer, then Continue |
| Stops or pauses | Stop |

Song Position Pointer counts sixteenth notes, 6 pulses each. It names
the first sixteenth at or after the transport's position, `ceil(i / 6)`
for the next pulse `i`, and the pulses resume at pulse 6 times that, so
the gear's count and the song's agree. An output that opens while the
transport plays starts as though it played from there.

`status` lists the open outputs as `outputs`: each one's `name`, its
`source` or `destination`, the messages it `sent`, those it sent more
than a millisecond after their time as `late`, and those its full queue
`dropped`. A destination on macOS also reports `early`, the messages
handed to CoreMIDI ahead of their time. The counts include the note-offs
and clock messages the daemon adds. A daemon that does this lists
`midi-out` in `hello.features`.

`field-audiod --midi-out-selftest` checks the callback's selection, the
lead and an input's margin, held notes, the clock's transport messages,
and a stop with events handed to CoreMIDI early, against a fake clock
and fake sinks. In null-output mode, `FIELD_AUDIOD_CAPTURE_OUTPUTS=1`
lets a MIDI take hear the daemon's own outputs, so a test can measure a
schedule's timing in the daemon that sends it, and on macOS the null
clock runs as a realtime thread, as a device's callback does, so its
blocks start on time on a loaded machine.
