import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readWav, readWavHeader } from '../audio/wav.js';
import type { MidiTake } from '../audiod/protocol.js';
import { buildLabels, explainLabel } from '../commands/build.js';
import { createSong, createTrack } from '../commands/create.js';
import { init } from '../commands/init.js';
import { appendLedgerRow, openLedger } from '../commands/import.js';
import { landMidiTake } from '../commands/land.js';
import type { GeneratorRunner } from '../graph/build.js';
import { withTakes } from '../graph/graph.js';
import { sha256Text } from '../hash.js';
import { genRef } from '../labels.js';
import { loadProject } from '../model/project.js';
import { TempoMap } from '../time/tempo.js';
import { RELEASE_TAIL_SECONDS } from './voice-render.js';

// A recorded MIDI take in the build (keyboard-instrument.md §12.3,
// sequencer.md §2.4): the graph mints a voice-render node for the record
// entry, keyed on the take, its resolved events, the instrument, and
// Field's own harness, and the track places its render where the take
// starts.

let root: string;
const GEN = '//songs/creek/gen:keys';

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'field-voice-render-'));
  init({ dir: root, name: 'voices' });
  createSong(root, 'creek');
  createTrack(root, 'creek', 'keys');
  writeFileSync(join(root, 'shared/instruments/pad.scd'), VOICE);
  writeFileSync(join(root, 'songs/creek/tracks/keys.yaml'), 'name: keys\ninstrument: pad\ninputs:\n  - record:\n');
  await landMidiTake(root, midiTransaction());
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// Half a second of take at 48 kHz: an A held for a quarter second, then
// a C still held when the take stopped.
const HELD = [
  { at: 0, midi: [144, 69, 100] },
  { at: 12000, midi: [128, 69, 0] },
  { at: 12000, midi: [144, 72, 80] },
];

// Where the graph places the keys track's chosen take under the song's
// current tempo.
function placedAt(): unknown[] {
  const song = loadProject(root).songs.find((s) => s.name === 'creek')!;
  const track = song.tracks.find((t) => t.data.name === 'keys')!.data;
  return withTakes(track, song, new TempoMap(song.time!.tempo, 48000), 48000, () => 48000).inputs;
}

function midiTransaction(id = 'take-20261010-120000', placed: Partial<MidiTake> = {}, lines = HELD): MidiTake {
  const dir = join(root, '.field', 'recording', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'take.midi.ndjson'), lines.map((l) => `${JSON.stringify(l)}\n`).join(''));
  const take: MidiTake = {
    id,
    file: `.field/recording/${id}/take.midi.ndjson`,
    track: '//songs/creek/track:keys',
    kind: 'midi',
    sources: ['Field Keys'],
    sample_rate: 48000,
    output_latency: 0,
    started_at_samples: 0,
    ...placed,
    started_wall: '2026-10-10T12:00:00.000-04:00',
    daemon: '0.14.0',
    complete: true,
    frames: 24000,
    events: lines.length,
  };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(take));
  return take;
}

// A voice under the contract field keys plays (keyboard-instrument.md
// §4): a SynthDef with freq, amp, gate, and out that frees itself when
// the gate closes.
const VOICE = `(
SynthDef(\\fieldTestVoice, { |freq = 440, amp = 0.5, gate = 1, out = 0|
	var env = EnvGen.kr(Env.asr(0.01, 1, 0.05), gate, doneAction: 2);
	Out.ar(out, (SinOsc.ar(freq) * amp * 0.2 * env) ! 2);
});
)
`;

