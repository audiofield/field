import { z } from 'zod';
import type { KeyOrder } from '../yaml/emit.js';
import { labelName, sampleRate, samples, slug, sourceRef, timePosition, timeSpan } from './common.js';
import { insertOrder, insertSchema } from './effects.js';
import { meterEventSchema, tempoEventSchema, timeOrder } from './song.js';
import { generativeEntrySchema } from './generative.js';
import { recordEntrySchema } from './record.js';

// One list (nested-tracks.md §18): a track file is a name, an optional
// `time:`, optional `inserts:`, and `inputs:`. Every entry places one
// thing on the track's timeline, and the thing is named by the entry's
// field — the kind lives in the field name, never in a value prefix:
//
//   - `track:` — another track's render
//   - `audio:` — committed bytes: the song's ledger, or the one
//     cross-scope spelling, `//shared/asset:<name>`
//
// Generator entries are §18's third kind: authored spec inline, the
// render minted as its own node under `gen:` (option A — uniformly,
// whether the entry is a leaf's sole content or windowed among
// siblings). `supercollider:` renders in-graph; `generative:` is
// deliberate — its takes live beside the audio under the gen node's
// name, and nothing in the build may run it (project-layout.md §1.2).
// `record:` is the generative pattern with a human where the model was
// (recording.md §1): its takes live beside the audio under the record
// node's name, `field record` fills them, and an entry with none yet
// builds as silence rather than refusing (§4). `notes:` places a part,
// a notes file under songs/<song>/notes/, and renders it through the
// track's `instrument` as a gen node, as a MIDI take renders
// (sequencer.md §2.3).
//
// Placement fields are uniform across kinds, because none of them means
// something different depending on what produced the audio. A window is
// (at, duration) in anchor units; the content offsets are samples, with
// effective read offset = source_offset − slip (project-core.md §3.2).
// Looping (clip-looping.md §1): the window is authoritative and the
// source tiles to fill it. `id` is how automation attaches to a
// placement (§18 decision 3); optional until something needs to attach.
export const clipLoopSchema = z.strictObject({
  enabled: z.boolean().default(true), // switch a loop off without deleting it
  every: timeSpan.optional(), // anchor units, or a musical span on musical entries
  mode: z.enum(['truncate', 'overlay']).default('truncate'),
  fade: samples.default(480), // ≈10 ms at 48 k; the naive loop must not click
});
// File types (z.infer) admit musical arrays; the exported types are the
// post-load shape — loadProject resolves every array to a tick scalar
// before anything else sees the data (musical-time.md §1.6).
type ClipLoopFile = z.infer<typeof clipLoopSchema>;
export type ClipLoop = Omit<ClipLoopFile, 'every'> & { every?: number | undefined };

// The authored half of a SuperCollider render, inline: name and type
// are supplied by where the entry sits and what field it is.
export const supercolliderEntrySchema = z.strictObject({
  source: z.string().min(1), // the program; bare names resolve in shared/instruments/
  seed: z.number().int().min(0),
  duration: z.number().positive().max(3600), // seconds
  channels: z.union([z.literal(1), z.literal(2)]).default(2),
});
export type SupercolliderEntry = z.infer<typeof supercolliderEntrySchema>;

// A receive carries nothing but its label (nested-tracks.md §19,
// decision 9): the position-domain entries place content, this one
// admits signal, and a cable has no spelling for an offset — which is
// what keeps offline sends as causal as the engine will play them. The
// guard runs on the raw keys because it must tell an authored `at: 0`
// from the default the schema would otherwise hand every entry.
const RECEIVE_ONLY =
  'a receive admits signal, not a placement — it carries only its label ' +
  '(nested-tracks.md §19)';
const receiveGuard = (raw: unknown, ctx: z.RefinementCtx): unknown => {
  if (raw !== null && typeof raw === 'object' && 'receive' in raw) {
    const extra = Object.keys(raw).filter((k) => k !== 'receive');
    if (extra.length > 0) {
      ctx.addIssue({ code: 'custom', message: `${RECEIVE_ONLY} — remove ${extra.join(', ')}` });
    }
  }
  return raw;
};

