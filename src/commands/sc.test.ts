import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { AudiodClient, daemonBinary } from '../audiod/client.js';
import { sclangCommand } from '../generators/supercollider.js';
import { notesFileOrder, notesFileSchema } from '../schema/notes.js';
import { removeTempProject } from '../testing/temp.js';
import { canonicalText } from '../yaml/emit.js';
import { createSong, createTrack } from './create.js';
import { init } from './init.js';
import { scNotes, scVoice } from './sc.js';

const binary = (() => {
  try {
    return daemonBinary();
  } catch {
    return undefined;
  }
})();
const sclang = (() => {
  try {
    return sclangCommand();
  } catch {
    return undefined;
  }
})();
const shelf = join(import.meta.dirname, '..', '..', 'examples', 'bloom', 'shared', 'instruments');

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// `field sc voice` (sequencer.md §2.6) with a stand-in for sclang that
// records what the voice host was handed, goes live, and stays until it
// is stopped, or with STUB_FAIL, says why it cannot start and exits.
const STUB = `#!/usr/bin/env node
const { writeFileSync } = require('node:fs');
writeFileSync(process.env.STUB_LOG, JSON.stringify({
  instruments: JSON.parse(process.env.FIELD_INSTRUMENTS),
  device: process.env.FIELD_DEVICE ?? null,
  rings: process.env.FIELD_RINGS ? JSON.parse(process.env.FIELD_RINGS) : null,
  helperClosed: process.env.STUB_HELPER_CLOSED ? require('node:fs').existsSync(process.env.STUB_HELPER_CLOSED) : null,
}));
if (process.env.STUB_FAIL) {
  console.log('@field {"error":"no MIDI source named Nowhere; the sources are Field Keys"}');
  process.exit(1);
}
console.log('@field {"ready":true,"device":"Test Out","sample_rate":48000}');
setInterval(() => {}, 1000);
process.on('SIGTERM', () => process.exit(0));
`;

