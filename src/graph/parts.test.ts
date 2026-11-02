import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MidiTake } from '../audiod/protocol.js';
import { buildLabels, explainLabel } from '../commands/build.js';
import { check } from '../commands/check.js';
import { createSong, createTrack } from '../commands/create.js';
import { fmt } from '../commands/fmt.js';
import { init } from '../commands/init.js';
import { landMidiTake } from '../commands/land.js';
import type { GeneratorRunner } from './build.js';

// Parts in the build (sequencer.md §2.1–§2.4): a `notes:` entry places a
// part, the graph renders it through the track's instrument as a
// voice-render node keyed on the events it resolves to, and the track
// places the render where the entry says.

let root: string;
let runs: string[];

// Every rule renders its own spec, so a render's bytes change exactly
// when its spec does, and each run is counted by label.
const runner: GeneratorRunner = async (node, _inputPaths, outputPath) => {
  runs.push(node.label.name);
  writeFileSync(outputPath, JSON.stringify(node.spec));
};

const VOICE = '(\nSynthDef(\\pad, { |freq = 440, amp = 0.5, gate = 1, out = 0| Out.ar(out, SinOsc.ar(freq) ! 2) });\n)\n';
const RIFF = [
  'length: [2]',
  'notes:',
  '  - {at: [1], length: [0, 1], note: C3, velocity: 110}',
  '  - {at: [1, 2], length: [0, 1], note: G3}',
  '  - {at: [2], length: [1], note: 60}',
  'controls: []',
  'bends: []',
  '',
].join('\n');

