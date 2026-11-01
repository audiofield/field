import { randomInt } from 'node:crypto';
import { InvalidArgumentError } from 'commander';

// Option parsers mirroring the sc-render schema: on the command whose
// premise is seeded reproducibility, `--seed abc` must be an error, never a
// silent seed 0.

export function parseSeed(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new InvalidArgumentError('seed must be a non-negative integer');
  }
  return n;
}

export function parseDurationSeconds(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 3600) {
    throw new InvalidArgumentError('duration must be seconds in (0, 3600]');
  }
  return n;
}

export function parseBeats(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new InvalidArgumentError('beats must be a positive number of quarter notes');
  }
  return n;
}

export function parseBars(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new InvalidArgumentError('bars must be a positive integer');
  }
  return n;
}

// Export's delivery formatting (multi-rate.md decision 1), bounded by the
// same sets the normalize schema accepts — the flags drive the identical
// daemon op, so they may not promise a value it would refuse.
const EXPORT_RATES = [44100, 48000, 88200, 96000, 176400, 192000];

export function parseExportRate(value: string): number {
  const n = Number(value);
  if (!EXPORT_RATES.includes(n)) {
    throw new InvalidArgumentError(`rate must be one of ${EXPORT_RATES.join(', ')}`);
  }
  return n;
}

export function parseExportBitDepth(value: string): 16 | 24 | 32 {
  const n = Number(value);
  if (n !== 16 && n !== 24 && n !== 32) {
    throw new InvalidArgumentError('bit depth must be 16, 24, or 32');
  }
  return n;
}

// Whether this invocation is asking for the version, by position.
// `argv.includes('--version')` matched the flag anywhere, so
// `field build --version` printed a version report and silently never
// built — substituting a different command where a parser would have
// complained (#70 review). argv[2] is the only position where this flag
// means the whole program; every other shape belongs to commander.
export function wantsVersion(argv: string[]): boolean {
  return argv[2] === '--version' || argv[2] === '-V';
}

export function parseVariants(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 8) {
    throw new InvalidArgumentError('variants must be an integer in [1, 8]');
  }
  return n;
}

// The two voice knobs. Fractional on purpose — unlike bpm and variants,
// these are continuous, and the useful moves are small ones (0.5 to 0.3
// slowed creek's line by a fifth). Bounds match the recipe schema's, so
// a value that would be rejected on the way to disk is rejected here,
// before the model runs.
export function parseExaggeration(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0.25 || n > 2) {
    throw new InvalidArgumentError('exaggeration must be a number in [0.25, 2]');
  }
  return n;
}

export function parseConviction(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0.1 || n > 1) {
    throw new InvalidArgumentError('conviction must be a number in [0.1, 1]');
  }
  return n;
}

export function parseBpm(value: string): number {
  const n = Number(value);
  // Integer, not merely in range: the recipe schema records integer bpm,
  // and a fractional value must fail here — not after the WAVs land.
  if (!Number.isInteger(n) || n < 30 || n > 300) {
    throw new InvalidArgumentError('bpm must be an integer in [30, 300]');
  }
  return n;
}

export function parseVariantNumber(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new InvalidArgumentError('variant must be a positive integer (1-based)');
  }
  return n;
}

export function parseChannels(value: string): 1 | 2 {
  const n = Number(value);
  if (n !== 1 && n !== 2) {
    throw new InvalidArgumentError('channels must be 1 or 2');
  }
  return n;
}

// choose and generate address a generative request by its gen node
// name, and the song rides in the argument the way every command spells
// labels: `creek/still-water-keys`, `creek/gen:still-water-keys`, or
// the full `//songs/creek/gen:…` that explain prints. There is no
// --song beside it: two ways to say one thing is a search path over
// flags — project-core.md §3.4's rule, applied to the CLI's own
// grammar — so the flag refuses with the move instead (cli.ts).
export function parseGenTarget(arg: string, verb: string): { song: string; name: string } {
  let rest = arg;
  if (rest.startsWith('//')) {
    if (!rest.startsWith('//songs/')) {
      throw new InvalidArgumentError(`only //songs/ labels name generative requests (got "${arg}")`);
    }
    rest = rest.slice('//songs/'.length);
  }
  const slash = rest.indexOf('/');
  if (slash < 0) {
    throw new InvalidArgumentError(
      `give the song in the name — field ${verb} <song>/${rest.replace(/^gen:/, '')}`,
    );
  }
  const song = rest.slice(0, slash);
  let name = rest.slice(slash + 1);
  const colon = name.indexOf(':');
  if (colon >= 0) {
    const pkg = name.slice(0, colon);
    const bare = name.slice(colon + 1);
    if (pkg !== 'gen') {
      throw new InvalidArgumentError(
        `${verb} addresses a gen node — spell it ${song}/${bare} or ${song}/gen:${bare}, not ${pkg}:`,
      );
    }
    name = bare;
  }
  return { song, name };
}

// A seed is provenance, not reproducibility (bloom-in-tree.md §3): every
// take records the one it ran with, so an omitted --seed draws one. The
// bound keeps seed+i for the variant cap comfortably inside any integer
// range a worker might impose.
export function drawSeed(): number {
  return randomInt(0, 2 ** 31);
}

// The seeds line after a generate: one seed prints itself, a contiguous
// run prints as a range, and anything else lists its members. The worker
// protocol only promises an integer array — today's adapters return
// seed+i, but the display must not assert contiguity the schema does not
// (a8920be review).
export function formatSeeds(seeds: number[]): string {
  if (seeds.length === 1) return `seed ${seeds[0]}`;
  const contiguous = seeds.every((s, i) => i === 0 || s === seeds[i - 1]! + 1);
  return contiguous
    ? `seeds ${seeds[0]}–${seeds[seeds.length - 1]}`
    : `seeds ${seeds.join(', ')}`;
}

// `field record --input`: a channel as it is printed on the interface,
// counting from 1. The daemon speaks the same number (recording.md §6).
export function parseInputChannel(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new InvalidArgumentError('input must be a positive integer (channels count from 1)');
  }
  return n;
}

// `field record --input 1,2`: an input per armed audio track, in the order
// the tracks are named (arming.md §2.2).
export function parseInputChannels(value: string): number[] {
  return value.split(',').map((part) => parseInputChannel(part.trim()));
}

// `field record --count-in`: whole bars, because that is what a musician
// counts (recording.md §7).
export function parseCountIn(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new InvalidArgumentError('count-in must be a positive whole number of bars');
  }
  return n;
}
