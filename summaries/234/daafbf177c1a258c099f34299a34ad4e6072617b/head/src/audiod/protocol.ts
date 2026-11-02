import { z } from 'zod';

// The field-audiod control protocol (playback.md §3.3): NDJSON over a unix
// socket at .field/audiod.sock. These zod schemas are the source of truth;
// the C++ side (native/audiod) mirrors them by hand — the protocol is kept
// small enough that drift would fail the protocol tests immediately.

export const PROTOCOL_VERSION = 1;

// Who this daemon is and where it listens. Exported because two files
// need them and only one had them: `field --version` declared its own
// copies, so changing the socket path here would have left that command
// probing the old one and reporting a running daemon as not running —
// the answer nobody double-checks (#70 review). The workers get this from
// their WorkerSpec; audiod is the one daemon that had no such record.
export const DAEMON_NAME = 'field-audiod';
export const SOCKET_RELATIVE = '.field/audiod.sock';

export const helloResponseSchema = z.object({
  ok: z.literal(true),
  protocol: z.number().int(),
  daemon: z.string(),
  version: z.string(),
  // Capability names (realtime.md §3): clients gate on these rather
  // than parsing `version`. Absent from daemons that predate the field;
  // the default keeps them meaning "none of the newer verbs".
  features: z.array(z.string()).default([]),
  // The daemon's process id (daemon >= 0.12): what a test kills to prove
  // a take survives its daemon.
  pid: z.number().int().optional(),
});

export const deviceSchema = z.object({
  name: z.string(),
  default: z.boolean(),
});

// An input device and how many channels `arm` may name on it
// (recording.md §6).
export const inputDeviceSchema = z.object({
  name: z.string(),
  default: z.boolean(),
  channels: z.number().int(),
});

export const devicesResponseSchema = z.object({
  ok: z.literal(true),
  devices: z.array(deviceSchema),
  inputs: z.array(inputDeviceSchema).default([]), // daemon feature "record"
  null_output: z.boolean(),
});

// The input side (recording.md §5–6), as `status` reports it: idle,
// armed on an input, or recording into a transaction. `input_peak` is
// the largest |sample| on the armed input since the last status read —
// the V1 meter — and the daemon resets it on read, so one reader at a
// time sees the whole picture. Armed for MIDI (keyboard-instrument.md
// §12.4), `kind` and `sources` replace `device` and `input`, the peak is
// 0, and a take reports `events`.
export const recordState = z.enum(['idle', 'armed', 'recording']);
export const recordStatusSchema = z.object({
  state: recordState,
  track: z.string().optional(),
  device: z.string().optional(),
  input: z.number().int().optional(),
  kind: z.literal('midi').optional(), // daemon feature "record-midi"
  sources: z.array(z.string()).optional(), // the MIDI inputs the arm opened
  input_peak: z.number().optional(),
  transaction: z.string().optional(),
  file: z.string().optional(), // project-root-relative take.wav or take.midi.ndjson
  started_at_samples: z.number().int().optional(), // -1 until the callback latches
  // A pre-rolled take waiting for its position (daemon >= 0.13), or a
  // loop's next take waiting for the wrap that begins it.
  pending: z.boolean().optional(),
  // Punch-out and loop takes (daemon >= 0.14): where the take ends,
  // whether every pass is a take, how many have finalized, and how many
  // passes began with no transaction ready.
  until: z.number().int().optional(),
  loop: z.boolean().optional(),
  loop_takes: z.number().int().optional(),
  missed: z.number().int().optional(),
  frames: z.number().int().optional(), // pushed by the callback; a MIDI take's samples elapsed
  written: z.number().int().optional(), // reached the file (audio takes)
  events: z.number().int().optional(), // a MIDI take's messages captured so far
  dropped: z.number().int().optional(), // the FIFO refused (a stalled writer)
  // With more than one track armed, every one, the primary first (daemon
  // feature "record-tracks", arming.md §2.2): its kind, its input and
  // meter, and while recording its take and that take's progress.
  armed: z
    .array(
      z.object({
        track: z.string(),
        kind: z.enum(['audio', 'midi']),
        input: z.number().int().optional(),
        input_peak: z.number().optional(),
        transaction: z.string().optional(),
        frames: z.number().int().optional(),
        events: z.number().int().optional(),
        dropped: z.number().int().optional(),
      }),
    )
    .optional(),
});