const inputEntryFields = z
  .strictObject({
    id: slug.optional(),
    // Exactly one of these names what the entry plays; the superRefine
    // below is the arity check.
    track: slug.optional(), // a track in this song
    audio: sourceRef.optional(), // ledger name, or //shared/asset:<name>
    supercollider: supercolliderEntrySchema.optional(), // an inline render
    generative: generativeEntrySchema.optional(), // a deliberate request
    record: recordEntrySchema.optional(), // a performance to record (recording.md §4)
    notes: slug.optional(), // a part: songs/<song>/notes/<name>.yaml (sequencer.md §2.3)
    receive: labelName.optional(), // a cable's label (nested-tracks.md §19)
    anchor: z.enum(['musical', 'absolute']).default('musical'),
    // Omitted means the track's start — the leaf case reads as bare
    // content (`- supercollider: {...}` with nothing else), and tick 0
    // and sample 0 are the same instant, so the default is anchor-safe.
    at: timePosition.default(0), // ticks when musical, samples when absolute
    // Omitted means the whole source — the placement declining to
    // truncate (nested-tracks.md §1.6). A looping entry still declares
    // one: the window is authoritative and the source tiles to fill it,
    // so "as long as the source" and "tile to fill the window" are
    // contrary instructions rather than a default.
    duration: timeSpan.optional(), // same units as at
    loop: clipLoopSchema.optional(),
    source_offset: samples.default(0),
    slip: z.number().int().default(0),
    gain_db: z.number().default(0),
    // Balance, -1 left … 1 right, applied by this track while summing
    // (nested-tracks.md §1.13); a hard pan silences one channel.
    pan: z.number().min(-1).max(1).default(0),
    // Silence this placement without deleting it or touching its level —
    // the loop entry's `enabled:` shape applied to a whole placement.
    // A field rather than a gain gesture because a gesture would
    // overwrite the authored `gain_db`, and remembering the old value
    // anywhere but the file is a second store (ui.md §3). On the
    // placement, not the track, for the same reason levels are: a track
    // placed twice can be muted in one home and audible in the other.
    mute: z.boolean().default(false),
    fade_in: samples.default(0),
    fade_out: samples.default(0),
  })
  .superRefine((entry, ctx) => {
    const kinds = [
      entry.track,
      entry.audio,
      entry.supercollider,
      entry.generative,
      entry.record,
      entry.notes,
      entry.receive,
    ].filter((v) => v !== undefined);
    if (kinds.length !== 1) {
      ctx.addIssue({
        code: 'custom',
        message:
          'an entry plays exactly one thing — name it with track:, audio:, ' +
          'supercollider:, generative:, record:, notes:, or receive:',
      });
    }
    // A take is placed where it was sung (recording.md §3); tiling it
    // would be a placement the row cannot describe, and the entry's
    // window is the takes' to fill.
    if (entry.record !== undefined && entry.loop !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['loop'],
        message: 'a record entry does not loop — a take is placed where it was sung',
      });
    }
  });
export const inputEntrySchema = z.preprocess(receiveGuard, inputEntryFields);
type InputEntryFile = z.infer<typeof inputEntrySchema>;
export type InputEntry = Omit<InputEntryFile, 'at' | 'duration' | 'loop'> & {
  at: number;
  duration?: number | undefined;
  loop?: ClipLoop | undefined;
};
export const inputEntryOrder: KeyOrder = {
  keys: [
    'id',
    'track',
    'audio',
    'supercollider',
    'generative',
    'record',
    'notes',
    'receive',
    'anchor',
    'at',
    'duration',
    'loop',
    'source_offset',
    'slip',
    'gain_db',
    'pan',
    'mute',
    'fade_in',
    'fade_out',
  ],
  children: {
    supercollider: { keys: ['source', 'seed', 'duration', 'channels'] },
    generative: {
      keys: [
        'prompt',
        'text',
        'voice_ref',
        'voice_ref_sha256',
        'exaggeration',
        'conviction',
        'lyrics',
        'bpm',
        'duration_seconds',
        'bars',
      ],
    },
    at: { flow: true },
    duration: { flow: true },
    loop: { keys: ['enabled', 'every', 'mode', 'fade'], children: { every: { flow: true } } },
  },
};

