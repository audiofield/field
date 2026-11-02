import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSong, createTrack } from '../commands/create.js';
import { init } from '../commands/init.js';
import { resolveKeysTargets } from './targets.js';

// What `field keys` arms from its targets (arming.md §2.1): a program by
// name, a track with an instrument, or the one such track under a bus,
// refusing a bus with several so you name the ones you mean.

let root: string;

const VOICE = '(\nif ("FIELD_MODE".getenv == "voice") { SynthDef(\\v, {}) } { 0.exit }\n)\n';

function writeTrack(name: string, lines: string[]): void {
  writeFileSync(join(root, 'songs/creek/tracks', `${name}.yaml`), [`name: ${name}`, ...lines, ''].join('\n'));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'field-keys-targets-'));
  init({ dir: root, name: 'targets' });
  createSong(root, 'creek');
  writeFileSync(join(root, 'shared/instruments/juno.scd'), VOICE);
  writeFileSync(join(root, 'shared/instruments/bass.scd'), VOICE);
  for (const name of ['keys', 'bass', 'keys-bus', 'band', 'keys-loop', 'pad-sc']) createTrack(root, 'creek', name);
  writeTrack('keys', ['instrument: juno', 'inputs:', '  - record:']);
  writeTrack('bass', ['instrument: bass', 'inputs:', '  - record:']);
  writeTrack('keys-bus', [
    'inserts:',
    '  - effect: eq',
    '    bands:',
    '      - type: lowpass',
    '        frequency: 700',
    'inputs:',
    '  - track: keys',
  ]);
  writeTrack('band', ['inputs:', '  - track: keys-bus', '  - track: bass']);
  writeTrack('keys-loop', ['inputs:', '  - track: keys', '    at: [1]', '  - track: keys', '    at: [5]', '  - track: keys-bus']);
  writeTrack('pad-sc', ['inputs: []']);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const program = (name: string): string => join(root, 'shared/instruments', `${name}.scd`);

describe('field keys targets', () => {
  it('arms a track by its instrument, with no takes yet', () => {
    // createTrack places every track in main, so keys-bus, which places
    // keys, is on keys' way to the speakers.
    expect(resolveKeysTargets(['creek/track:keys'], root)).toEqual([
      { program: program('juno'), track: 'creek/keys', unheardEffects: ['keys-bus'] },
    ]);
  });

  it('arms the one track with an instrument under a bus, and names the effects it does not hear yet', () => {
    expect(resolveKeysTargets(['creek/track:keys-bus'], root)).toEqual([
      { program: program('juno'), track: 'creek/keys', unheardEffects: ['keys-bus'] },
    ]);
  });

  it('names the effects above the track too, top-down from main', () => {
    writeTrack('main', ['inserts:', '  - effect: limit', '    ceiling_db: -1', 'inputs:', '  - track: band']);
    expect(resolveKeysTargets(['creek/track:keys'], root)).toEqual([
      { program: program('juno'), track: 'creek/keys', unheardEffects: ['main', 'keys-bus'] },
    ]);
  });

  it('refuses a bus with several tracks with instruments under it, listing them', () => {
    expect(() => resolveKeysTargets(['creek/track:band'], root)).toThrow(
      'field keys creek/track:band: 2 tracks with instruments are under band, and field keys plays the ones you name: ' +
        'creek/track:keys, creek/track:bass',
    );
  });

  it('counts a track reached by several paths once, with the effects of every path', () => {
    // keys-loop places keys twice, and once more through keys-bus.
    expect(resolveKeysTargets(['creek/track:keys-loop'], root)).toEqual([
      { program: program('juno'), track: 'creek/keys', unheardEffects: ['keys-bus'] },
    ]);
    // Named directly and through its bus, in either order, it keeps the bus.
    for (const targets of [
      ['creek/track:keys', 'creek/track:keys-bus'],
      ['creek/track:keys-bus', 'creek/track:keys'],
    ]) {
      expect(resolveKeysTargets(targets, root)).toEqual([
        { program: program('juno'), track: 'creek/keys', unheardEffects: ['keys-bus'] },
      ]);
    }
  });

  it('refuses a track with no instrument on it or under it', () => {
    expect(() => resolveKeysTargets(['creek/track:pad-sc'], root)).toThrow('no instrument there');
  });

  it('arms every target at once, instruments and tracks mixed, each once', () => {
    expect(resolveKeysTargets(['creek/track:keys', 'creek/track:bass', 'creek/track:keys', 'juno'], root)).toEqual([
      { program: program('juno'), track: 'creek/keys', unheardEffects: ['keys-bus'] },
      { program: program('bass'), track: 'creek/bass', unheardEffects: [] },
      { program: program('juno'), unheardEffects: [] },
    ]);
  });
});