describe.skipIf(!binary || process.platform === 'win32')('field sc voice', () => {
  let root: string;
  let log: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'field-sc-voice-'));
    log = join(root, 'host.json');
    const stub = join(root, 'sclang');
    writeFileSync(stub, STUB);
    chmodSync(stub, 0o755);
    // FieldOut itself is not needed, only somewhere it would be.
    const fieldOut = join(root, 'fieldout');
    mkdirSync(fieldOut);
    writeFileSync(join(fieldOut, 'FieldOut.scx'), '');
    env = { ...process.env, FIELD_SCLANG: stub, STUB_LOG: log, FIELD_FIELDOUT: fieldOut };
    process.env['FIELD_AUDIOD_NULL'] = '1';
    init({ dir: root, name: 'sc-voice' });
    copyFileSync(join(shelf, 'juno.scd'), join(root, 'shared/instruments/juno.scd'));
    copyFileSync(join(shelf, 'juno.knobs.yaml'), join(root, 'shared/instruments/juno.knobs.yaml'));
    writeFileSync(join(root, 'shared/instruments/pad.scd'), '// a voice\n');
    createSong(root, 'creek');
    createTrack(root, 'creek', 'keys');
    writeFileSync(join(root, 'songs/creek/tracks/keys.yaml'), 'name: keys\ninstrument: juno\ninputs:\n  - record:\n');
  });
  afterEach(async () => {
    try {
      const client = await AudiodClient.connect(root);
      await client.quit();
      client.close();
    } catch {
      // never started
    }
    delete process.env['FIELD_AUDIOD_NULL'];
    await removeTempProject(root);
  });

  const inputs = async (): Promise<string[]> => {
    const client = await AudiodClient.connect(root);
    try {
      return ((await client.status()).inputs ?? []).map((i) => i.name);
    } finally {
      client.close();
    }
  };

  // Runs `field sc voice` until the voice is live, hands `whileLive` the
  // lines it printed, then quits it.
  async function playLive(targets: string[], source: string[], whileLive: (lines: string[]) => Promise<void>): Promise<string[]> {
    const lines: string[] = [];
    let quit!: () => void;
    const until = new Promise<void>((resolve) => {
      quit = resolve;
    });
    const running = scVoice(targets, { source }, { cwd: root, env, until, print: (line) => lines.push(line) });
    try {
      for (let i = 0; i < 100 && !lines.some((l) => l.includes(' live at ')); i++) await sleep(50);
      await whileLive(lines);
    } finally {
      quit();
      await running;
    }
    return lines;
  }

  it('plays a track\'s voice from the source named, into a voice: input, and closes the input when it quits', { timeout: 30_000 }, async () => {
    const lines = await playLive(['creek/track:keys'], ['Field Keys'], async () => {
      expect(await inputs()).toEqual(['voice:creek/keys']);
    });
    expect(lines).toEqual([
      'voice  keys (juno) · from Field Keys → voice:creek/keys',
      'keys (juno) live at 48000 Hz on Test Out',
    ]);
    const handed = JSON.parse(readFileSync(log, 'utf8'));
    // The voice plays from Field Keys alone, through the checked copy of
    // its knob file, into the input's ring.
    expect(handed.instruments).toEqual([
      { program: join(root, 'shared/instruments/juno.scd'), knobs: expect.stringMatching(/juno\.knobs\.yaml$/), sources: ['Field Keys'] },
    ]);
    expect(handed.rings).toEqual([expect.any(Number)]);
    expect(existsSync(handed.instruments[0].knobs)).toBe(false);
    expect(await inputs()).toEqual([]);
  });

  it('plays from every source but the Field Seq ones when none is named, and an instrument by name to the device', { timeout: 30_000 }, async () => {
    const lines = await playLive(['creek/track:keys', 'pad'], [], async () => {});
    expect(lines.slice(0, 2)).toEqual([
      'voice  keys (juno) · from every MIDI source but the Field Seq ones → voice:creek/keys',
      'voice  pad · from every MIDI source but the Field Seq ones → the device',
    ]);
    const handed = JSON.parse(readFileSync(log, 'utf8'));
    expect(handed.instruments.map((i: { sources?: string[] }) => i.sources)).toEqual([undefined, undefined]);
    expect(handed.rings).toEqual([expect.any(Number), null]);
  });

  it('says why the voice host did not start, and leaves no input open', { timeout: 30_000 }, async () => {
    await expect(
      scVoice(['creek/track:keys'], { source: ['Nowhere'] }, { cwd: root, env: { ...env, STUB_FAIL: '1' }, print: () => {} }),
    ).rejects.toThrow('the voice host did not start: no MIDI source named Nowhere; the sources are Field Keys');
    expect(await inputs()).toEqual([]);
  });

  it('names itself when a target does not resolve', async () => {
    createTrack(root, 'creek', 'drums');
    await expect(scVoice(['creek/track:drums'], { source: [] }, { cwd: root, env, print: () => {} })).rejects.toThrow(
      /^field sc voice creek\/track:drums: no instrument there/,
    );
  });
});

// With no project there is no daemon to ask for the system output, and
// scsynth given no device opens the microphone (keyboard-instrument.md
// §10.1), so the voice names what `field-audiod --keys` reports.
const HELPER_STUB = `#!/usr/bin/env node
const { writeFileSync } = require('node:fs');
console.log(JSON.stringify({ ready: true, name: process.argv[3], output: 'Stub Out' }));
process.stdin.resume();
process.stdin.on('end', () => {
  writeFileSync(process.env.STUB_HELPER_CLOSED, '');
  process.exit(0);
});
`;