function writeTrack(name: string, lines: string[]): void {
  writeFileSync(join(root, 'songs/creek/tracks', `${name}.yaml`), [`name: ${name}`, ...lines, ''].join('\n'));
}
function writePart(name: string, text: string): void {
  writeFileSync(join(root, 'songs/creek/notes', `${name}.yaml`), text);
}
function edit(path: string, from: string, to: string): void {
  const file = join(root, path);
  const text = readFileSync(file, 'utf8');
  expect(text).toContain(from);
  writeFileSync(file, text.replace(from, to));
}
const parameters = async (label: string) => (await explainLabel(root, label)).parameters as Record<string, unknown>;
const events = async (label: string) => (await parameters(label))['events'] as { notes: { at: number; length: number }[] };
const inputs = async (label: string) => (await explainLabel(root, label)).inputs.map((i) => i.label);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'field-parts-'));
  runs = [];
  init({ dir: root, name: 'parts' });
  createSong(root, 'creek'); // 120 bpm 4/4 at 48 kHz: a beat is 24000 samples, a bar 96000
  createTrack(root, 'creek', 'keys');
  writeFileSync(join(root, 'shared/instruments/pad.scd'), VOICE);
  mkdirSync(join(root, 'songs/creek/notes'));
  writePart('riff', RIFF);
  writeTrack('keys', ['instrument: pad', 'inputs:', '  - notes: riff', '    at: [17]']);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('a placed part', () => {
  it('renders through the track\'s instrument, with the part and the instrument as inputs, from where it is placed', async () => {
    expect((await check(root)).diagnostics).toEqual([]);
    const e = await explainLabel(root, '//songs/creek/gen:keys');
    expect(e.rule).toBe('voice-render');
    expect(e.inputs.map((i) => i.label)).toEqual([
      'songs/creek/notes/riff.yaml',
      'shared/instruments/pad.scd',
      'sc/voice-render.scd',
      'sc/voice-load.scd',
      'sc/voicer.scd',
    ]);
    expect(e.parameters).toEqual({
      instrument: 'pad',
      events: {
        sample_rate: 48000,
        length: 192000,
        notes: [
          { at: 0, length: 24000, note: 48, velocity: 110 },
          { at: 24000, length: 24000, note: 55, velocity: 100 },
          { at: 96000, length: 96000, note: 60, velocity: 100 },
        ],
        controls: [],
        bends: [],
      },
    });
    // The track places the render at bar 17.
    const stem = await parameters('//songs/creek/track:keys');
    expect(stem['clips']).toEqual([expect.objectContaining({ start: 16 * 96000, read_offset: 0 })]);
    await buildLabels(root, ['//songs/creek/track:keys'], runner);
    expect(runs).toEqual(['keys', 'keys']); // the render, then the stem
  });

  it('renders again when a note, the tempo, or the instrument changes, and keeps every note on its beat', async () => {
    await buildLabels(root, ['//songs/creek/gen:keys'], runner);
    edit('songs/creek/notes/riff.yaml', 'note: G3', 'note: A3');
    await buildLabels(root, ['//songs/creek/gen:keys'], runner);
    expect(runs).toHaveLength(2);

    edit('songs/creek/song.yaml', 'bpm: 120', 'bpm: 60');
    await buildLabels(root, ['//songs/creek/gen:keys'], runner);
    expect(runs).toHaveLength(3);
    // At 60 bpm a beat is a second: the second note is on beat 2 still,
    // and bar 2 starts four seconds in.
    expect((await events('//songs/creek/gen:keys')).notes.map((n) => n.at)).toEqual([0, 48000, 4 * 48000]);
    const stem = await parameters('//songs/creek/track:keys');
    expect(stem['clips']).toEqual([expect.objectContaining({ start: 16 * 4 * 48000 })]);

    writeFileSync(join(root, 'shared/instruments/pad.scd'), VOICE.replace('440', '220'));
    await buildLabels(root, ['//songs/creek/gen:keys'], runner);
    expect(runs).toHaveLength(4);
    await buildLabels(root, ['//songs/creek/gen:keys'], runner);
    expect(runs).toHaveLength(4);
  });

  it('is one render where two placements resolve alike in a steady song', async () => {
    writeTrack('keys', [
      'instrument: pad',
      'inputs:',
      '  - id: a',
      '    notes: riff',
      '    at: [1]',
      '  - id: b',
      '    notes: riff',
      '    at: [17]',
    ]);
    const a = await explainLabel(root, '//songs/creek/gen:keys-a');
    const b = await explainLabel(root, '//songs/creek/gen:keys-b');
    expect(b.actionKey).toBe(a.actionKey);
    const outcomes = await buildLabels(root, ['//songs/creek/gen:keys-a', '//songs/creek/gen:keys-b'], runner);
    expect(runs).toEqual(['keys-a']);
    expect(outcomes.find((o) => o.label === '//songs/creek/gen:keys-b')).toMatchObject({ cached: true });
  });

  it('repeats at the part\'s length when its loop omits every, from one render in a steady song', async () => {
    writeTrack('keys', ['instrument: pad', 'inputs:', '  - notes: riff', '    at: [1]', '    duration: [8]', '    loop: {}']);
    expect((await check(root)).diagnostics).toEqual([]);
    expect(await inputs('//songs/creek/track:keys')).toEqual(['//songs/creek/gen:keys']);
    const stem = await parameters('//songs/creek/track:keys');
    expect((stem['clips'] as { start: number }[]).map((c) => c.start)).toEqual([0, 2, 4, 6].map((bar) => bar * 96000));
  });

  it('is one render for a whole loop at a tempo where a bar is not a whole number of samples', async () => {
    const sixteenths = Array.from({ length: 16 }, (_, i) => `  - {at: ${i * 240}, length: 240, note: C3}`);
    writePart('steps', ['length: [1]', 'notes:', ...sixteenths, 'controls: []', 'bends: []', ''].join('\n'));
    edit('songs/creek/song.yaml', 'bpm: 120', 'bpm: 133');
    writeTrack('keys', ['instrument: pad', 'inputs:', '  - notes: steps', '    at: [1]', '    duration: [32]', '    loop: {}']);
    expect((await check(root)).diagnostics).toEqual([]);
    expect(await inputs('//songs/creek/track:keys')).toEqual(['//songs/creek/gen:keys']);
    expect(((await parameters('//songs/creek/track:keys'))['clips'] as unknown[]).length).toBe(32);
  });

  it('resolves each repetition of its loop where the repetition starts, so a tempo change reaches the later ones', async () => {
    writePart('beat', ['length: [1]', 'notes:', '  - {at: [1, 2], length: [0, 1], note: C3}', 'controls: []', 'bends: []', ''].join('\n'));
    createTrack(root, 'creek', 'pads');
    writeTrack('keys', ['instrument: pad', 'inputs:', '  - notes: beat', '    at: [1]', '    duration: [3]', '    loop: {}']);
    writeTrack('pads', ['instrument: pad', 'inputs:', '  - notes: beat', '    at: [2]']);
    edit('songs/creek/song.yaml', '      bpm: 120\n', '      bpm: 120\n    - at: 3840\n      bpm: 60\n');
    expect((await check(root)).diagnostics).toEqual([]);
    // Beat 2 is half a second into bar 1, at 120 bpm, and a second into
    // bars 2 and 3, at 60.
    expect((await events('//songs/creek/gen:keys')).notes.map((n) => n.at)).toEqual([24000]);
    expect((await events('//songs/creek/gen:keys-2')).notes.map((n) => n.at)).toEqual([48000]);
    await expect(explainLabel(root, '//songs/creek/gen:keys-3')).rejects.toThrow('no such label');
    // Repetitions 2 and 3 resolve alike and play one render, the one the
    // same part placed by hand at bar 2 has.
    expect(await inputs('//songs/creek/track:keys')).toEqual(['//songs/creek/gen:keys', '//songs/creek/gen:keys-2']);
    const stem = await parameters('//songs/creek/track:keys');
    expect(stem['clips']).toEqual([
      expect.objectContaining({ input: 0, start: 0 }),
      expect.objectContaining({ input: 1, start: 96000 }),
      expect.objectContaining({ input: 1, start: 96000 + 4 * 48000 }),
    ]);
    const repetition = await explainLabel(root, '//songs/creek/gen:keys-2');
    expect(repetition.actionKey).toBe((await explainLabel(root, '//songs/creek/gen:pads')).actionKey);
    await buildLabels(root, ['//songs/creek/track:keys', '//songs/creek/gen:pads'], runner);
    expect(runs.sort()).toEqual(['keys', 'keys', 'keys-2']);
  });

  it('needs ids on two notes entries in one track, as any two generators do', async () => {
    writeTrack('keys', ['instrument: pad', 'inputs:', '  - notes: riff', '  - notes: riff', '    at: [17]']);
    expect((await check(root)).diagnostics.map((d) => d.message)).toContain(
      'two generator entries share the name "keys" — give each an id so its render has a name of its own (nested-tracks.md §18)',
    );
  });
});

