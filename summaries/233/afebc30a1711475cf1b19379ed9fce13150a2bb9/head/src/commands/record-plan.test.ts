import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { controllersToChase, PUBLISHED_PATH, publishControllers, unpublishControllers } from '../keys/published.js';
import { loadProject } from '../model/project.js';
import { createSong, createTrack } from './create.js';
import { init } from './init.js';
import { planArm } from './record.js';

// What `field record` arms before it opens anything (arming.md §2.2): each
// track's kind by its record entry, an input per audio track in the order
// named, and the refusals that belong before a performance.

let root: string;

function writeTrack(song: string, name: string, lines: string[]): void {
  writeFileSync(join(root, 'songs', song, 'tracks', `${name}.yaml`), [`name: ${name}`, ...lines, ''].join('\n'));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'field-record-plan-'));
  init({ dir: root, name: 'plan' });
  createSong(root, 'creek');
  createSong(root, 'tall-grass');
  writeFileSync(join(root, 'shared/instruments/juno.scd'), '// FIELD_MODE\n');
  for (const name of ['vox', 'vox2', 'keys']) createTrack(root, 'creek', name);
  createTrack(root, 'tall-grass', 'gtr');
  writeTrack('creek', 'vox', ['inputs:', '  - record:']);
  writeTrack('creek', 'vox2', ['inputs:', '  - record:']);
  writeTrack('creek', 'keys', ['instrument: juno', 'inputs:', '  - record:']);
  writeTrack('tall-grass', 'gtr', ['inputs:', '  - record:']);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const plan = (targets: string[], options = {}) =>
  planArm(root, loadProject(root), targets, options).map((t) => [t.node.trackName, t.kind, t.input]);

describe('planning an armed set', () => {
  it('gives audio tracks inputs 1, 2, and on in the order named, and MIDI none', () => {
    expect(plan(['creek/track:vox2', 'creek/track:keys', 'creek/track:vox'])).toEqual([
      ['vox2', 'audio', 1],
      ['keys', 'midi', undefined],
      ['vox', 'audio', 2],
    ]);
  });

  it('takes one --input per audio track, in order', () => {
    expect(plan(['creek/track:vox', 'creek/track:keys', 'creek/track:vox2'], { input: [4, 2] })).toEqual([
      ['vox', 'audio', 4],
      ['keys', 'midi', undefined],
      ['vox2', 'audio', 2],
    ]);
    expect(plan(['creek/track:vox'], { input: 3 })).toEqual([['vox', 'audio', 3]]);
    expect(() => plan(['creek/track:vox', 'creek/track:vox2'], { input: [3] })).toThrow(
      '--input names 1 input for 2 audio tracks; give one per audio track, in the order you name them',
    );
  });

  it('refuses what cannot be armed, before anything opens', () => {
    expect(() => plan(['creek/track:keys'], { input: [2] })).toThrow(
      'keys records MIDI for juno: --input, --device, and --loop are for audio takes',
    );
    expect(() => plan(['creek/track:vox', 'creek/track:vox2'], { loop: true })).toThrow('a loop take records one track');
    expect(() => plan(['creek/track:vox', 'creek/track:vox'])).toThrow('//songs/creek/track:vox is named twice');
    expect(() => plan(['creek/track:vox', 'tall-grass/track:gtr'])).toThrow(
      'armed tracks record against one song, and these are in creek and tall-grass',
    );
  });
});

describe('the controllers a MIDI take starts from (instrument-knobs.md §2.8)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'field-chase-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const knobs = [
    { channel: 1, cc: 1, value: 64 },
    { channel: 1, cc: 74, value: 30 },
  ];

  it('reads what a running field keys published, only for a daemon that chases', () => {
    expect(controllersToChase(dir, true)).toEqual([]);
    publishControllers(dir, knobs);
    expect(controllersToChase(dir, true)).toEqual(knobs);
    expect(controllersToChase(dir, false)).toEqual([]);
  });

  it('ignores what a field keys that has exited published', () => {
    // A pid no process has: one below the largest a 32-bit pid_t holds.
    publishControllers(dir, knobs, 2147483646);
    expect(controllersToChase(dir, true)).toEqual([]);
  });

  it('ignores a file it cannot read, and leaves another field keys\' file when it quits', () => {
    mkdirSync(join(dir, '.field'));
    writeFileSync(join(dir, PUBLISHED_PATH), '{"pid":');
    expect(controllersToChase(dir, true)).toEqual([]);
    publishControllers(dir, knobs, process.ppid);
    unpublishControllers(dir);
    expect(existsSync(join(dir, PUBLISHED_PATH))).toBe(true);
    publishControllers(dir, knobs);
    unpublishControllers(dir);
    expect(existsSync(join(dir, PUBLISHED_PATH))).toBe(false);
  });

  it('says why it could not publish, rather than throwing out of field keys', () => {
    writeFileSync(join(dir, '.field'), '');
    expect(publishControllers(dir, knobs)).toMatch(/^\.field[/\\]keys\.json not written, so a take starts without these knobs: /);
    rmSync(join(dir, '.field'));
    expect(publishControllers(dir, knobs)).toBeUndefined();
    expect(controllersToChase(dir, true)).toEqual(knobs);
  });
});