describe.skipIf(process.platform === 'win32')('field sc voice outside a project', () => {
  let dir: string;
  const saved = { audiod: process.env['FIELD_AUDIOD'], closed: process.env['STUB_HELPER_CLOSED'] };
  const restore = (name: string, value: string | undefined): void => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'field-sc-voice-bare-'));
    for (const [name, text] of [['sclang', STUB], ['field-audiod', HELPER_STUB]] as const) {
      writeFileSync(join(dir, name), text);
      chmodSync(join(dir, name), 0o755);
    }
    writeFileSync(join(dir, 'pad.scd'), '// a voice\n');
    process.env['FIELD_AUDIOD'] = join(dir, 'field-audiod');
    process.env['STUB_HELPER_CLOSED'] = join(dir, 'helper-closed');
  });
  afterEach(() => {
    restore('FIELD_AUDIOD', saved.audiod);
    restore('STUB_HELPER_CLOSED', saved.closed);
    rmSync(dir, { recursive: true, force: true });
  });

  async function hostHandedFor(platform: NodeJS.Platform = process.platform): Promise<{ device: string | null; helperClosed: boolean | null }> {
    const log = join(dir, 'host.json');
    let quit!: () => void;
    const until = new Promise<void>((resolve) => {
      quit = resolve;
    });
    const lines: string[] = [];
    const running = scVoice(
      ['./pad.scd'],
      { source: [] },
      { cwd: dir, env: { ...process.env, FIELD_SCLANG: join(dir, 'sclang'), STUB_LOG: log }, until, platform, print: (line) => lines.push(line) },
    );
    for (let i = 0; i < 100 && !lines.some((l) => l.includes(' live at ')); i++) await sleep(50);
    quit();
    await running;
    return JSON.parse(readFileSync(log, 'utf8'));
  }

  it('names the output the helper reports, and closes the helper before the host starts', { timeout: 30_000 }, async () => {
    expect(await hostHandedFor()).toMatchObject({ device: 'Stub Out', helperClosed: true });
  });

  it('starts the host with no device when the helper cannot start', { timeout: 30_000 }, async () => {
    writeFileSync(join(dir, 'field-audiod'), '#!/usr/bin/env node\nprocess.exit(1);\n');
    expect(await hostHandedFor()).toMatchObject({ device: null });
  });

  // What a helper prints when macOS refuses it a MIDI client, for the first
  // `refusals` starts.
  const refusedHelper = (refusals: number): string => `#!/usr/bin/env node
const { appendFileSync, existsSync, readFileSync } = require('node:fs');
const starts = ${JSON.stringify(join(dir, 'helper-starts'))};
const before = existsSync(starts) ? readFileSync(starts, 'utf8').length : 0;
appendFileSync(starts, '.');
if (before < ${refusals}) {
  console.log(JSON.stringify({ error: 'cannot create a virtual MIDI source named ' + process.argv[3] + ' on this system' }));
  process.exit(1);
}
${HELPER_STUB.replace('#!/usr/bin/env node\n', '')}`;

  it('starts a new helper when macOS refuses one a MIDI client, and names the output', { timeout: 30_000 }, async () => {
    writeFileSync(join(dir, 'field-audiod'), refusedHelper(1));
    expect(await hostHandedFor('darwin')).toMatchObject({ device: 'Stub Out', helperClosed: true });
    expect(readFileSync(join(dir, 'helper-starts'), 'utf8')).toBe('..');
  });

  it('stops with the error and what to do rather than start the host with no device when macOS refuses a new helper too', { timeout: 30_000 }, async () => {
    writeFileSync(join(dir, 'field-audiod'), refusedHelper(2));
    await expect(
      scVoice(['./pad.scd'], { source: [] }, { cwd: dir, env: { ...process.env, FIELD_SCLANG: join(dir, 'sclang'), STUB_LOG: join(dir, 'host.json') }, platform: 'darwin', print: () => {} }),
    ).rejects.toThrow('cannot create a virtual MIDI source named Field Voice on this system: run the command again, or name the output with --device');
    expect(existsSync(join(dir, 'host.json'))).toBe(false);
  });
});

