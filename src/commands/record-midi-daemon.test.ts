import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createInterface } from 'node:readline';
import { afterEach, beforeEach, describe, expect, it, type TestContext } from 'vitest';
import { writeWavFloat32 } from '../audio/wav.js';
import { AudiodClient, daemonBinary } from '../audiod/client.js';
import { midiTakeLineSchema, midiTakeSchema, type AudiodEvent, type ChasedController, type MidiTakeLine } from '../audiod/protocol.js';
import { publishControllers } from '../keys/published.js';
import { loadProject } from '../model/project.js';
import { check } from './check.js';
import { createSong, createTrack } from './create.js';
import { importAsset } from './import.js';
import { init } from './init.js';
import { recordTake } from './record.js';
import { removeTempProject } from '../testing/temp.js';

// MIDI takes (keyboard-instrument.md §12.4) against the real daemon in
// null-output mode, with `field-audiod --keys` publishing the source
// they record. The probe for a MIDI service is `--keys` itself, as in
// src/keys/helper-native.test.ts: only a Linux machine without the ALSA
// sequencer may skip, and there the source list is reliably empty, so
// that is where arming with no source is refused.
//
// Arming for MIDI opens every source on the machine, so a controller or
// another test's helper can add messages to a take. The messages these
// tests send are on channel 16, on a note chosen by this run's pid, so
// two runs on one machine do not read each other's, and the
// assertions about order and timing read those lines.

const binary = (() => {
  try {
    return daemonBinary();
  } catch {
    return undefined;
  }
})();

const NULL_RATE = 48000;
const NOTE = 1 + (process.pid % 120);
const NOTE_ON = [0x9f, NOTE, 77];
const NOTE_OFF = [0x8f, NOTE, 0];
const BLOCK_SLACK = 2048; // the null clock's 512-frame blocks, and scheduling
const TRACK = '//songs/creek/track:keys';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => Promise<boolean> | boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

interface Helper {
  child: ChildProcessWithoutNullStreams;
  lines: string[];
  stderr: string;
  ended: boolean;
  closed: Promise<void>;
}

function isMine(line: MidiTakeLine): boolean {
  return (line.midi[0]! & 0x0f) === 0x0f && line.midi[1] === NOTE;
}

function readLines(root: string, file: string): MidiTakeLine[] {
  const text = readFileSync(join(root, file), 'utf8');
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => midiTakeLineSchema.parse(JSON.parse(line)));
}

