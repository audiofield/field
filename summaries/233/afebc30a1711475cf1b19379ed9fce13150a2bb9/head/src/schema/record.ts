import { z } from 'zod';
import type { KeyOrder } from '../yaml/emit.js';
import { labelName } from './common.js';

// The recorded half of a track (recording.md §3–§4): a `record:` entry
// asks for a performance, and the takes beside the audio under the
// record node's name — `audio/<name>/takes.yaml` — say which
// performances exist and which one the entry plays.
//
// The entry's payload stays empty until a field earns its place (§4):
// device and input are local state, so they ride `field record` flags and
// the take row, never the committed recipe. Bare `- record:` is the
// spelling — YAML's null preprocesses to the empty table, the way a bare
// send label already does (track.ts sendSchema; §11 resolved 2026-09-06).
//
// The kind of take is the track's `instrument` to decide (sequencer.md
// §3.4): MIDI with one, audio without. `instrument:` here is refused by
// name, because an unrecognized key would not say where it goes.
export const recordEntrySchema = z.preprocess((v, ctx) => {
  const entry = v ?? {};
  if (typeof entry !== 'object' || !('instrument' in entry)) return entry;
  const { instrument, ...rest } = entry as Record<string, unknown>;
  ctx.addIssue({
    code: 'custom',
    message:
      `the instrument is the track's: move \`instrument: ${String(instrument)}\` up beside the ` +
      "track's `name:`, and leave `- record:` bare (sequencer.md §3.4)",
  });
  return rest;
}, z.strictObject({}));
export type RecordEntry = z.infer<typeof recordEntrySchema>;

// Take names are timestamps (§3): sortable, and two clones recording
// independently cannot mint the same one. The daemon mints them
// (capture.cpp); the schema pins the shape so a hand-written row that
// names something else is refused where it is written.
export const takeName = z
  .string()
  .regex(/^take-\d{8}-\d{6}(-\d+)?$/, 'a take is named take-YYYYMMDD-HHMMSS');

// One recorded take. The bytes pin in the song's ledger, under `asset`
// (project-layout.md §1.6: recorded audio pins where imported audio
// does), so this row carries the record and never a hash.
//
// `started_at_samples` is where the take's first sample sits on the
// recording track's timeline, counted from the record entry's own `at`
// (zero for a bare entry), at the track's rate; `latency` is how many
// of those samples the capture ran behind — the round trip the device
// declared, input plus output, in the track's samples. The take sounds
// at the entry's window start plus `started_at_samples - latency` and
// nothing else (§3's authority rule): `musical_position` records what
// the song's map said at capture and is never arithmetic. A take that
// started before the window has a negative `started_at_samples`; the
// placement reads into the take by that much.
const musicalPosition = z.array(z.number().int().min(1)).min(1).max(3).optional();

export const audioTakeRowSchema = z.strictObject({
  asset: takeName,
  started_at_samples: z.number().int(),
  musical_position: musicalPosition,
  latency: z.number().int().min(0),
  device: z.string().min(1),
  input: z.number().int().min(1),
  // The monitoring context the take was heard under (audio-engine.md
  // "Monitoring"): how a dry take was monitored, and the Console preset
  // it expects, so a clone can tell.
  monitoring: z.string().min(1).optional(),
  console_preset: z.string().min(1).optional(),
  recorded_at: z.iso.datetime({ offset: true }),
});

// A MIDI take (keyboard-instrument.md §12.2): its bytes are a notes file,
// and it carries the MIDI sources the daemon listened to in place of an
// audio take's device and input. `latency` is the output latency alone,
// because a player presses a key in time with what they hear, and MIDI
// has no input latency worth the name. A take in ticks (sequencer.md
// §2.4) has the latency taken off its notes already, and plays from
// `started_at_ticks`, where it starts in ticks counted from the whole
// tick its record entry's window starts on. The two are authoritative,
// so the take moves with its entry by the same musical distance and
// follows a tempo edit. `started_at_samples`, `latency`, and
// `musical_position`, where it started on its track in the track's own
// time, are its record. A take whose notes file carries `sample_rate:`
// places by sample arithmetic, as an audio take does, and has no
// `started_at_ticks`.
export const midiTakeRowSchema = z.strictObject({
  asset: takeName,
  started_at_samples: z.number().int(),
  started_at_ticks: z.number().int().optional(),
  musical_position: musicalPosition,
  latency: z.number().int().min(0),
  sources: z.array(z.string().min(1)),
  recorded_at: z.iso.datetime({ offset: true }),
});

export const recordedTakeSchema = z.union([audioTakeRowSchema, midiTakeRowSchema]);
export type RecordedTake = z.infer<typeof recordedTakeSchema>;
export type MidiTakeRow = z.infer<typeof midiTakeRowSchema>;

export function isMidiTakeRow(take: RecordedTake): take is MidiTakeRow {
  return 'sources' in take;
}

// `audio/<name>/takes.yaml` — beside the WAVs it describes, for the same
// reason variants.yaml sits beside its takes (generative.ts): one
// gitignore rule governs the bytes and their record. `takes.yaml` rather
// than a second `variants.yaml` (§11, resolved 2026-09-06): the two files
// pin in different places, and one name would claim a shared shape the
// loader would then have to tell apart by content.
export const recordTakesSchema = z.strictObject({
  // What these takes attach to: the record node — the owning track's
  // name, or <track>-<id> when the entry carries an id — checked against
  // the directory for the same reason a gen's `gen:` key is.
  record: labelName,
  chosen: takeName.optional(),
  takes: z.array(recordedTakeSchema).default([]),
});
export type RecordTakes = z.infer<typeof recordTakesSchema>;
export const recordTakesOrder: KeyOrder = {
  keys: ['record', 'chosen', 'takes'],
  children: {
    takes: {
      items: {
        keys: [
          'asset',
          'started_at_samples',
          'started_at_ticks',
          'musical_position',
          'latency',
          'device',
          'input',
          'sources',
          'monitoring',
          'console_preset',
          'recorded_at',
        ],
        children: { musical_position: { flow: true }, sources: { flow: true } },
      },
    },
  },
};
export const RECORD_TAKES_FILENAME = 'takes.yaml';