// What arm opened: the device and input, its channel count, the rate
// the take's bytes will be at, and the latencies the device reports.
// The latencies are recorded, not yet applied — which of them placement
// subtracts is settled against real hardware (recording.md §3).
export const armResponseSchema = z.object({
  ok: z.literal(true),
  device: z.string(),
  input: z.number().int(),
  channels: z.number().int(),
  sample_rate: z.number(),
  input_latency: z.number().int(),
  output_latency: z.number().int(),
});

// What arm opened for MIDI (keyboard-instrument.md §12.4): every MIDI
// input the daemon could see, by name; the device's rate, which a MIDI
// take's times count in; and the output latency, the one placement
// subtracts from a MIDI take (§12.2).
export const armMidiResponseSchema = z.object({
  ok: z.literal(true),
  kind: z.literal('midi'),
  sources: z.array(z.string()),
  sample_rate: z.number(),
  output_latency: z.number().int(),
});

export const recordResponseSchema = z.object({
  ok: z.literal(true),
  transaction: z.string(),
  file: z.string(),
  started_at_samples: z.number().int(), // -1 while a pre-rolled take waits for its position
  // Every armed track's take, the primary's first ("record-tracks").
  takes: z.array(z.object({ track: z.string(), transaction: z.string(), file: z.string() })).optional(),
});

// One armed track, as `arm` with `tracks` takes it (arming.md §2.2).
// An audio track's `monitor` names a capture input for a session's input
// window to read (live-supercollider.md §12, "live-monitor").
export type ArmTrack = { track: string; kind: 'audio'; input: number; monitor?: string } | { track: string; kind: 'midi' };

// A controller a MIDI take starts from, as `arm`'s `controllers` passes it
// (instrument-knobs.md §2.8, daemon feature "midi-chase"): the daemon
// writes each at the take's first sample, before anything sent later.
export const chasedControllerSchema = z.object({
  channel: z.number().int().min(1).max(16),
  cc: z.number().int().min(0).max(119),
  value: z.number().int().min(0).max(127),
});
export type ChasedController = z.infer<typeof chasedControllerSchema>;

// What arming a set opened: every track armed, the audio side's device
// and latency when one is audio, and the MIDI side's sources when one is
// MIDI.
export const armTracksResponseSchema = z.object({
  ok: z.literal(true),
  armed: z.array(
    z.object({
      track: z.string(),
      kind: z.enum(['audio', 'midi']),
      input: z.number().int().optional(),
      monitor: z.string().optional(),
    }),
  ),
  device: z.string().optional(),
  channels: z.number().int().optional(),
  input_latency: z.number().int().optional(),
  sources: z.array(z.string()).optional(),
  sample_rate: z.number(),
  output_latency: z.number().int(),
});

// The metronome schedule (recording.md §7): tick positions on the bed's
// timeline at `rate`, with downbeat accents. The CLI projects the tempo
// map into it; the daemon synthesizes the ticks in the callback and never
// learns what a bar is. An empty list clears.
export const clickTickSchema = z.strictObject({
  sample: z.number().int().min(0),
  accent: z.boolean(),
});
export const clickScheduleSchema = z.strictObject({
  rate: z.number().positive(),
  ticks: z.array(clickTickSchema),
});
export type ClickSchedule = z.infer<typeof clickScheduleSchema>;

// A MIDI output (sequencer.md §2.5, daemon feature "midi-out"): MIDI
// messages on the bed's timeline at `rate`, as the click's ticks are,
// which the daemon sends on time from a virtual `source` it publishes or
// to an existing `destination` port. Events are in time order, and at one
// sample note-offs come first, then controller changes and bends, then
// note-ons. `lead` sends each event that many samples early, and
// `lead_input` adds the reader margin of the input it names. `clock`
// adds MIDI clock pulses, with the transport's Start, Stop, Song Position
// Pointer, and Continue around them. A `midi_out` under a name already
// open replaces the schedule and keeps the port.
export const midiOutEventSchema = z.strictObject({
  sample: z.number().int().min(0),
  midi: z.array(z.number().int().min(0).max(255)).min(1).max(3),
});
export const midiClockSchema = z.strictObject({ pulses: z.array(z.number().int().min(0)) });
const midiOutFields = {
  name: z.string().min(1),
  rate: z.number().positive(),
  lead: z.number().int().min(0),
  lead_input: z.string().min(1).optional(),
  events: z.array(midiOutEventSchema),
  clock: midiClockSchema.optional(),
};
export const midiOutSchema = z.union([
  z.strictObject({ ...midiOutFields, source: z.string().min(1) }),
  z.strictObject({ ...midiOutFields, destination: z.string().min(1) }),
]);
export type MidiOut = z.infer<typeof midiOutSchema>;