describe.skipIf(!binary)('MIDI takes through the daemon', () => {
  let root: string;
  const helpers: Helper[] = [];
  const daemons: number[] = [];
  const source = (what: string) => `Field Keys Capture ${process.pid} ${what}`;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'field-record-midi-'));
  });

  // Every helper and daemon these tests started dies here, whatever the
  // test did, and only those.
  afterEach(async () => {
    const left = helpers.splice(0);
    for (const helper of left) if (!helper.ended) helper.child.kill('SIGKILL');
    await Promise.all(left.map((helper) => helper.closed));
    for (const pid of daemons.splice(0)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
    // A killed daemon on Windows holds the project as its cwd until it
    // has exited, and rmSync is refused until then.
    await removeTempProject(root);
  });

  async function connect(): Promise<AudiodClient> {
    const client = await AudiodClient.connect(root, { nullOutput: true });
    daemons.push(client.pid!);
    return client;
  }

  // Publishes `name` with `--keys`. Resolves with the helper once it is
  // ready, or with why no source can be published, which only a Linux
  // machine without the ALSA sequencer, or Windows, may say; anywhere
  // else a helper that cannot publish fails the test.
  //
  // CoreMIDI on macOS can refuse a new source for a moment after this
  // file's earlier tests killed their helpers and daemons: run whole, the
  // last test's first publish was refused every time, and the same name
  // was accepted 500 ms later. Alone, it never was. So a refusal there
  // is tried again, for up to a second, before it fails the test.
  async function publish(name: string, retries = 4): Promise<{ helper: Helper } | { unavailable: string }> {
    const child = spawn(binary!, ['--keys', name], { stdio: 'pipe' });
    const helper: Helper = {
      child,
      lines: [],
      stderr: '',
      ended: false,
      closed: new Promise((resolve) => child.on('close', () => resolve())),
    };
    child.on('close', () => {
      helper.ended = true;
    });
    child.on('error', (error) => {
      helper.stderr += String(error);
    });
    child.stdin.on('error', () => {});
    child.stderr.on('data', (chunk) => {
      helper.stderr += String(chunk);
    });
    createInterface({ input: child.stdout }).on('line', (line) => helper.lines.push(line));
    helpers.push(helper);

    // On macOS a keyboard layout report comes first, and can come again.
    let index = 0;
    const deadline = Date.now() + 5000;
    for (;;) {
      if (helper.lines.length > index) {
        const line = JSON.parse(helper.lines[index++]!) as Record<string, unknown>;
        if ('keyboard' in line) continue;
        if ('error' in line && process.platform === 'linux' && !existsSync('/dev/snd/seq')) {
          return {
            unavailable:
              `no MIDI service: this Linux machine has no ALSA sequencer at /dev/snd/seq, ` +
              `and --keys said ${JSON.stringify(line['error'])}`,
          };
        }
        // Windows has no virtual MIDI ports for --keys to publish
        // (windows-portability.md §7.2), so the helper refuses there by
        // design and the take tests have no source to record.
        if ('error' in line && process.platform === 'win32') {
          return {
            unavailable: `no virtual MIDI ports on Windows, and --keys said ${JSON.stringify(line['error'])}`,
          };
        }
        if ('error' in line && process.platform === 'darwin' && retries > 0) {
          await helper.closed;
          await sleep(250);
          return publish(name, retries - 1);
        }
        expect(line).toMatchObject({ ready: true, name });
        return { helper };
      }
      if (helper.ended) throw new Error(`--keys exited before it was ready; stderr: ${helper.stderr}`);
      if (Date.now() > deadline) throw new Error(`--keys was not ready in 5 s; stderr: ${helper.stderr}`);
      await sleep(10);
    }
  }

  async function publishOrSkip(ctx: TestContext, name: string): Promise<Helper> {
    const published = await publish(name);
    if ('unavailable' in published) {
      console.warn(`skipping a MIDI take test: ${published.unavailable}`);
      ctx.skip(published.unavailable);
    }
    return (published as { helper: Helper }).helper;
  }

  function send(helper: Helper, bytes: number[]): number {
    helper.child.stdin.write(`${JSON.stringify({ midi: bytes })}\n`);
    return performance.now();
  }

  // A source another process publishes takes a moment to reach this
  // one's list, so arm until it is there.
  async function armListing(client: AudiodClient, name: string, controllers: ChasedController[] = []) {
    const deadline = Date.now() + 5000;
    for (;;) {
      const armed = await client.armMidi(TRACK, controllers);
      if (armed.sources.includes(name)) return armed;
      if (Date.now() > deadline) throw new Error(`${name} never appeared among ${armed.sources.join(', ')}`);
      await sleep(100);
    }
  }

  it('advertises record-midi and midi-chase', async () => {
    const client = await connect();
    try {
      expect(client.supports('record-midi')).toBe(true);
      expect(client.supports('midi-chase')).toBe(true);
    } finally {
      client.close();
    }
  });

  it('refuses controllers that are not {channel, cc, value} in range', async () => {
    const client = await connect();
    try {
      for (const bad of [
        { channel: 0, cc: 74, value: 1 },
        { channel: 1, cc: 120, value: 1 },
        { channel: 1, cc: 74, value: 128 },
      ]) {
        await expect(client.armMidi(TRACK, [bad])).rejects.toThrow(/arm's controllers are a list of \{channel, cc, value\}/);
      }
    } finally {
      client.close();
    }
  });

  it(
    'starts a take with the controllers seeded at the arm and sent before the start, in the order their values last arrived',
    { timeout: 20_000 },
    async (ctx) => {
      const name = source('chase');
      const keys = await publishOrSkip(ctx, name);
      const client = await connect();
      try {
        // Channels 15 and 16, on controllers with no assigned meaning, so
        // another source's controllers on the machine are told apart.
        await armListing(client, name, [
          { channel: 16, cc: 110, value: 10 },
          { channel: 16, cc: 111, value: 20 },
        ]);
        send(keys, [0xbe, 112, 30]);
        send(keys, [0xbf, 110, 40]); // replaces its seed
        send(keys, [0xbf, 120, 0]); // All Sound Off: acts once, never chased
        await sleep(300);
        const started = await client.record();
        await sleep(300);
        send(keys, [0xbf, 111, 50]);
        await waitFor(
          () => readLines(root, started.file).some((line) => line.midi[0] === 0xbf && line.midi[1] === 111 && line.midi[2] === 50),
          3000,
          'the controller sent after the start',
        );
        await client.stop();
        const mine = readLines(root, started.file).filter(
          (line) => (line.midi[0] === 0xbe || line.midi[0] === 0xbf) && line.midi[1]! >= 110 && line.midi[1]! <= 120,
        );
        expect(mine.filter((line) => line.at === 0).map((line) => line.midi)).toEqual([
          [0xbf, 111, 20],
          [0xbe, 112, 30],
          [0xbf, 110, 40],
        ]);
        const later = mine.filter((line) => line.at > 0);
        expect(later.map((line) => line.midi)).toEqual([[0xbf, 111, 50]]);
        expect(later[0]!.at).toBeGreaterThanOrEqual((300 * NULL_RATE) / 1000 - BLOCK_SLACK);
        // Every chased line comes before every other line of the take.
        const lines = readLines(root, started.file);
        const firstLater = lines.findIndex((line) => line.at > 0);
        expect(lines.slice(firstLater).some((line) => line.at === 0)).toBe(false);
      } finally {
        client.close();
      }
    },
  );

  it(
    'keeps a controller sent just before record, though record lands between a block\'s pull and its latch',
    { timeout: 30_000 },
    async (ctx) => {
      // The seam holds each block between its pull and its latch, so
      // record's request often lands there. That block does not start the
      // take, and what it drains arrived before the start, so it is chased.
      process.env['FIELD_AUDIOD_LATCH_STALL_MS'] = '8';
      try {
        const name = source('latch');
        const keys = await publishOrSkip(ctx, name);
        const client = await connect();
        try {
          // One arm for every take, because each arm opens every MIDI
          // source again, and re-arming before each take slowed CoreMIDI
          // enough that a later test's source was not published in 5 s.
          // The arm resets the chase table at the top of a later block, so
          // the controllers go out once that reset has passed.
          await armListing(client, name);
          await sleep(100);
          for (let value = 60; value < 70; value++) {
            send(keys, [0xbf, 113, value]);
            const started = await client.record();
            await sleep(100);
            await client.stop();
            const sent = readLines(root, started.file).filter(
              (line) => line.midi[0] === 0xbf && line.midi[1] === 113 && line.midi[2] === value,
            );
            expect(sent, `the controller sent before take ${value - 59}`).toHaveLength(1);
          }
        } finally {
          client.close();
        }
      } finally {
        delete process.env['FIELD_AUDIOD_LATCH_STALL_MS'];
      }
    },
  );

  it(
    'starts a second take on one arm where the first take left each controller',
    { timeout: 20_000 },
    async (ctx) => {
      const name = source('carry');
      const keys = await publishOrSkip(ctx, name);
      const client = await connect();
      try {
        // One arm for both takes, as a lasting arm would keep it.
        await armListing(client, name);
        await sleep(100);
        send(keys, [0xbf, 114, 20]);
        await sleep(100);
        const first = await client.record();
        await sleep(100);
        send(keys, [0xbf, 114, 50]);
        await waitFor(
          () => readLines(root, first.file).some((line) => line.at > 0 && line.midi[0] === 0xbf && line.midi[1] === 114),
          3000,
          'the controller sent during the first take',
        );
        await client.stop();
        const second = await client.record();
        await sleep(100);
        await client.stop();
        const chased = readLines(root, second.file).filter((line) => line.at === 0 && line.midi[0] === 0xbf && line.midi[1] === 114);
        expect(chased.map((line) => line.midi)).toEqual([[0xbf, 114, 50]]);
      } finally {
        client.close();
      }
    },
  );

  it(
    'records a source on the sample clock, with no audio fields, and finalizes on stop',
    { timeout: 20_000 },
    async (ctx) => {
      const name = source('take');
      const keys = await publishOrSkip(ctx, name);
      const client = await connect();
      const events: AudiodEvent[] = [];
      client.on('event', (e: AudiodEvent) => events.push(e));
      try {
        const armed = await armListing(client, name);
        expect(armed).toMatchObject({ ok: true, kind: 'midi', sample_rate: NULL_RATE, output_latency: 0 });
        expect((await client.status()).record).toEqual({
          state: 'armed',
          track: TRACK,
          kind: 'midi',
          sources: armed.sources,
          input_peak: 0,
        });

        const recordCalled = performance.now();
        const started = await client.record();
        const recordReturned = performance.now();
        expect(started.file).toBe(`.field/recording/${started.transaction}/take.midi.ndjson`);
        expect(started.started_at_samples).toBeGreaterThanOrEqual(0);

        await sleep(200);
        const onSent = send(keys, NOTE_ON);
        await sleep(500);
        const offSent = send(keys, NOTE_OFF);
        await waitFor(
          () => readLines(root, started.file).filter(isMine).length === 2,
          3000,
          'both messages to reach the file',
        );
        const mid = (await client.status()).record!;
        expect(mid).toMatchObject({ state: 'recording', kind: 'midi', input_peak: 0, pending: false, dropped: 0 });
        expect(mid.events).toBeGreaterThanOrEqual(2);
        expect(mid.frames).toBeGreaterThan(0);
        expect(mid.written).toBeUndefined();

        const stopCalled = performance.now();
        const stopped = await client.stop();
        const stopReturned = performance.now();
        const take = midiTakeSchema.parse(stopped.take);
        expect(take).toMatchObject({
          id: started.transaction,
          file: started.file,
          track: TRACK,
          kind: 'midi',
          sources: armed.sources,
          sample_rate: NULL_RATE,
          output_latency: 0,
          started_at_samples: started.started_at_samples,
          complete: true,
          dropped: 0,
        });
        expect(take.timeline_rate).toBeUndefined(); // no bed: a free-running take
        for (const audio of ['device', 'input', 'channels', 'bit_depth', 'format', 'input_latency']) {
          expect(stopped.take).not.toHaveProperty(audio);
        }
        // Samples from the latch, inside record, to the detach, inside stop.
        const ms = (from: number, to: number) => ((to - from) * NULL_RATE) / 1000;
        expect(take.frames).toBeGreaterThanOrEqual(ms(recordReturned, stopCalled) - BLOCK_SLACK);
        expect(take.frames).toBeLessThanOrEqual(ms(recordCalled, stopReturned) + BLOCK_SLACK);

        const lines = readLines(root, take.file);
        expect(take.events).toBe(lines.length);
        const ats = lines.map((line) => line.at);
        expect(ats).toEqual([...ats].sort((a, b) => a - b));
        expect(ats.every((at) => at < take.frames!)).toBe(true);
        const [on, off] = lines.filter(isMine);
        expect([on!.midi, off!.midi]).toEqual([NOTE_ON, NOTE_OFF]);
        // Each `at` is where the clock was when its message arrived:
        // the note-on lands where it was sent, counted from the take's
        // start, and the gap between the two is the half second slept.
        expect(on!.at).toBeGreaterThanOrEqual(ms(recordReturned, onSent) - BLOCK_SLACK);
        expect(on!.at).toBeLessThanOrEqual(ms(recordCalled, onSent) + BLOCK_SLACK);
        expect(off!.at - on!.at).toBeGreaterThanOrEqual(24000 - BLOCK_SLACK);
        expect(Math.abs(off!.at - on!.at - ms(onSent, offSent))).toBeLessThanOrEqual(BLOCK_SLACK);

        await waitFor(() => events.some((e) => e.event === 'take'), 2000, 'the take event');
        const landed = events.find((e) => e.event === 'take');
        expect(landed?.event === 'take' && landed.take).toEqual(stopped.take);
        const journal = JSON.parse(readFileSync(join(root, '.field/recording', take.id, 'journal.json'), 'utf8'));
        expect(journal).toMatchObject({ frames: take.frames, events: take.events, dropped: 0 });
        const { recordings } = await client.recordings();
        expect(recordings).toEqual([
          expect.objectContaining({
            id: take.id,
            kind: 'midi',
            complete: true,
            active: false,
            frames_on_disk: 0,
            events_on_disk: take.events,
          }),
        ]);

        // An audio arm moves the arm back off MIDI, and disarm releases it.
        await client.arm(TRACK, 1);
        expect((await client.status()).record).toEqual({
          state: 'armed',
          track: TRACK,
          device: 'null',
          input: 1,
          input_peak: expect.any(Number),
        });
        await client.disarm();
        expect((await client.status()).record).toEqual({ state: 'idle' });
      } finally {
        client.close();
      }
    },
  );

  it(
    'ends at until, leaves out what comes after it, and refuses a loop take',
    { timeout: 20_000 },
    async (ctx) => {
      const name = source('until');
      const keys = await publishOrSkip(ctx, name);
      const bed = join(root, 'bed.wav');
      writeWavFloat32(bed, NULL_RATE, [new Float32Array(NULL_RATE * 5)]);
      const client = await connect();
      const events: AudiodEvent[] = [];
      client.on('event', (e: AudiodEvent) => events.push(e));
      try {
        await client.load(bed);
        await armListing(client, name);
        await expect(client.record(0, undefined, 24000, true)).rejects.toThrow('loop takes record audio only');

        const started = await client.record(0, undefined, 24000);
        expect(started.started_at_samples).toBe(0);
        send(keys, NOTE_ON);
        await waitFor(() => events.some((e) => e.event === 'take'), 3000, 'the take to end at until');
        send(keys, NOTE_OFF);
        await sleep(300);
        const landed = events.find((e) => e.event === 'take');
        const take = midiTakeSchema.parse(landed?.event === 'take' ? landed.take : undefined);
        expect(take).toMatchObject({ id: started.transaction, started_at_samples: 0, frames: 24000, timeline_rate: NULL_RATE });
        expect(take.source).toBe(bed);
        const lines = readLines(root, take.file);
        expect(lines.filter(isMine).map((line) => line.midi)).toEqual([NOTE_ON]);
        expect(lines.every((line) => line.at < 24000)).toBe(true);
        expect((await client.status()).state).toBe('playing'); // the bed played on
        await client.stop();

        // A bed at half the device's rate: `until` is half a second of the
        // bed's samples, which is 24000 of the device's, not 12000.
        const slow = join(root, 'bed-24k.wav');
        writeWavFloat32(slow, 24000, [new Float32Array(24000 * 5)]);
        await client.load(slow);
        await armListing(client, name);
        const second = await client.record(0, undefined, 12000);
        await waitFor(() => events.filter((e) => e.event === 'take').length === 2, 3000, 'the second take to end at until');
        const ended = events.filter((e) => e.event === 'take').at(-1);
        expect(midiTakeSchema.parse(ended?.event === 'take' ? ended.take : undefined)).toMatchObject({
          id: second.transaction,
          sample_rate: NULL_RATE,
          timeline_rate: 24000,
          frames: 24000,
        });
        await client.stop();
      } finally {
        client.close();
      }
    },
  );

  it(
    'a daemon killed mid-take leaves whole lines, and recover drops a partial last one',
    { timeout: 20_000 },
    async (ctx) => {
      const name = source('recover');
      const keys = await publishOrSkip(ctx, name);
      const client = await connect();
      let file = '';
      try {
        await armListing(client, name);
        const started = await client.record();
        file = started.file;
        send(keys, NOTE_ON);
        // A message reaches the kernel on the writer's next 20 ms tick, not
        // at the once-a-second sync, so a crash right after it keeps it.
        await waitFor(() => readLines(root, file).filter(isMine).length === 1, 500, 'the note-on to reach the file');
        // Past at least one journal sync (the writer syncs once a second).
        await sleep(1200);
        send(keys, NOTE_OFF);
        await waitFor(() => readLines(root, file).filter(isMine).length === 2, 3000, 'both messages to reach the file');
        process.kill(client.pid!, 'SIGKILL');
      } finally {
        client.close();
      }
      await waitFor(
        () => {
          try {
            process.kill(client.pid!, 0);
            return false;
          } catch {
            return true;
          }
        },
        5000,
        'the killed daemon to die',
      );

      const id = file.split('/')[2]!;
      const dir = join(root, '.field/recording', id);
      const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Record<string, unknown>;
      expect(manifest).toMatchObject({ id, kind: 'midi', complete: false });
      expect(manifest['started_at_samples']).toBeGreaterThanOrEqual(0); // on disk before the crash
      const journal = JSON.parse(readFileSync(join(dir, 'journal.json'), 'utf8')) as { frames: number; events: number };
      expect(journal.frames).toBeGreaterThan(0);
      const whole = readLines(root, file);
      // What a crash in the middle of a write leaves behind.
      appendFileSync(join(root, file), '{"at":12');

      const fresh = await connect();
      try {
        expect(readFileSync(join(root, '.field/audiod.log'), 'utf8')).toContain(
          `recoverable take ${id} (${whole.length} MIDI messages on disk)`,
        );
        const { recordings } = await fresh.recordings();
        expect(recordings.find((r) => r.id === id)).toMatchObject({
          kind: 'midi',
          complete: false,
          active: false,
          frames_on_disk: 0,
          events_on_disk: whole.length,
        });

        const { take } = await fresh.recover(id);
        const recovered = midiTakeSchema.parse(take);
        expect(recovered).toMatchObject({ id, kind: 'midi', complete: true, recovered: true, events: whole.length });
        expect(recovered.journaled_frames).toBe(journal.frames);
        expect(recovered.journaled_events).toBe(journal.events);
        expect(recovered.frames).toBeGreaterThanOrEqual(Math.max(journal.frames, whole.at(-1)!.at + 1));
        expect(readFileSync(join(root, file), 'utf8').endsWith('}\n')).toBe(true);
        expect(readLines(root, file)).toEqual(whole);
        expect(whole.filter(isMine).map((line) => line.midi)).toEqual([NOTE_ON, NOTE_OFF]);
        await expect(fresh.recover(id)).rejects.toThrow('already complete');
      } finally {
        fresh.close();
      }
    },
  );

  it('refuses to arm for MIDI where there is no MIDI source', { timeout: 20_000 }, async (ctx) => {
    const published = await publish(source('probe'));
    if ('helper' in published) {
      const reason =
        'this machine has a MIDI service, whose sources a test cannot remove; ' +
        'the refusal runs where there is none (Linux without /dev/snd/seq)';
      console.warn(`skipping the no-source case: ${reason}`);
      ctx.skip(reason);
    }
    const client = await connect();
    try {
      await expect(client.armMidi(TRACK)).rejects.toThrow(
        'no MIDI sources to record from: start field keys or connect a controller first',
      );
      expect((await client.status()).record).toEqual({ state: 'idle' });
    } finally {
      client.close();
    }
  });

  it(
    'field record: arms for MIDI on a track with an instrument, and lands the take as a notes file',
    { timeout: 30_000 },
    async (ctx) => {
      process.env['FIELD_AUDIOD_NULL'] = '1';
      try {
        init({ dir: root, name: 'keys' });
        createSong(root, 'creek'); // 120 bpm 4/4: one beat = 24000 samples
        const tone = join(root, '..', `field-record-midi-tone-${process.pid}.wav`);
        writeWavFloat32(tone, NULL_RATE, [new Float32Array(NULL_RATE * 6).fill(0.1)]);
        await importAsset(root, 'creek', tone, 'tone');
        rmSync(tone);
        writeFileSync(
          join(root, 'songs/creek/tracks/main.yaml'),
          ['name: main', 'inputs:', '  - audio: tone', '    anchor: absolute', '    at: 0', ''].join('\n'),
        );
        createTrack(root, 'creek', 'keys');
        writeFileSync(join(root, 'songs/creek/tracks/keys.yaml'), 'name: keys\ninstrument: pad\ninputs:\n  - record:\n');
        writeFileSync(join(root, 'shared/instruments/pad.scd'), '// a voice\n');
        const project = loadProject(root);

        // The audio flags are refused before the daemon is touched.
        await expect(recordTake(root, project, 'creek/track:keys', { input: 2 })).rejects.toThrow(
          'keys records MIDI for pad: --input, --device, and --loop are for audio takes',
        );

        // The source must be in the daemon's list before field record arms.
        const name = source('field record');
        const keys = await publishOrSkip(ctx, name);
        const client = await connect();
        try {
          await armListing(client, name);
          await client.disarm();
        } finally {
          client.close();
        }

        // A field keys running in the project, as this process: the take
        // starts where its knobs are (instrument-knobs.md §2.8).
        publishControllers(root, [{ channel: 16, cc: 113, value: 23 }]);

        const lines: string[] = [];
        const positions: string[] = [];
        let played = false;
        const { takes } = await recordTake(
          root,
          project,
          'creek/track:keys',
          { at: '1.2.1' },
          {
            onArmed: (line) => lines.push(line),
            onStarted: (line) => {
              lines.push(line);
              send(keys, NOTE_ON);
              void sleep(300).then(() => {
                send(keys, NOTE_OFF);
                played = true;
              });
            },
            onPosition: (line) => positions.push(line),
            interrupted: () => played && positions.some((line) => Number(/  (\d+) events? /.exec(line)?.[1] ?? 0) >= 2),
          },
        );
        expect(lines[0]).toMatch(/^armed {3}MIDI from .*Field Keys Capture.* {2}\(48000 Hz, latency out 0 samples\)$/);
        expect(lines[1]).toMatch(/^recording take-\S+ from 1\.2\.1 \(0:00\.5\)$/);
        expect(positions.at(-1)).toMatch(/^\d+\.\d+\.\d+ \(\d+:\d\d\.\d\)  \d+ events? \d+\.\ds$/);

        expect(takes).toHaveLength(1);
        const { take, landed } = takes[0]!;
        expect(landed).toMatchObject({
          node: 'keys',
          file: `audio/keys/${take.id}.notes.yaml`,
          placements: 1, // createTrack placed keys in main at 0
          placedAt: take.started_at_samples,
        });
        expect(landed.events).toBeGreaterThanOrEqual(2);
        expect(landed.row).toMatchObject({ latency: 0, musical_position: [1, 2] });
        expect(landed.row).toHaveProperty('sources', expect.arrayContaining([name]));
        expect(landed.row).not.toHaveProperty('device');
        const notes = readFileSync(join(root, 'songs/creek', landed.file), 'utf8');
        expect(notes).toMatch(new RegExp(`\\{at: \\d+, length: \\d+, note: ${NOTE}, velocity: 77, channel: 16\\}`));
        expect(notes).toContain('{at: 0, cc: 113, value: 23, channel: 16}');
        expect(existsSync(join(root, '.field/recording', take.id))).toBe(false);
        expect((await check(root)).diagnostics).toEqual([]);
      } finally {
        delete process.env['FIELD_AUDIOD_NULL'];
      }
    },
  );
});