describe('voice-render in the graph', () => {
  it('mints a render node keyed on the notes, the instrument, and the harness', async () => {
    const e = await explainLabel(root, GEN);
    expect(e.rule).toBe('voice-render');
    expect(e.inputs.map((i) => i.label)).toEqual([
      '//songs/creek/asset:take-20261010-120000',
      'shared/instruments/pad.scd',
      'sc/voice-render.scd',
      'sc/voice-load.scd',
      'sc/voicer.scd',
    ]);
  });

  it('places the render where the take started, and follows a tempo edit there', async () => {
    // Half a second into the track, beat 2 at 120 bpm, with 128 samples
    // of output latency: the latency comes off the notes, and the take
    // starts where the capture did.
    await landMidiTake(root, midiTransaction('take-20261010-120100', { started_at_samples: 24000, output_latency: 128 }));
    expect(placedAt()).toEqual([expect.objectContaining({ audio: genRef('keys'), anchor: 'absolute', at: 24000, source_offset: 0 })]);
    const events = async (): Promise<unknown> => ((await explainLabel(root, GEN)).parameters as { events: unknown }).events;
    // The A pressed at the take's start ends a quarter second later, as heard.
    expect(await events()).toMatchObject({ sample_rate: 48000, notes: [{ at: 0, length: 12000 - 125, note: 69 }, { at: 12000 - 125 }] });

    // At 60 bpm beat 2 is a second in, and every note is twice as long.
    const songYaml = join(root, 'songs/creek/song.yaml');
    writeFileSync(songYaml, readFileSync(songYaml, 'utf8').replace('bpm: 120', 'bpm: 60'));
    expect(placedAt()).toEqual([expect.objectContaining({ at: 48000 })]);
    expect(await events()).toMatchObject({ notes: [{ at: 0, length: 24000 - 250, note: 69 }, { at: 24000 - 250 }] });
  });

  it('moves with its record entry by the same musical distance, and keeps its notes on their beats there', async () => {
    // Beat 2 of the entry's first bar, at 120 bpm.
    const landed = await landMidiTake(root, midiTransaction('take-20261010-120200', { started_at_samples: 24000 }));
    expect(landed.row).toMatchObject({ started_at_samples: 24000, started_at_ticks: 960, musical_position: [1, 2] });
    const events = async (): Promise<unknown> => ((await explainLabel(root, GEN)).parameters as { events: unknown }).events;
    const before = await events();

    // Two bars later, the take starts on beat 2 of bar 3, and plays as it did.
    writeFileSync(join(root, 'songs/creek/tracks/keys.yaml'), 'name: keys\ninstrument: pad\ninputs:\n  - record:\n    at: [3]\n');
    expect(placedAt()).toEqual([expect.objectContaining({ audio: genRef('keys'), at: 2 * 96000 + 24000 })]);
    expect(await events()).toEqual(before);

    // At 60 bpm a bar is four seconds, and beat 2 is a second into it.
    const songYaml = join(root, 'songs/creek/song.yaml');
    writeFileSync(songYaml, readFileSync(songYaml, 'utf8').replace('bpm: 120', 'bpm: 60'));
    expect(placedAt()).toEqual([expect.objectContaining({ at: 2 * 4 * 48000 + 48000 })]);
    expect(await events()).toMatchObject({ notes: [{ at: 0, length: 24000, note: 69 }, { at: 24000 }] });
  });

  it('plays a take recorded in samples as it was recorded, wherever the tempo goes', async () => {
    // A take written before takes landed in ticks: samples at its rate,
    // placed by its row, less the output latency, as an audio take is.
    const name = 'take-20261010-110000';
    const file = `audio/keys/${name}.notes.yaml`;
    const text = 'sample_rate: 48000\nlength: 24000\nnotes:\n  - { at: 0, length: 12000, note: 69, velocity: 100 }\ncontrols: []\nbends: []\n';
    writeFileSync(join(root, 'songs/creek', file), text);
    const songDir = join(root, 'songs/creek');
    const { doc } = openLedger(songDir);
    appendLedgerRow(songDir, doc, { name, file, sha256: sha256Text(text), bytes: Buffer.byteLength(text) });
    writeFileSync(
      join(songDir, 'audio/keys/takes.yaml'),
      [
        'record: keys',
        `chosen: ${name}`,
        'takes:',
        `  - asset: ${name}`,
        '    started_at_samples: 24000',
        '    musical_position: [1, 2]',
        '    latency: 128',
        '    sources: [Field Keys]',
        '    recorded_at: 2026-10-10T11:00:00.000-04:00',
        '',
      ].join('\n'),
    );
    const e = await explainLabel(root, GEN);
    expect(e.inputs[0]!.label).toBe(`//songs/creek/asset:${name}`);
    expect(e.parameters).toMatchObject({
      events: { sample_rate: 48000, length: 24000, notes: [{ at: 0, length: 12000, note: 69, velocity: 100 }] },
    });
    expect(placedAt()).toEqual([expect.objectContaining({ at: 24000 - 128 })]);
    const songYaml = join(root, 'songs/creek/song.yaml');
    writeFileSync(songYaml, readFileSync(songYaml, 'utf8').replace('bpm: 120', 'bpm: 60'));
    expect(placedAt()).toEqual([expect.objectContaining({ at: 24000 - 128 })]);
    expect((await explainLabel(root, GEN)).actionKey).toBe(e.actionKey);
  });

  it('renders once, caches, and re-renders when the instrument changes', async () => {
    let runs = 0;
    const runner: GeneratorRunner = async (_node, inputPaths, outputPath) => {
      runs++;
      copyFileSync(inputPaths[0]!, outputPath);
    };
    await buildLabels(root, [GEN], runner);
    await buildLabels(root, [GEN], runner);
    expect(runs).toBe(1);
    writeFileSync(join(root, 'shared/instruments/pad.scd'), VOICE.replace('0.05', '0.1'));
    await buildLabels(root, [GEN], runner);
    expect(runs).toBe(2);
  });

  it('keys the render on the instrument’s knob file when it has one, and re-renders when it changes', async () => {
    writeFileSync(join(root, 'shared/instruments/pad.knobs.yaml'), LEVEL_KNOB);
    const e = await explainLabel(root, GEN);
    expect(e.inputs.map((i) => i.label)).toContain('shared/instruments/pad.knobs.yaml');
    let runs = 0;
    const runner: GeneratorRunner = async (_node, inputPaths, outputPath) => {
      runs++;
      copyFileSync(inputPaths[0]!, outputPath);
    };
    await buildLabels(root, [GEN], runner);
    await buildLabels(root, [GEN], runner);
    expect(runs).toBe(1);
    writeFileSync(join(root, 'shared/instruments/pad.knobs.yaml'), LEVEL_KNOB.replace('default: 0', 'default: 0.5'));
    await buildLabels(root, [GEN], runner);
    expect(runs).toBe(2);
  });

  it('fails the build with the knob file’s errors, before anything renders', async () => {
    writeFileSync(join(root, 'shared/instruments/pad.knobs.yaml'), 'knobs:\n  - { name: level, cc: 74, min: 0, max: 1, curve: exp }\n');
    let runs = 0;
    const runner: GeneratorRunner = async () => {
      runs++;
    };
    await expect(buildLabels(root, [GEN], runner)).rejects.toThrow(
      'shared/instruments/pad.knobs.yaml: knobs.0.min: level: an exp curve needs min and max of one sign and neither 0, not 0 and 1',
    );
    expect(runs).toBe(0);
  });
});