export const midiOutResponseSchema = z.object({
  ok: z.literal(true),
  name: z.string(),
  events: z.number().int(),
  pulses: z.number().int().optional(), // with a clock
});

// An open MIDI output in status: the messages it sent, those sent more
// than a millisecond after their time, and those its queue had no room
// for. A destination on macOS also counts as `early` the messages handed
// to CoreMIDI ahead of their time.
export const outputStatusSchema = z.object({
  name: z.string(),
  source: z.string().optional(),
  destination: z.string().optional(),
  sent: z.number().int(),
  late: z.number().int(),
  early: z.number().int().optional(),
  dropped: z.number().int(),
});

// A take's manifest (capture.cpp writeManifest): the transaction's
// facts, plus the frame count once it is complete. `recordings` lists
// these, `stop` and `pause` return the one they finalized, `recover`
// returns the one it patched, and the `take` event broadcasts it.
export const takeSchema = z.object({
  id: z.string(),
  file: z.string(), // project-root-relative
  track: z.string(),
  song: z.string().optional(),
  source: z.string().optional(),
  device: z.string(),
  input: z.number().int(),
  sample_rate: z.number(),
  timeline_rate: z.number().optional(), // the bed's rate; absent for a free-running take
  channels: z.number().int(),
  bit_depth: z.number().int(),
  format: z.string(),
  input_latency: z.number().int(),
  output_latency: z.number().int(),
  started_at_samples: z.number().int().optional(),
  started_wall: z.string(),
  daemon: z.string(),
  complete: z.boolean(),
  frames: z.number().int().optional(), // present once complete
  dropped: z.number().int().optional(),
  recovered: z.boolean().optional(),
  journaled_frames: z.number().int().optional(),
});
export type Take = z.infer<typeof takeSchema>;

// A MIDI take's manifest (keyboard-instrument.md §12.4): the messages
// are in `file`, take.midi.ndjson, one midiTakeLineSchema line each.
// `frames` is the samples from the start to the stop or `until`, at
// `sample_rate`, the device's, and `events` the lines written.
export const midiTakeSchema = z.object({
  id: z.string(),
  file: z.string(), // project-root-relative
  track: z.string(),
  song: z.string().optional(),
  source: z.string().optional(),
  kind: z.literal('midi'),
  sources: z.array(z.string()), // the MIDI inputs the take listened to
  sample_rate: z.number(),
  timeline_rate: z.number().optional(), // the bed's rate; absent for a free-running take
  output_latency: z.number().int(),
  started_at_samples: z.number().int().optional(),
  started_wall: z.string(),
  daemon: z.string(),
  complete: z.boolean(),
  frames: z.number().int().optional(), // present once complete
  events: z.number().int().optional(), // present once complete
  dropped: z.number().int().optional(),
  recovered: z.boolean().optional(),
  journaled_frames: z.number().int().optional(),
  journaled_events: z.number().int().optional(),
});
export type MidiTake = z.infer<typeof midiTakeSchema>;

// One line of take.midi.ndjson: a channel message's bytes, `at` samples
// from the take's start. Lines are in `at` order.
export const midiTakeLineSchema = z.strictObject({
  at: z.number().int().min(0),
  midi: z.array(z.number().int().min(0).max(255)).min(1).max(3),
});
export type MidiTakeLine = z.infer<typeof midiTakeLineSchema>;

// Either kind of take; an audio manifest carries no `kind`, so
// `'kind' in take` tells them apart.
export const anyTakeSchema = z.union([midiTakeSchema, takeSchema]);
export type AnyTake = z.infer<typeof anyTakeSchema>;

// One entry of the `recordings` list: the manifest as far as it got,
// with what is on disk beside it. A MIDI transaction counts its whole
// lines as `events_on_disk`, and its `frames_on_disk` is 0.
const recordingEntryFields = {
  id: z.string(),
  file: z.string(),
  complete: z.boolean(),
  active: z.boolean(), // the one still being written
  frames_on_disk: z.number().int(),
};
export const recordingEntrySchema = z.union([
  midiTakeSchema.partial().extend({
    ...recordingEntryFields,
    kind: z.literal('midi'),
    events_on_disk: z.number().int(),
  }),
  takeSchema.partial().extend(recordingEntryFields),
]);
export type RecordingEntry = z.infer<typeof recordingEntrySchema>;

