import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSong, createTrack } from '../commands/create.js';
import { init } from '../commands/init.js';
import { compileSession } from '../graph/live.js';
import { writeWavFloat32 } from '../audio/wav.js';
import { nrtScore, oscBundle, oscMessage, routeSynthDef, synthDefFile } from '../sc/voice/synthdef.js';
import { removeTempProject } from '../testing/temp.js';
import { AudiodClient, daemonBinary } from './client.js';

// The ring between FieldOut and the daemon (live-supercollider.md
// chunk 2): the daemon's own check of its reader against the writer
// FieldOut runs, the input ops, a session reading an open ring, and,
// where scsynth and the built plugin are here, FieldOut itself writing
// into a ring the daemon made.

const binary = (() => {
  try {
    return daemonBinary();
  } catch {
    return undefined;
  }
})();

const execFileAsync = promisify(execFile);
const repo = join(dirname(fileURLToPath(import.meta.url)), '../..');
const fieldOutDir = join(repo, 'native/sc-fieldout/build/plugins');
const fieldOutBuilt = ['FieldOut.scx', 'FieldOut.so'].some((name) => existsSync(join(fieldOutDir, name)));
const scsynth = [
  {
    bin: '/Applications/SuperCollider.app/Contents/Resources/scsynth',
    plugins: '/Applications/SuperCollider.app/Contents/Resources/plugins',
  },
  { bin: '/usr/bin/scsynth', plugins: '/usr/lib/SuperCollider/plugins' },
  { bin: '/usr/local/bin/scsynth', plugins: '/usr/local/lib/SuperCollider/plugins' },
].find((c) => existsSync(c.bin) && existsSync(c.plugins));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// A song whose voice has nothing on it, under a main of one bar: the
// shape an input window goes on.
function scaffold(root: string): void {
  init({ dir: root, name: 'live-ring' });
  createSong(root, 'monitor');
  createTrack(root, 'monitor', 'voice');
  writeFileSync(join(root, 'songs/monitor/tracks/voice.yaml'), 'name: voice\ninputs: []\n');
  writeFileSync(join(root, 'songs/monitor/tracks/main.yaml'), 'name: main\ninputs:\n  - track: voice\n');
  writeFileSync(
    join(root, 'songs/monitor/song.yaml'),
    'name: monitor\ntime:\n  tempo:\n    - at: 0\n      bpm: 120\n  meter:\n    - at: 0\n      numerator: 4\n      denominator: 4\nlength: [1]\n',
  );
}

