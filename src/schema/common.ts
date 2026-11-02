import { z } from 'zod';
import { SLUG_PATTERN } from '../ids.js';
import { RESERVED_LABEL_NAME, sharedAssetName } from '../labels.js';

// Shared building blocks for the per-file schemas (index.ts is the
// barrel). Zod schemas are the single source of truth for the canonical
// project format (project-core.md §1); JSON Schema is generated from them
// to keep the format language-neutral (§5).

export const slug = z.string().regex(SLUG_PATTERN, 'must be a lowercase-slug');

// For anything addressable as //pkg:name — assets, targets, tracks — the
// grammar's reserved word is not a legal name.
export const labelName = slug.refine((n) => n !== RESERVED_LABEL_NAME, {
  message: `"${RESERVED_LABEL_NAME}" is reserved by the label grammar`,
});

// A source reference (project-layout.md §4.3): a bare slug resolves in
// the song's one namespace (assets and sounds together — names are
// identity, project-core.md §6), and the full //shared/asset:<name>
// label crosses into the shared scope — the only cross-scope reference
// there is (§1.5: where a file lives declares who may see it, and a
// song sees exactly itself plus shared/). Existence checks live in the
// model layer; the schema admits exactly the two spellings.
export const sourceRef = z.string().superRefine((ref, ctx) => {
  if (SLUG_PATTERN.test(sharedAssetName(ref) ?? ref)) return;
  // The old plural spelling sitting in a project file is the flag-day
  // case, and the one a person actually hits — the pattern hint in
  // graph.ts only catches a mistyped *command*. Name the substitution
  // rather than the grammar (#41 review).
  const stale = /^\/\/shared\/assets:(.+)$/.exec(ref);
  ctx.addIssue({
    code: 'custom',
    message:
      stale !== null
        ? `packages are singular: //shared/assets: is now //shared/asset: (try //shared/asset:${stale[1]!})`
        : 'must be a name in the song or //shared/asset:<name>',
  });
});

export const ticks = z.number().int().min(0);
export const samples = z.number().int().min(0);

// Musical time arrays (musical-time.md §1): scalar numbers are ticks
// (samples on absolute clips); arrays are musical. Positions are ordinal
// and 1-indexed — [9, 2] is bar 9, beat 2 — and spans are cardinal counts
// where zero is legal — [0, 2] is two beats. The schema validates shape
// only: legal beat and tick ranges depend on the meter map (the song's
// time:),
// so resolution and range diagnostics live in the model layer
// (model/project.ts), which rewrites arrays to tick scalars at load — the
// build graph never sees an array, and either spelling of a time produces
// the same action key.
const musicalPosition = z.array(z.number().int().min(1)).min(1).max(3);
const musicalSpan = z.array(z.number().int().min(0)).min(1).max(3);
export const timePosition = z.union([ticks, musicalPosition]);
export const timeSpan = z.union([z.number().int().positive(), musicalSpan]);
// A span that may be empty, as a note's can: a drum pad's on and off can
// land in one tick.
export const timeLength = z.union([ticks, musicalSpan]);

// The error names the set because the refusal is the documentation: a
// raw "Invalid input" does not say what a rate may be, and `rate:` on a
// track is now the field a person types to opt into any of the
// multi-rate machinery (#112 review).
export const sampleRate = z.union(
  [
    z.literal(44100),
    z.literal(48000),
    z.literal(88200),
    z.literal(96000),
    z.literal(176400),
    z.literal(192000),
  ],
  { error: 'must be one of 44100, 48000, 88200, 96000, 176400, 192000' },
);

// The depths delivery can quantize to (`field export --bit-depth`, and
// the daemon's normalize op behind it). It lived on the normalize sound
// until that type retired with multi-rate.md step 3; the wire format and
// the generated plan limits still read it from here.
export const bitDepth = z.union([z.literal(16), z.literal(24), z.literal(32)]);
