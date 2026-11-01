import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KnobsError, loadKnobs, parseKnobs } from '../../keys/knobs.js';
import { KnobFiles, loadKnobSources } from './knob-files.js';

const shelf = join(import.meta.dirname, '..', '..', '..', 'examples', 'bloom', 'shared', 'instruments');
const juno = loadKnobs(join(shelf, 'juno.knobs.yaml'));

describe('knob files in a session', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'field-keys-knobs-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads a voice’s knob file beside its program, and each named file', () => {
    writeFileSync(join(dir, 'juno.scd'), '');
    writeFileSync(join(dir, 'juno.knobs.yaml'), readFileSync(join(shelf, 'juno.knobs.yaml')));
    writeFileSync(join(dir, 'pad.scd'), '');
    writeFileSync(join(dir, 'ju-06a.yaml'), 'knobs:\n  - { name: cutoff, cc: 74 }\n');
    const sources = loadKnobSources(
      [{ program: join(dir, 'juno.scd'), track: 'creek/keys' }, { program: join(dir, 'pad.scd') }],
      [join(dir, 'ju-06a.yaml')],
      undefined,
    );
    expect(sources.map(({ name, program }) => ({ name, program }))).toEqual([
      { name: 'keys', program: join(dir, 'juno.scd') },
      { name: 'ju-06a', program: undefined },
    ]);
    expect(sources[0]!.knobs).toEqual(juno);
    expect(() => loadKnobSources([], [join(dir, 'missing.yaml')], undefined)).toThrow(/no such file/);
    writeFileSync(join(dir, 'juno.knobs.yaml'), 'knobs:\n  - { name: cutoff, cc: 1 }\n');
    expect(() => loadKnobSources([{ program: join(dir, 'juno.scd') }], [], undefined)).toThrow(KnobsError);
  });

  it('keeps the voice’s copy after a save that fails and asks for no reload, and rewrites it before one that passes', () => {
    const path = join(dir, 'juno.knobs.yaml');
    const files = new KnobFiles([
      { name: 'juno', path, program: '/p/juno.scd', knobs: juno },
      { name: 'ju-06a', path: join(dir, 'ju-06a.yaml'), knobs: juno.slice(0, 1) },
    ]);
    try {
      const copy = files.copies.get('/p/juno.scd')!;
      expect(parseKnobs(readFileSync(copy, 'utf8'), copy)).toEqual(juno);
      expect([...files.copies.keys()]).toEqual(['/p/juno.scd']);

      let failed: KnobsError | undefined;
      try {
        parseKnobs('knobs:\n  - { name: res, cc: 1 }\n', path);
      } catch (err) {
        failed = err as KnobsError;
      }
      expect(files.saved(path, { error: failed! })).toBe(false);
      expect(files.errors.get(path)).toBe('juno.knobs.yaml: knobs.0.cc: res: cc 1 is the modulation wheel, which is the knob mod');
      expect(parseKnobs(readFileSync(copy, 'utf8'), copy)).toEqual(juno);
      expect(files.list().map((k) => k.label)).toContain('juno.release');

      expect(files.saved(path, { knobs: juno.slice(0, 2) })).toBe(true);
      expect(files.errors.size).toBe(0);
      expect(parseKnobs(readFileSync(copy, 'utf8'), copy)).toEqual(juno.slice(0, 2));
      expect(files.list().map((k) => k.label)).toEqual(['mod', 'juno.cutoff', 'juno.res', 'ju-06a.cutoff']);

      // A --knobs file reaches no voice, so its save reloads none.
      expect(files.saved(join(dir, 'ju-06a.yaml'), { knobs: juno.slice(1, 2) })).toBe(false);
      expect(files.list().map((k) => k.label)).toEqual(['mod', 'juno.cutoff', 'juno.res', 'ju-06a.res']);
    } finally {
      files.remove();
    }
    expect(existsSync(files.copies.get('/p/juno.scd')!)).toBe(false);
  });
});