// `field sc notes` (sequencer.md §2.8) through real sclang.
describe('field sc notes', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'field-sc-notes-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const program = (name: string, notes: string): string => {
    const path = join(dir, name);
    writeFileSync(path, `if ("FIELD_MODE".getenv == "notes") {\n\t${notes}\n} {\n\t0.exit\n}\n`);
    return path;
  };

  it('refuses a program that is not there before it starts sclang', async () => {
    await expect(scNotes(join(dir, 'missing.scd'), { seed: 1, beats: 4 })).rejects.toThrow(`no program at ${join(dir, 'missing.scd')}`);
  });

  describe.skipIf(sclang === undefined)('through real sclang', () => {
    it('writes the same bytes for the same seed, as a formatted part the notes schema takes', { timeout: 60_000 }, async () => {
      const groove = program(
        'groove.scd',
        'Pbind(\\midinote, Pseq([36, Prand([43, 46, 48], 1)], inf), \\dur, 0.5, \\amp, Pwhite(0.5, 0.9))',
      );
      const first = await scNotes(groove, { seed: 4, beats: 8 });
      expect(await scNotes(groove, { seed: 4, beats: 8 })).toBe(first);
      expect(await scNotes(groove, { seed: 5, beats: 8 })).not.toBe(first);
      expect(first.split('\n')[0]).toBe(`# field sc notes ${groove} --seed 4 --beats 8`);
      const part = notesFileSchema.parse(parse(first));
      expect(part.length).toBe(8 * 960);
      expect(part.notes).toHaveLength(16);
      // field check finds it formatted, so it goes into songs/<song>/notes/ as is.
      expect(canonicalText(first, notesFileOrder)).toBe(first);
    });

    it('writes each note of a chord, its channel, its length, and its velocity from amp, and stops at the last beat', { timeout: 60_000 }, async () => {
      const chords = program(
        'chords.scd',
        'Pbind(\\midinote, Pseq([60, [64, 67], Rest(), 72], 1), \\dur, Pseq([0.5, 1, 0.5, 4], 1), \\legato, 1, \\amp, Pseq([1, 0.5, 0.5, 0.25], 1), \\chan, Pseq([0, 1, 0, 0], 1))',
      );
      expect(await scNotes(chords, { seed: 1, beats: 3 })).toBe(
        [
          `# field sc notes ${chords} --seed 1 --beats 3`,
          'length: 2880',
          'notes:',
          '  - {at: 0, length: 480, note: 60, velocity: 127}',
          '  - {at: 480, length: 960, note: 64, velocity: 64, channel: 2}',
          '  - {at: 480, length: 960, note: 67, velocity: 64, channel: 2}',
          '  - {at: 1920, length: 3840, note: 72, velocity: 32}',
          'controls: []',
          'bends: []',
          '',
        ].join('\n'),
      );
    });

    it('reads the pitch a pattern sounds, however it spells it', { timeout: 60_000 }, async () => {
      const pitches = async (name: string, notes: string): Promise<number[]> => {
        const part = notesFileSchema.parse(parse(await scNotes(program(name, notes), { seed: 1, beats: 2 })));
        return part.notes.map((n) => n.note as number);
      };
      expect(await pitches('freq.scd', 'Pbind(\\freq, Pseq([440, 880], 1), \\dur, 0.5)')).toEqual([69, 81]);
      expect(await pitches('ctranspose.scd', 'Pbind(\\note, 0, \\ctranspose, 12, \\dur, 2)')).toEqual([72]);
      expect(await pitches('harmonic.scd', 'Pbind(\\midinote, 60, \\harmonic, 2, \\dur, 2)')).toEqual([72]);
      expect(await pitches('chord.scd', 'Pbind(\\freq, [440, 880], \\dur, 2)')).toEqual([69, 81]);
    });

    it('says what went wrong in a pattern that fails while it plays, without waiting for the timeout', { timeout: 30_000 }, async () => {
      await expect(
        scNotes(program('fails.scd', 'Pbind(\\midinote, Pseq([60, Pfunc { nil.frobnicate }], 1), \\dur, 1)'), { seed: 1, beats: 4 }),
      ).rejects.toThrow(/fails\.scd's pattern failed at beat 1\.0: ERROR: Message 'frobnicate' not understood/);
    });

    it('refuses a negative dur, which would write a note before the part starts', { timeout: 60_000 }, async () => {
      await expect(
        scNotes(program('backward.scd', 'Pbind(\\midinote, 60, \\dur, Pseq([-1, 1, 1], 1))'), { seed: 1, beats: 4 }),
      ).rejects.toThrow("backward.scd's pattern has an event at beat 0 whose dur is -1");
    });

    it('says why a program that answers no pattern cannot write a part', { timeout: 60_000 }, async () => {
      await expect(scNotes(program('flat.scd', '42'), { seed: 1, beats: 4 })).rejects.toThrow(
        'flat.scd does not answer FIELD_MODE=notes: in notes mode its value must be a Pattern',
      );
      await expect(scNotes(program('high.scd', 'Pbind(\\midinote, 200)'), { seed: 1, beats: 1 })).rejects.toThrow(
        "the pattern plays note 200 at beat 0, outside MIDI's 0 to 127",
      );
    });
  });
});
