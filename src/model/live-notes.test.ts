import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeWavFloat32 } from '../audio/wav.js';
import type { MidiTake } from '../audiod/protocol.js';
import { createSong, createTrack } from '../commands/create.js';
import { importAsset } from '../commands/import.js';
import { init } from '../commands/init.js';
import { landMidiTake } from '../commands/land.js';
import { compileSession } from '../graph/live.js';

// The `seq:` claim (sequencer.md §3.6): compiled with `seq:creek/keys`
// open, the session plays keys' notes live through the input, so it
// leaves out the renders of its part and its MIDI take and keeps its
// audio. A `keys:` input plays beside the renders.

// A stand-in for sclang in the voice-render contract: a short silent WAV
// at FIELD_OUTPUT, and a line in STUB_RUNS for each render.
const STUB = `#!/usr/bin/env node
const { appendFileSync, writeFileSync } = require('node:fs');
appendFileSync(process.env.STUB_RUNS, process.env.FIELD_OUTPUT + '\\n');
const rate = Number(process.env.FIELD_SAMPLE_RATE);
const channels = Number(process.env.FIELD_CHANNELS);
const data = Buffer.alloc(Math.round(Number(process.env.FIELD_DURATION) * rate) * channels * 2);
const header = Buffer.alloc(44);
header.write('RIFF', 0);
header.writeUInt32LE(36 + data.length, 4);
header.write('WAVEfmt ', 8);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20);
header.writeUInt16LE(channels, 22);
header.writeUInt32LE(rate, 24);
header.writeUInt32LE(rate * channels * 2, 28);
header.writeUInt16LE(channels * 2, 32);
header.writeUInt16LE(16, 34);
header.write('data', 36);
header.writeUInt32LE(data.length, 40);
writeFileSync(process.env.FIELD_OUTPUT, Buffer.concat([header, data]));
`;

let root: string;
let runs: string;
const saved = { sclang: process.env['FIELD_SCLANG'], runs: process.env['STUB_RUNS'] };

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'field-live-notes-'));
  runs = join(root, 'runs.log');
  const stub = join(root, 'sclang');
  writeFileSync(stub, STUB);
  chmodSync(stub, 0o755);
  process.env['FIELD_SCLANG'] = stub;
  process.env['STUB_RUNS'] = runs;

  init({ dir: root, name: 'live-notes' });
  createSong(root, 'creek');
  createTrack(root, 'creek', 'keys');
  writeFileSync(join(root, 'shared/instruments/pad.scd'), '// a voice\n');
  mkdirSync(join(root, 'songs/creek/notes'));
  writeFileSync(join(root, 'songs/creek/notes/riff.yaml'), 'notes:\n  - {at: [1], length: [0, 1], note: C3}\ncontrols: []\nbends: []\n');
  const hit = join(root, 'hit.wav');
  const tone = Float32Array.from({ length: 4800 }, (_, i) => 0.3 * Math.sin((2 * Math.PI * 220 * i) / 48000));
  writeWavFloat32(hit, 48000, [tone, tone]);
  await importAsset(root, 'creek', hit, 'hit');

  writeFileSync(
    join(root, 'songs/creek/tracks/keys.yaml'),
    [
      'name: keys',
      'instrument: pad',
      'inputs:',
      '  - audio: hit',
      '    at: [1]',
      '  - id: verse',
      '    notes: riff',
      '    at: [2]',
      '  - record:',
      '',
    ].join('\n'),
  );
  // A MIDI take on keys' record entry, chosen as it lands.
  const id = 'take-20261016-101500';
  const dir = join(root, '.field', 'recording', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'take.midi.ndjson'), [{ at: 0, midi: [144, 60, 100] }, { at: 24000, midi: [128, 60, 0] }].map((l) => `${JSON.stringify(l)}\n`).join(''));
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
    started_at_samples: 96000,
    started_wall: '2026-10-16T10:15:00.000-06:00',
    daemon: '0.14.0',
    complete: true,
    frames: 48000,
    events: 2,
  };
  await landMidiTake(root, take);
});

afterEach(() => {
  for (const [name, value] of [['FIELD_SCLANG', saved.sclang], ['STUB_RUNS', saved.runs]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

const renders = (): number => (existsSync(runs) ? readFileSync(runs, 'utf8').trim().split('\n').length : 0);

async function keysInputs(input: string) {
  const { session } = await compileSession(root, 'creek', { inputs: [{ track: 'keys', input }] });
  return session.tracks.find((t) => t.name === 'keys')!.inputs;
}

describe('a seq: input at session compile', () => {
  it("leaves out the track's notes renders and keeps its audio, where a keys: input keeps them all", async () => {
    const live = await keysInputs('seq:creek/keys');
    expect(renders()).toBe(0);
    expect(live).toEqual([
      expect.objectContaining({ file: expect.stringMatching(/^songs\/creek\/audio\/hit/) }),
      { input: 'seq:creek/keys', gain_db: 0 },
    ]);

    const played = await keysInputs('keys:creek/keys');
    // The part and the take, each rendered through pad.
    expect(renders()).toBe(2);
    expect(played).toHaveLength(4);
    expect(played[0]).toEqual(live[0]);
    expect(played.filter((i) => 'file' in i && !i.file.startsWith('songs/creek/audio/'))).toHaveLength(2);
    expect(played.at(-1)).toEqual({ input: 'keys:creek/keys', gain_db: 0 });
  });

  it('claims only the track its input names', async () => {
    createTrack(root, 'creek', 'bass');
    writeFileSync(join(root, 'songs/creek/tracks/bass.yaml'), 'name: bass\ninstrument: pad\ninputs:\n  - notes: riff\n    at: [1]\n');
    const { session } = await compileSession(root, 'creek', { inputs: [{ track: 'keys', input: 'seq:creek/keys' }] });
    expect(session.tracks.find((t) => t.name === 'bass')!.inputs).toEqual([expect.objectContaining({ file: expect.any(String) })]);
    expect(renders()).toBe(1);
  });
});