// A knob that sets a voice's level, on CC 74.
const LEVEL_KNOB = 'knobs:\n  - { name: level, cc: 74, min: 0, max: 1, curve: lin, default: 0 }\n';

// buildLabels reports every node it walked, dependencies first.
const built = <T extends { label: string }>(outcomes: T[], label: string): T => outcomes.find((o) => o.label === label)!;

const sclangPresent =
  existsSync('/Applications/SuperCollider.app/Contents/MacOS/sclang') ||
  (process.env['PATH'] ?? '').split(':').some((p) => p !== '' && existsSync(join(p, 'sclang')));

describe.skipIf(!sclangPresent)('voice-render through real sclang', () => {
  it('renders the take with its release tail, the same bytes every time', { timeout: 120_000 }, async () => {
    const first = built(await buildLabels(root, [GEN]), GEN);
    const header = readWavHeader(first.outputPath!);
    expect(header.channels).toBe(2);
    // scsynth writes whole control blocks in NRT, so a render runs up to
    // one block (64 samples) past its duration, as every sc-render does.
    const frames = 24000 + RELEASE_TAIL_SECONDS * 48000;
    expect(header.frames).toBeGreaterThanOrEqual(frames);
    expect(header.frames).toBeLessThanOrEqual(frames + 64);
    expect(readFileSync(first.outputPath!).subarray(44).some((b) => b !== 0)).toBe(true);

    rmSync(join(root, '.field/cache'), { recursive: true, force: true });
    const again = built(await buildLabels(root, [GEN]), GEN);
    expect(again.cached).toBe(false);
    expect(again.sha256).toBe(first.sha256);

    // The track builds over the render, where the take was played.
    const track = built(await buildLabels(root, ['//songs/creek/track:keys']), '//songs/creek/track:keys');
    expect(existsSync(track.outputPath!)).toBe(true);
  });

  it('passes a take\'s mod wheel to a voice that has the control', { timeout: 120_000 }, async () => {
    // A voice whose level is the mod wheel: silent at 0, sounding at 1.
    writeFileSync(
      join(root, 'shared/instruments/pad.scd'),
      VOICE.replace('|freq = 440, amp = 0.5, gate = 1, out = 0|', '|freq = 440, amp = 0.5, gate = 1, out = 0, mod = 0|').replace(
        '* amp * 0.2 * env',
        '* amp * 0.2 * mod * env',
      ),
    );
    const peak = async (): Promise<number> => {
      const wav = readWav(built(await buildLabels(root, [GEN]), GEN).outputPath!);
      return wav.channels[0]!.reduce((max, s) => Math.max(max, Math.abs(s)), 0);
    };
    expect(await peak()).toBe(0); // the take beforeEach landed sends no CC 1
    await landMidiTake(
      root,
      midiTransaction('take-20261010-120300', {}, [
        { at: 0, midi: [176, 1, 127] },
        { at: 100, midi: [144, 69, 100] },
        { at: 12000, midi: [128, 69, 0] },
      ]),
    );
    expect(await peak()).toBeGreaterThan(0.05);
  });

  it('maps a take\'s controllers through the instrument\'s knob file', { timeout: 120_000 }, async () => {
    // A voice whose level is its knob, read from the copy Field checked:
    // silent at the knob's default, sounding once CC 74 turns it up.
    writeFileSync(join(root, 'shared/instruments/pad.knobs.yaml'), LEVEL_KNOB);
    writeFileSync(
      join(root, 'shared/instruments/pad.scd'),
      VOICE.replace(
        '(\n',
        '(\nvar knob = "FIELD_KNOBS".getenv.parseYAMLFile["knobs"][0];\nvar spec = ControlSpec(knob["min"].asFloat, knob["max"].asFloat, knob["curve"].asSymbol);\n',
      ).replace('* amp * 0.2 * env', '* amp * 0.2 * spec.map(("cc" ++ knob["cc"]).asSymbol.kr(spec.unmap(knob["default"].asFloat))) * env'),
    );
    const peak = async (): Promise<number> => {
      const wav = readWav(built(await buildLabels(root, [GEN]), GEN).outputPath!);
      return wav.channels[0]!.reduce((max, s) => Math.max(max, Math.abs(s)), 0);
    };
    expect(await peak()).toBe(0);
    await landMidiTake(
      root,
      midiTransaction('take-20261010-120400', {}, [
        { at: 0, midi: [176, 74, 127] },
        { at: 100, midi: [144, 69, 100] },
        { at: 12000, midi: [128, 69, 0] },
      ]),
    );
    const turned = await peak();
    expect(turned).toBeGreaterThan(0.05);
    // The knob's range is the file's: half the range, half the level.
    writeFileSync(join(root, 'shared/instruments/pad.knobs.yaml'), LEVEL_KNOB.replace('max: 1', 'max: 0.5'));
    expect(await peak()).toBeCloseTo(turned / 2, 2);
  });

  it('loads the instrument without the render variables, as voice mode is live', { timeout: 120_000 }, async () => {
    const strict = VOICE.replace(
      '(\n',
      '(\nif ("FIELD_OUTPUT FIELD_SEED FIELD_DURATION FIELD_SAMPLE_RATE FIELD_CHANNELS".split($ ).any { |name| name.getenv.notNil }) { Error("a render variable is set in voice mode").throw };\n',
    );
    expect(strict).not.toBe(VOICE);
    writeFileSync(join(root, 'shared/instruments/pad.scd'), strict);
    const outcome = built(await buildLabels(root, [GEN]), GEN);
    expect(existsSync(outcome.outputPath!)).toBe(true);
  });

  it.each(['juno', 'bass'])(
    'renders bloom\'s %s from a knob file without some of the knobs it maps',
    { timeout: 120_000 },
    async (instrument) => {
      // The schema accepts any set of knobs, so a voice keeps a setting's
      // fixed value for a knob its file leaves out.
      const shelf = join(import.meta.dirname, '..', '..', 'examples', 'bloom', 'shared', 'instruments');
      copyFileSync(join(shelf, `${instrument}.scd`), join(root, 'shared/instruments', `${instrument}.scd`));
      writeFileSync(
        join(root, 'shared/instruments', `${instrument}.knobs.yaml`),
        'knobs:\n  - { name: cutoff, cc: 74, min: 50, max: 15000, curve: exp, units: Hz, default: 2000 }\n',
      );
      writeFileSync(
        join(root, 'songs/creek/tracks/keys.yaml'),
        `name: keys\ninstrument: ${instrument}\ninputs:\n  - record:\n`,
      );
      const wav = readWav(built(await buildLabels(root, [GEN]), GEN).outputPath!);
      expect(wav.channels[0]!.some((s) => s !== 0)).toBe(true);
    },
  );
});