describe.skipIf(!binary || process.platform === 'win32')('the live input ring (live-supercollider.md chunk 2)', () => {
  let root: string;
  let client: AudiodClient | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'field-live-ring-'));
  });
  afterEach(async () => {
    if (client !== undefined) {
      try {
        await client.quit();
      } catch {
        // already gone
      }
      client.close();
      client = undefined;
    }
    await removeTempProject(root);
  });

  it("holds the reader to the writer FieldOut runs: steady, through a gap, against a fast writer, and with nothing reading", async () => {
    const { stdout } = await execFileAsync(binary!, ['--ring-selftest']);
    expect(JSON.parse(stdout)).toEqual({ ok: true });
  });

  it('refuses --ring-feed with a ring that is not a number, rather than starting a daemon', async () => {
    const failed = await execFileAsync(binary!, ['--ring-feed', 'abc', 'take.wav']).then(
      () => '',
      (err: { code?: number; stderr?: string }) => `${err.code} ${err.stderr ?? ''}`,
    );
    expect(failed).toMatch(/^2 .*--ring-feed wants a ring number, not "abc"/);
  });

  it('opens and closes an input, reports it in status, and refuses what it cannot do', async () => {
    client = await AudiodClient.connect(root, { nullOutput: true, idleSeconds: 60 });
    expect(client.supports('live-input')).toBe(true);
    const opened = await client.openInput('mic');
    expect(opened).toMatchObject({ name: 'mic', capacity: 8192, channels: 2, sample_rate: 48000 });
    expect(opened.ring).toBeGreaterThan(0);
    expect(opened.ring).toBeLessThan(2 ** 24);
    await expect(client.openInput('mic')).rejects.toThrow('input "mic" is already open');
    await expect(client.openInput('')).rejects.toThrow('input needs a name');
    expect((await client.status()).inputs).toEqual([
      { name: 'mic', ring: opened.ring, written: 0, read: 0, dropped: 0, underruns: 0, skipped: 0, peak: 0 },
    ]);
    await client.closeInput('mic');
    expect((await client.status()).inputs).toBeUndefined();
    await expect(client.closeInput('mic')).rejects.toThrow('no input named "mic"');
  });

  it('closes an input when the connection that opened it drops', async () => {
    client = await AudiodClient.connect(root, { nullOutput: true, idleSeconds: 60 });
    // A second connection opens it, as `field keys` does, and goes away
    // without closing it, as a killed `field keys` would.
    const owner = await AudiodClient.connect(root, { nullOutput: true, idleSeconds: 60 });
    await owner.openInput('keys:creek/bass');
    expect((await client.status()).inputs).toHaveLength(1);
    owner.close();
    let inputs = (await client.status()).inputs;
    for (let i = 0; i < 40 && inputs !== undefined; i++) {
      await sleep(100);
      inputs = (await client.status()).inputs;
    }
    expect(inputs).toBeUndefined();
  });

  it('loads a session whose input window names an open input, and refuses one that names none', async () => {
    scaffold(root);
    const { session } = await compileSession(root, 'monitor', { inputs: [{ track: 'voice', input: 'mic' }] });
    client = await AudiodClient.connect(root, { nullOutput: true, idleSeconds: 60 });
    await expect(client.session(session)).rejects.toThrow('session names input "mic", which nothing feeds');
    await client.openInput('mic');
    await client.session(session);
    await client.play();
    await sleep(300);
    const playing = await client.status();
    expect(playing.state).toBe('playing');
    // Nothing writes the ring, so the reader waits to fill and never
    // runs dry.
    expect(playing.inputs).toEqual([expect.objectContaining({ name: 'mic', read: 0, underruns: 0 })]);
    // The session still holds the ring, so closing it frees only the name.
    await client.closeInput('mic');
    expect((await client.status()).state).toBe('playing');
  });

  it('plays an input while the transport is stopped (live-supercollider.md §7 question 2)', { timeout: 20_000 }, async () => {
    scaffold(root);
    client = await AudiodClient.connect(root, { nullOutput: true, idleSeconds: 60 });
    const { ring } = await client.openInput('mic');
    const { session } = await compileSession(root, 'monitor', { inputs: [{ track: 'voice', input: 'mic' }] });
    await client.session(session);
    // Half a second of a sine into the ring at its own pace, as FieldOut
    // writes, with nothing playing.
    const tone = new Float32Array(24000).map((_, i) => 0.25 * Math.sin((2 * Math.PI * 440 * i) / 48000));
    writeWavFloat32(join(root, 'tone.wav'), 48000, [tone, tone]);
    await execFileAsync(binary!, ['--ring-feed', String(ring), 'tone.wav'], { cwd: root });
    const status = await client.status();
    expect(status.state).toBe('stopped');
    const fed = status.inputs![0]!;
    expect(fed.written).toBe(24000);
    expect(fed.dropped).toBe(0);
    // The idle path read it as it came, keeping at most its block and
    // margin in hand, and heard the sine's level.
    expect(fed.read).toBeGreaterThan(24000 - 2048);
    expect(fed.peak).toBeCloseTo(0.25, 2);
  });

  it.skipIf(!scsynth || !fieldOutBuilt)(
    'the route the voice host plays through carries a bus into the ring through FieldOut',
    { timeout: 30_000 },
    async () => {
      client = await AudiodClient.connect(root, { nullOutput: true, idleSeconds: 60 });
      const { ring, capacity } = await client.openInput('mic');
      // A sine on private bus 20, where the voice host's voices play, and
      // the route at the tail reading it into the ring.
      const tone = synthDefFile({
        name: 'field-bus-tone',
        params: [],
        ugens: [
          { name: 'SinOsc', rate: 'audio', inputs: [{ constant: 440 }, { constant: 0 }], outputs: ['audio'] },
          { name: 'BinaryOpUGen', rate: 'audio', special: 2, inputs: [{ ugen: 0 }, { constant: 0.25 }], outputs: ['audio'] },
          { name: 'Out', rate: 'audio', inputs: [{ constant: 20 }, { ugen: 1 }, { ugen: 1 }], outputs: [] },
        ],
      });
      writeFileSync(
        join(root, 'score.osc'),
        nrtScore([
          oscBundle(0, [
            oscMessage('/d_recv', tone),
            oscMessage('/d_recv', routeSynthDef()),
            oscMessage('/s_new', 'field-bus-tone', 1000, 0, 0),
            oscMessage('/s_new', 'field-route', 1001, 1, 0, 'in', { float: 20 }, 'ring', { float: ring }),
          ]),
          oscBundle(1, [oscMessage('/n_free', 1000), oscMessage('/n_free', 1001), oscMessage('/c_set', 0, 0)]),
        ]),
      );
      const { stdout } = await execFileAsync(
        scsynth!.bin,
        ['-N', 'score.osc', '_', 'out.aiff', '48000', 'AIFF', 'int16', '-o', '2', '-U', `${scsynth!.plugins}:${fieldOutDir}`],
        { cwd: root },
      );
      expect(stdout).not.toContain('FieldOut: ring');
      expect((await client.status()).inputs![0]).toMatchObject({ written: capacity, dropped: 48000 - capacity });
    },
  );

  it.skipIf(!scsynth || !fieldOutBuilt)(
    'FieldOut writes into the ring the daemon made, and a playing session reads it',
    { timeout: 30_000 },
    async () => {
      scaffold(root);
      client = await AudiodClient.connect(root, { nullOutput: true, idleSeconds: 60 });
      const { ring, capacity } = await client.openInput('mic');

      // A second of a sine at 440 Hz into FieldOut, in scsynth's
      // non-realtime mode: nothing reads while it renders, so the ring
      // fills and the rest counts as dropped.
      const def = synthDefFile({
        name: 'field-ring-test',
        params: [{ name: 'ring', value: 0 }],
        ugens: [
          { name: 'Control', rate: 'control', inputs: [], outputs: ['control'] },
          { name: 'SinOsc', rate: 'audio', inputs: [{ constant: 440 }, { constant: 0 }], outputs: ['audio'] },
          { name: 'BinaryOpUGen', rate: 'audio', special: 2, inputs: [{ ugen: 1 }, { constant: 0.25 }], outputs: ['audio'] },
          { name: 'FieldOut', rate: 'audio', inputs: [{ ugen: 0 }, { ugen: 2 }, { ugen: 2 }], outputs: [] },
        ],
      });
      writeFileSync(
        join(root, 'score.osc'),
        nrtScore([
          oscBundle(0, [
            oscMessage('/d_recv', def),
            oscMessage('/s_new', 'field-ring-test', 1000, 0, 0, 'ring', { float: ring }),
          ]),
          // Freed before the score ends: at shutdown scsynth unloads its
          // plugins before it frees the synths still running, so a
          // FieldOut left running would call a destructor that is gone.
          oscBundle(1, [oscMessage('/n_free', 1000), oscMessage('/c_set', 0, 0)]),
        ]),
      );
      const { stdout } = await execFileAsync(
        scsynth!.bin,
        ['-N', 'score.osc', '_', 'out.aiff', '48000', 'AIFF', 'int16', '-o', '2', '-U', `${scsynth!.plugins}:${fieldOutDir}`],
        { cwd: root },
      );
      expect(stdout).not.toContain('FieldOut: ring');
      const filled = (await client.status()).inputs![0]!;
      expect(filled).toMatchObject({ written: capacity, dropped: 48000 - capacity, read: 0 });

      // Played, the session's input window reads it. The ring filled and
      // FieldOut dropped what did not fit, so what it holds is the past:
      // the reader skips all of it and starts at the present.
      const { session } = await compileSession(root, 'monitor', { inputs: [{ track: 'voice', input: 'mic' }] });
      await client.session(session);
      await client.play();
      let read = filled;
      for (let i = 0; i < 40 && read.read < capacity; i++) {
        await sleep(100);
        read = (await client.status()).inputs![0]!;
      }
      expect(read.read).toBe(capacity);
      expect(read.skipped).toBe(capacity);
      expect(read.underruns).toBe(0);
    },
  );
});
