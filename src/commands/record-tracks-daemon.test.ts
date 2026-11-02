import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { afterEach, beforeEach, describe, expect, it, type TestContext } from 'vitest';
import { readWav, writeWavFloat32 } from '../audio/wav.js';
import { AudiodClient, daemonBinary } from '../audiod/client.js';
import { midiTakeLineSchema, midiTakeSchema, takeSchema, type AnyTake, type AudiodEvent } from '../audiod/protocol.js';
import { compileSession } from '../graph/live.js';
import { check } from './check.js';
import { createSong, createTrack } from './create.js';
import { importAsset } from './import.js';
import { init } from './init.js';
import { recordTake } from './record.js';
import { loadProject } from '../model/project.js';
import { removeTempProject } from '../testing/temp.js';
import { transportStatusLines } from './transport.js';

// Several armed tracks in one pass (arming.md §2.2), against the daemon in
// null-output mode. Its null input presents channel 1 as a sawtooth and
// channel 2 as a constant 0.25, so a take can show which input it holds.
// MIDI cases publish a source with `field-audiod --keys`, as
// record-midi-daemon.test.ts does, and skip where Linux has no ALSA
// sequencer and on Windows, which has no virtual MIDI ports.

const binary = (() => {
  try {
    return daemonBinary();
  } catch {
    return undefined;
  }
})();