// One end of a cable (nested-tracks.md §19): a send is declared on the
// sending track, keyed by the label that links it to exactly one
// `- receive: <label>` entry somewhere in the song. The edge carries a
// level and never an offset (§1.8), plus where it taps the sender's
// signal — after its inserts by default, `pre` for feeding a shared
// effect the unprocessed signal. A unity post-insert send is the bare
// label: `sends:\n  chorus-reverb:` — the preprocess turns YAML's null
// into the defaults.
export const sendSchema = z.preprocess(
  (v) => v ?? {},
  z.strictObject({
    gain_db: z.number().default(0),
    tap: z.enum(['pre', 'post']).default('post'),
  }),
);
export type Send = z.infer<typeof sendSchema>;

// A track's own tempo and meter (nested-tracks.md §1.5). A 7/8 figure
// inside a 4/4 song is a track with a local meter rather than a feature,
// which is what subsumes project-core.md §3.1's loops-with-their-own-
// timeline deferral.
//
// Each half is independently optional and falls back to the song's. The
// polymetric case usually wants a different meter at the *same* tempo, so
// requiring both would copy the song's bpm into a file that cannot be
// told when the song's changes — a second copy of one fact, which is the
// drift `arrangement.yaml` retired for (§11).
//
// Inheritance is from the song, never from the parent that places this
// track: a track may have two parents (§1.3) and renders exactly once, so
// its musical time has to mean one thing no matter who consumes it
// (§13).
export const trackTimeSchema = z
  .strictObject({
    tempo: z.array(tempoEventSchema).min(1).optional(),
    meter: z.array(meterEventSchema).min(1).optional(),
  })
  .refine((time) => time.tempo !== undefined || time.meter !== undefined, {
    error:
      'declare a `tempo`, a `meter`, or both — an empty `time:` inherits ' +
      'everything, which is what omitting it already does (nested-tracks.md §1.5)',
  });
export type TrackTime = z.infer<typeof trackTimeSchema>;

// songs/<song>/tracks/<name>.yaml — name must match the filename; the slug
// is the identity (project-core.md §6).
//
// No `gain_db` or `pan` here. A level lives on the placement that consumes
// this track (nested-tracks.md §1.13), where it can differ per parent —
// which a field on the track cannot do.

export const trackSchema = z.strictObject({
  name: labelName,
  // The program the track's notes play through (sequencer.md §3.4): its
  // parts, its MIDI takes, and `field keys` on the track. It decides the
  // kind of take `record:` records, MIDI with one and audio without. It
  // resolves as `field keys` resolves an instrument.
  instrument: z.string().min(1).optional(),
  // The rate this track renders at (multi-rate.md decision 3). Omitted
  // means the project's — the same inheritance shape as `time:`, and from
  // the song for the same reason: a track may have two parents and
  // renders exactly once, so its rate has to mean one thing no matter who
  // consumes it. Where a parent's rate differs, the edge converts
  // (decision 4); nothing here needs to know who is listening.
  rate: sampleRate.optional(),
  // Omitted means the song's maps, which is every track today.
  time: trackTimeSchema.optional(),
  // Inserts are content, not mix parameters: they bake into the stem, so
  // an insert edit re-renders it — the accepted cost model (effects.md §5).
  inserts: z.array(insertSchema).default([]),
  // A map, not a list (nested-tracks.md §19 decision 1): sends are an
  // unordered set keyed by a unique label, YAML itself enforces per-track
  // label uniqueness, and a level tweak diffs under a stable key.
  sends: z.record(labelName, sendSchema).default({}),
  inputs: z.array(inputEntrySchema).default([]),
});
type TrackFile = z.infer<typeof trackSchema>;
export type Track = Omit<TrackFile, 'inputs'> & {
  inputs: InputEntry[];
};
export const trackOrder: KeyOrder = {
  keys: ['name', 'instrument', 'rate', 'time', 'inserts', 'sends', 'inputs'],
  children: {
    // The labels are the author's; only the values have known keys.
    sends: { entries: { keys: ['gain_db', 'tap'] } },
    // The song's `time:` order, so a local map reads like the song map
    // it overrides rather than like a different kind of thing.
    time: timeOrder,
    inserts: { items: insertOrder },
    inputs: { items: inputEntryOrder },
  },
};