describe('field check on parts', () => {
  it('refuses a notes entry with no instrument, a missing part, a note name that is not one, and an instrument on record:', async () => {
    createTrack(root, 'creek', 'pads');
    createTrack(root, 'creek', 'vox');
    writeTrack('pads', ['inputs:', '  - notes: riff']);
    writeTrack('keys', ['instrument: pad', 'inputs:', '  - notes: riff', '  - id: two', '    notes: ghost']);
    writePart('bad', 'notes:\n  - {at: [1], length: [0, 1], note: H2}\n');
    writeTrack('vox', ['inputs:', '  - record:', '      instrument: pad']);
    const messages = (await check(root)).diagnostics.map((d) => `${d.file}: ${d.message}`);
    expect(messages).toEqual(
      expect.arrayContaining([
        'songs/creek/tracks/pads.yaml: input 1 ("riff") places notes, and pads has no instrument to play them — give the track one with `instrument: <name>`',
        'songs/creek/tracks/keys.yaml: input "two" places the part "ghost", and there is no songs/creek/notes/ghost.yaml',
        'songs/creek/notes/bad.yaml: "H2" is not a note name: a note is a MIDI number from 0 to 127 or a name in scientific pitch, where C4 is 60 at notes.0.note',
        "songs/creek/tracks/vox.yaml: the instrument is the track's: move `instrument: pad` up beside the track's `name:`, and leave `- record:` bare (sequencer.md §3.4) at inputs.0.record",
      ]),
    );
  });

  it('refuses a position the placing track\'s meter does not have', async () => {
    writePart('riff', 'notes:\n  - {at: [1, 5], length: [0, 1], note: C3}\n');
    expect((await check(root)).diagnostics.map((d) => d.message)).toEqual([
      'input 1 ("riff") places songs/creek/notes/riff.yaml, which does not resolve there: notes.0.at: beat 5 out of range for 4/4 in bar 1',
    ]);
  });

  it('refuses a loop repetition that lands where the part does not resolve', async () => {
    writePart('riff', 'length: [1]\nnotes:\n  - {at: [1, 4], length: [0, 1], note: C3}\n');
    writeTrack('keys', ['instrument: pad', 'inputs:', '  - notes: riff', '    at: [1]', '    duration: [3]', '    loop: {every: [1]}']);
    edit('songs/creek/song.yaml', '      denominator: 4\n', '      denominator: 4\n    - at: 3840\n      numerator: 3\n      denominator: 4\n');
    expect((await check(root)).diagnostics.map((d) => d.message)).toEqual([
      'input 1 ("riff") places songs/creek/notes/riff.yaml, which does not resolve at repetition 2 of its loop: notes.0.at: beat 4 out of range for 3/4 in bar 1',
    ]);
  });

  it('refuses a generator named as a loop repetition\'s render', async () => {
    createTrack(root, 'creek', 'keys-2');
    writeTrack('keys', ['instrument: pad', 'inputs:', '  - notes: riff', '    at: [1]', '    duration: [4]', '    loop: {}']);
    writeTrack('keys-2', ['instrument: pad', 'inputs:', '  - notes: riff']);
    edit('songs/creek/song.yaml', '      bpm: 120\n', '      bpm: 120\n    - at: 7680\n      bpm: 60\n');
    expect((await check(root)).diagnostics.map((d) => `${d.file}: ${d.message}`)).toEqual([
      'songs/creek/tracks/keys.yaml: repetition 2 of input 1 ("riff") renders as "keys-2", which the generator in songs/creek/tracks/keys-2.yaml also names — rename a track or change an id so each render has a name of its own',
    ]);
  });

  it('formats a part one row per note, keeping its spellings', async () => {
    writePart('riff', 'notes:\n  - at: [1]\n    note: C3\n    length: [0, 1]\n  - {length: 480, at: 960, note: 62}\n');
    expect((await check(root)).unformatted).toEqual(['songs/creek/notes/riff.yaml']);
    expect(fmt(root).formatted).toEqual(['songs/creek/notes/riff.yaml']);
    expect(readFileSync(join(root, 'songs/creek/notes/riff.yaml'), 'utf8')).toBe(
      'notes:\n  - {at: [1], length: [0, 1], note: C3}\n  - {at: 960, length: 480, note: 62}\n',
    );
    expect((await check(root)).ok).toBe(true);
  });
});