export const recordingsResponseSchema = z.object({
  ok: z.literal(true),
  recordings: z.array(recordingEntrySchema),
});

export const recoverResponseSchema = z.object({
  ok: z.literal(true),
  take: anyTakeSchema,
});

// stop and pause: ok, plus the take they finalized when one was running.
export const stopResponseSchema = z.object({
  ok: z.literal(true),
  take: anyTakeSchema.optional(),
  takes: z.array(anyTakeSchema).optional(), // every armed track's ("record-tracks")
});

export const loadResponseSchema = z.object({
  ok: z.literal(true),
  samples: z.number().int(),
  sample_rate: z.number(),
  channels: z.number().int(),
});

export const transportState = z.enum(['playing', 'paused', 'stopped']);

// A live input (live-supercollider.md §2, daemon feature "live-input"):
// the ring FieldOut writes, by the number FieldOut takes, and its size.
export const inputResponseSchema = z.object({
  ok: z.literal(true),
  name: z.string(),
  ring: z.number().int().min(1),
  capacity: z.number().int().positive(),
  channels: z.literal(2),
  sample_rate: z.number(),
});

// An open input in status. A ring's: frames FieldOut wrote, the daemon
// read, and FieldOut dropped for want of room; how often the reader ran
// dry; the frames it skipped to hold its level against a fast writer. A
// capture input's (`kind: "capture"`, live-supercollider.md §12): frames
// read off the armed input. Both: the loudest sample read since a client
// last asked, which the asking resets.
export const inputStatusSchema = z.object({
  name: z.string(),
  kind: z.literal('capture').optional(),
  ring: z.number().int().optional(),
  written: z.number().int().optional(),
  read: z.number().int(),
  dropped: z.number().int().optional(),
  underruns: z.number().int().optional(),
  skipped: z.number().int().optional(),
  peak: z.number(),
});

export const statusResponseSchema = z.object({
  ok: z.literal(true),
  state: transportState,
  sample: z.number().int(),
  samples: z.number().int(),
  path: z.string().nullable(),
  null_output: z.boolean(),
  device: z.object({ name: z.string(), sample_rate: z.number() }).optional(),
  resampling: z.boolean(),
  looping: z.boolean().optional(), // daemon >= 0.3
  live: z.boolean().optional(), // a live session is loaded (daemon feature "session")
  song: z.string().optional(), // the live session's song (live only)
  solo: z.string().optional(), // the track its compile soloed, when it did (live only)
  sample_rate: z.number().optional(), // the live session's rate (live only)
  // Converted delivery's in-flight frames (live only, daemon >= 0.7):
  // the skew cross-rate-live.md decision 3 bounds, made visible.
  conv_queued: z.number().int().optional(),
  record: recordStatusSchema.optional(), // daemon feature "record"
  click_ticks: z.number().int().optional(), // ticks in the loaded schedule (daemon feature "click")
  // The live session's region loop, when one is set (daemon feature "loop-region").
  loop_from: z.number().int().optional(),
  loop_to: z.number().int().optional(),
  inputs: z.array(inputStatusSchema).optional(), // open live inputs (daemon feature "live-input")
  outputs: z.array(outputStatusSchema).optional(), // open MIDI outputs (daemon feature "midi-out")
});

export const okResponseSchema = z.object({ ok: z.literal(true) });

export const errorResponseSchema = z.object({
  ok: z.literal(false),
  error: z.string(),
});

export const eventSchema = z.discriminatedUnion('event', [
  z.object({ event: z.literal('state'), state: transportState }),
  z.object({ event: z.literal('position'), sample: z.number().int() }),
  // The output moved underneath the clients: default-follow tracked a
  // system-default change, or the held device vanished and the daemon
  // fell back (playback.md §5).
  z.object({ event: z.literal('device'), name: z.string(), sample_rate: z.number() }),
  // The input side moved: something armed, a take began, a take ended.
  z.object({ event: z.literal('record'), state: recordState }),
  // A take finalized — by the stop that ended it, a remote stop, or the
  // bed running out — with its manifest. Nested, because the manifest's
  // own `id` is the transaction's and a top-level `id` marks a response.
  z.object({ event: z.literal('take'), take: anyTakeSchema }),
]);
export type AudiodEvent = z.infer<typeof eventSchema>;