const NOTE = 1 + ((process.pid + 7) % 120);
const NOTE_ON = [0x9f, NOTE, 77];
const NOTE_OFF = [0x8f, NOTE, 0];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe.skipIf(!binary)('several armed tracks through the daemon', () => {
  let root: string;
  let client: AudiodClient | undefined;
  const helpers: ChildProcessWithoutNullStreams[] = [];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'field-record-tracks-'));
  });

  afterEach(async () => {
    for (const helper of helpers.splice(0)) helper.kill('SIGKILL');
    if (client !== undefined) {
      const pid = client.pid;
      client.close();
      client = undefined;
      try {
        if (pid !== undefined) process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
    // Windows refuses to delete what the dying daemon still holds.
    await removeTempProject(root);
  });

  async function connect(): Promise<AudiodClient> {
    client = await AudiodClient.connect(root, { nullOutput: true });
    return client;
  }

  // Publishes a MIDI source and resolves once it is ready, or skips the
  // test where there is no virtual MIDI source to publish: Linux with no
  // ALSA sequencer, and Windows by design. CoreMIDI can refuse a new source
  // for a moment after another test's helper died, so a refusal on macOS
  // is tried again, as record-midi-daemon.test.ts does.
  async function publish(ctx: TestContext, name: string, retries = 4): Promise<ChildProcessWithoutNullStreams> {
    const helper = spawn(binary!, ['--keys', name], { stdio: 'pipe' });
    helpers.push(helper);
    helper.stdin.on('error', () => {});
    const line = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('--keys was not ready in 5 s')), 5000);
      createInterface({ input: helper.stdout }).on('line', (text) => {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        if ('keyboard' in parsed) return;
        clearTimeout(timer);
        resolve(parsed);
      });
    });
    if ('error' in line) {
      if (process.platform === 'linux' && !existsSync('/dev/snd/seq')) ctx.skip('no ALSA sequencer');
      if (process.platform === 'win32') ctx.skip('no virtual MIDI ports on Windows');
      if (process.platform === 'darwin' && retries > 0) {
        await sleep(250);
        return publish(ctx, name, retries - 1);
      }
      throw new Error(`--keys refused: ${JSON.stringify(line)}`);
    }
    return helper;
  }

  const send = (helper: ChildProcessWithoutNullStreams, bytes: number[]): void => {
    helper.stdin.write(`${JSON.stringify({ midi: bytes })}\n`);
  };

  // Arms until a published source is among the arm's, which takes a
  // moment to reach another process.
  async function armUntilListed(daemon: AudiodClient, tracks: Parameters<AudiodClient['armTracks']>[0], source: string) {
    for (let i = 0; i < 50; i++) {
      const armed = await daemon.armTracks(tracks);
      if (armed.sources?.includes(source)) return armed;
      await sleep(100);
    }
    throw new Error(`${source} never appeared among the MIDI sources`);
  }

  const mine = (file: string): number[][] =>
    readFileSync(join(root, file), 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => midiTakeLineSchema.parse(JSON.parse(line)).midi)
      .filter((midi) => (midi[0]! & 0x0f) === 0x0f && midi[1] === NOTE);

  it('records two audio tracks on their own inputs in one pass, and refuses what it cannot do', { timeout: 20_000 }, async () => {
    const daemon = await connect();
    expect(daemon.supports('record-tracks')).toBe(true);
    await expect(
      daemon.armTracks([
        { track: '//songs/creek/track:a', kind: 'audio', input: 1 },
        { track: '//songs/creek/track:b', kind: 'audio', input: 1 },
      ]),
    ).rejects.toThrow('input 1 is armed for two tracks');
    await expect(
      daemon.armTracks([
        { track: '//songs/creek/track:a', kind: 'audio', input: 1 },
        { track: '//songs/creek/track:a', kind: 'audio', input: 2 },
      ]),
    ).rejects.toThrow('//songs/creek/track:a is armed twice');

    const armed = await daemon.armTracks([
      { track: '//songs/creek/track:a', kind: 'audio', input: 1 },
      { track: '//songs/creek/track:b', kind: 'audio', input: 2 },
    ]);
    expect(armed).toMatchObject({
      device: 'null',
      armed: [
        { track: '//songs/creek/track:a', kind: 'audio', input: 1 },
        { track: '//songs/creek/track:b', kind: 'audio', input: 2 },
      ],
    });
    // A set the daemon refuses, here for an input the null device lacks
    // or for the MIDI it cannot open, leaves the arm before it as it was.
    await expect(
      daemon.armTracks([
        { track: '//songs/creek/track:c', kind: 'audio', input: 3 },
        { track: '//songs/creek/track:keys', kind: 'midi' },
      ]),
    ).rejects.toThrow(/the null input has 2 channels|no MIDI sources|cannot open any MIDI source/);
    const kept = (await daemon.status()).record!;
    expect(kept.state).toBe('armed');
    expect(kept.sources).toBeUndefined();
    expect(kept.armed?.map((a) => [a.track, a.kind, a.input])).toEqual([
      ['//songs/creek/track:a', 'audio', 1],
      ['//songs/creek/track:b', 'audio', 2],
    ]);
    await expect(daemon.record(0, undefined, 24000, true)).rejects.toThrow('a loop take records one track');

    const events: AudiodEvent[] = [];
    daemon.on('event', (e: AudiodEvent) => events.push(e));
    const started = await daemon.record();
    expect(started.takes?.map((t) => t.track)).toEqual(['//songs/creek/track:a', '//songs/creek/track:b']);
    await sleep(400);
    const status = (await daemon.status()).record!;
    expect(status.armed?.map((a) => [a.track, a.kind, a.input])).toEqual([
      ['//songs/creek/track:a', 'audio', 1],
      ['//songs/creek/track:b', 'audio', 2],
    ]);
    expect(status.armed?.every((a) => a.transaction !== undefined && (a.frames ?? 0) > 0)).toBe(true);

    const stopped = await daemon.stop();
    const takes = (stopped.takes ?? []).map((t) => takeSchema.parse(t));
    expect(takes.map((t) => t.track)).toEqual(['//songs/creek/track:a', '//songs/creek/track:b']);
    expect(takes.map((t) => t.input)).toEqual([1, 2]);
    expect(takes[1]!.started_at_samples).toBe(takes[0]!.started_at_samples);
    expect(takes[1]!.frames).toBe(takes[0]!.frames);
    // Input 1 is the sawtooth, rising 2/48000 a sample; input 2 the constant.
    const saw = readWav(join(root, takes[0]!.file)).channels[0]!;
    const flat = readWav(join(root, takes[1]!.file)).channels[0]!;
    expect(Math.abs(saw[11]! - saw[10]! - 2 / 48000)).toBeLessThan(1e-6);
    expect(flat.every((sample) => sample === 0.25)).toBe(true);
    for (let i = 0; i < 20 && events.filter((e) => e.event === 'take').length < 2; i++) await sleep(50);
    expect(events.filter((e) => e.event === 'take').map((e) => (e.event === 'take' ? e.take.id : ''))).toEqual(
      takes.map((t) => t.id),
    );
  });

  it('records an audio track and a MIDI track in one pass', { timeout: 20_000 }, async (ctx) => {
    const source = `Field Keys Tracks ${process.pid} mixed`;
    const keys = await publish(ctx, source);
    const daemon = await connect();
    await armUntilListed(
      daemon,
      [
        { track: '//songs/creek/track:keys', kind: 'midi' },
        { track: '//songs/creek/track:vox', kind: 'audio', input: 1 },
      ],
      source,
    );
    // An audio track is the primary whenever one is armed.
    expect((await daemon.status()).record?.armed?.map((a) => a.track)).toEqual([
      '//songs/creek/track:vox',
      '//songs/creek/track:keys',
    ]);
    await daemon.record();
    send(keys, NOTE_ON);
    await sleep(300);
    send(keys, NOTE_OFF);
    await sleep(300);
    const stopped = await daemon.stop();
    const takes: AnyTake[] = stopped.takes ?? [];
    expect(takes.map((t) => t.track)).toEqual(['//songs/creek/track:vox', '//songs/creek/track:keys']);
    const audio = takeSchema.parse(takes[0]);
    const midi = midiTakeSchema.parse(takes[1]);
    expect(midi.started_at_samples).toBe(audio.started_at_samples);
    expect(mine(midi.file)).toEqual([NOTE_ON, NOTE_OFF]);
  });

  it('ends an audio and a MIDI take together at until, the MIDI a block later', { timeout: 20_000 }, async (ctx) => {
    const source = `Field Keys Tracks ${process.pid} until`;
    const keys = await publish(ctx, source);
    // A live session as the bed, as the punch-out tests use: a file bed's
    // reported position runs a few samples ahead of what it delivered.
    init({ dir: root, name: 'tracks' });
    createSong(root, 'creek');
    const src = join(root, '..', `field-tracks-bed-${process.pid}.wav`);
    writeWavFloat32(src, 48000, [new Float32Array(48000 * 5)]);
    await importAsset(root, 'creek', src, 'bed');
    rmSync(src);
    writeFileSync(
      join(root, 'songs/creek/tracks/main.yaml'),
      ['name: main', 'inputs:', '  - audio: bed', '    anchor: absolute', '    at: 0', ''].join('\n'),
    );
    const daemon = await connect();
    await daemon.session((await compileSession(root, 'creek')).session);
    await armUntilListed(
      daemon,
      [
        { track: '//songs/creek/track:vox', kind: 'audio', input: 2 },
        { track: '//songs/creek/track:keys', kind: 'midi' },
      ],
      source,
    );
    const events: AudiodEvent[] = [];
    daemon.on('event', (e: AudiodEvent) => events.push(e));
    await daemon.record(0, undefined, 24000);
    send(keys, NOTE_ON);
    for (let i = 0; i < 60 && events.filter((e) => e.event === 'take').length < 2; i++) await sleep(50);
    const takes = events.flatMap((e) => (e.event === 'take' ? [e.take] : []));
    expect(takes.map((t) => t.track)).toEqual(['//songs/creek/track:vox', '//songs/creek/track:keys']);
    const audio = takeSchema.parse(takes[0]);
    const midi = midiTakeSchema.parse(takes[1]);
    expect(audio).toMatchObject({ started_at_samples: 0, frames: 24000 });
    expect(midi).toMatchObject({ started_at_samples: 0, frames: 24000 });
    expect(readWav(join(root, audio.file)).channels[0]!.length).toBe(24000);
    expect(mine(midi.file)).toEqual([NOTE_ON]);
    expect((await daemon.status()).state).toBe('playing'); // the bed played on
    await daemon.stop();
  });

  it('records the same notes into every armed MIDI track', { timeout: 20_000 }, async (ctx) => {
    const source = `Field Keys Tracks ${process.pid} unison`;
    const keys = await publish(ctx, source);
    const daemon = await connect();
    await armUntilListed(
      daemon,
      [
        { track: '//songs/creek/track:keys', kind: 'midi' },
        { track: '//songs/creek/track:bass', kind: 'midi' },
      ],
      source,
    );
    await daemon.record();
    send(keys, NOTE_ON);
    await sleep(300);
    send(keys, NOTE_OFF);
    await sleep(300);
    const stopped = await daemon.stop();
    const takes = (stopped.takes ?? []).map((t) => midiTakeSchema.parse(t));
    expect(takes.map((t) => t.track)).toEqual(['//songs/creek/track:keys', '//songs/creek/track:bass']);
    expect(takes[1]!.started_at_samples).toBe(takes[0]!.started_at_samples);
    expect(mine(takes[0]!.file)).toEqual([NOTE_ON, NOTE_OFF]);
    expect(mine(takes[1]!.file)).toEqual([NOTE_ON, NOTE_OFF]);
  });

  it('field record: records an audio track and a MIDI track in one pass and lands both', { timeout: 30_000 }, async (ctx) => {
    const source = `Field Keys Tracks ${process.pid} record`;
    const keys = await publish(ctx, source);
    process.env['FIELD_AUDIOD_NULL'] = '1';
    try {
      init({ dir: root, name: 'tracks' });
      createSong(root, 'creek');
      const src = join(root, '..', `field-tracks-tone-${process.pid}.wav`);
      writeWavFloat32(src, 48000, [new Float32Array(48000 * 6).fill(0.1)]);
      await importAsset(root, 'creek', src, 'tone');
      rmSync(src);
      createTrack(root, 'creek', 'vox');
      createTrack(root, 'creek', 'keys');
      writeFileSync(join(root, 'shared/instruments/pad.scd'), '// a voice\n');
      writeFileSync(join(root, 'songs/creek/tracks/vox.yaml'), 'name: vox\ninputs:\n  - record:\n');
      writeFileSync(join(root, 'songs/creek/tracks/keys.yaml'), 'name: keys\ninstrument: pad\ninputs:\n  - record:\n');
      writeFileSync(
        join(root, 'songs/creek/tracks/main.yaml'),
        ['name: main', 'inputs:', '  - audio: tone', '    anchor: absolute', '    at: 0', ''].join('\n'),
      );
      // The source must be in the daemon's list before field record arms.
      const daemon = await connect();
      await armUntilListed(daemon, [{ track: '//songs/creek/track:keys', kind: 'midi' }], source);
      await daemon.disarm();

      const lines: string[] = [];
      let played = false;
      // A second terminal's `field transport status` names every armed
      // track; the take runs until it has been read.
      const project = loadProject(root);
      let transportLines: string[] | undefined;
      const { takes } = await recordTake(
        root,
        project,
        ['creek/track:vox', 'creek/track:keys'],
        { at: '1.2.1' },
        {
          onArmed: (line) => lines.push(line),
          onStarted: (line) => {
            lines.push(line);
            send(keys, NOTE_ON);
            void transportStatusLines(root, project).then((l) => (transportLines = l));
            void sleep(300).then(() => {
              send(keys, NOTE_OFF);
              played = true;
            });
          },
          onPosition: (line) => lines.push(line),
          interrupted: () => played && transportLines !== undefined,
        },
      );
      expect(transportLines!.find((l) => l.startsWith('recording: '))).toMatch(
        new RegExp(
          `^recording: take-\\S+( \\(\\d+ frames\\))? on null input 1 → //songs/creek/track:vox, ` +
            `MIDI from .*${source}.* → //songs/creek/track:keys$`,
        ),
      );
      expect(lines[0]).toMatch(new RegExp(`^armed {3}vox: null input 1, keys: MIDI from .*${source}.* {2}\\(48000 Hz, latency in 0 / out 0 samples\\)$`));
      expect(lines.some((line) => / vox (silent|▮).* · keys \d+ events? /.test(line))).toBe(true);
      expect(takes.map((t) => t.landed.file)).toEqual([
        `audio/vox/${takes[0]!.take.id}.wav`,
        `audio/keys/${takes[1]!.take.id}.notes.yaml`,
      ]);
      expect(takes[1]!.landed.row.started_at_samples).toBe(takes[0]!.landed.row.started_at_samples);
      expect(readFileSync(join(root, 'songs/creek', takes[1]!.landed.file), 'utf8')).toMatch(
        new RegExp(`note: ${NOTE}, velocity: 77, channel: 16`),
      );
      expect((await check(root)).diagnostics).toEqual([]);
    } finally {
      delete process.env['FIELD_AUDIOD_NULL'];
    }
  });
});