describe('a take copied into a part', () => {
  it('has the take\'s action key when it is placed at the take\'s position', async () => {
    writeTrack('keys', ['instrument: pad', 'inputs:', '  - record:']);
    const id = 'take-20261015-143012';
    const dir = join(root, '.field', 'recording', id);
    mkdirSync(dir, { recursive: true });
    const lines = [
      { at: 0, midi: [144, 60, 100] },
      { at: 12000, midi: [144, 64, 90] },
      { at: 30000, midi: [128, 60, 0] },
      { at: 40000, midi: [128, 64, 0] },
    ];
    writeFileSync(join(dir, 'take.midi.ndjson'), lines.map((l) => `${JSON.stringify(l)}\n`).join(''));
    const take: MidiTake = {
      id,
      file: `.field/recording/${id}/take.midi.ndjson`,
      track: '//songs/creek/track:keys',
      song: 'creek',
      kind: 'midi',
      sources: ['Field Keys'],
      sample_rate: 48000,
      timeline_rate: 48000,
      output_latency: 0,
      started_at_samples: 9 * 96000 + 24000, // bar 10, beat 2
      started_wall: '2026-10-15T14:30:12.000-04:00',
      daemon: '0.14.0',
      complete: true,
      frames: 48000,
      events: lines.length,
    };
    const landed = await landMidiTake(root, take);
    expect(landed.row.musical_position).toEqual([10, 2]);

    copyFileSync(join(root, 'songs/creek', landed.file), join(root, 'songs/creek/notes/keys-verse.yaml'));
    writeTrack('keys', [
      'instrument: pad',
      'inputs:',
      '  - record:',
      '    mute: true',
      '  - id: verse',
      '    notes: keys-verse',
      '    at: [10, 2]',
    ]);
    expect((await check(root)).diagnostics).toEqual([]);
    const takeRender = await explainLabel(root, '//songs/creek/gen:keys');
    const partRender = await explainLabel(root, '//songs/creek/gen:keys-verse');
    expect(partRender.parameters).toEqual(takeRender.parameters);
    expect(partRender.actionKey).toBe(takeRender.actionKey);
  });
});
