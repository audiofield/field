import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, type TestContext } from 'vitest';
import { createSong, createTrack } from '../commands/create.js';
import { init } from '../commands/init.js';
import { compileSession } from '../graph/live.js';
import { removeTempProject } from '../testing/temp.js';
import { AudiodClient, daemonBinary } from './client.js';
import { midiTakeLineSchema, okResponseSchema, type MidiOut, type MidiTakeLine } from './protocol.js';

// MIDI outputs (sequencer.md §2.5) against the real daemon in null-output
// mode. The callback's selection, held notes, the clock's transport
// messages, and a stop with messages handed over early are proven in
// `--midi-out-selftest` against a fake clock; these tests send through
// real virtual MIDI and read it back with `--midi-monitor` and MIDI takes.
// The probe for a MIDI service is opening an output with a source: only
// a Linux machine without the ALSA sequencer, and Windows, which has no
// virtual ports, may skip.
//
// Every message is on channel 16, from sources and to a destination
// named for this run's pid, so a run beside another, or beside a
// `field keys` someone is playing, reads only its own.

const binary = (() => {
  try {
    return daemonBinary();
  } catch {
    return undefined;
  }
})();

const execFileAsync = promisify(execFile);
const RATE = 48000;
const BAR = 96000; // 120 bpm, 4/4
const ON = 0x9f;
const OFF = 0x8f;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean | Promise<boolean>, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

// Twelve silent bars, the bed a schedule plays against.
function scaffold(root: string): void {
  init({ dir: root, name: 'midi-out' });
  createSong(root, 'bed');
  createTrack(root, 'bed', 'voice');
  writeFileSync(join(root, 'songs/bed/tracks/voice.yaml'), 'name: voice\ninputs: []\n');
  writeFileSync(join(root, 'songs/bed/tracks/main.yaml'), 'name: main\ninputs:\n  - track: voice\n');
  writeFileSync(
    join(root, 'songs/bed/song.yaml'),
    'name: bed\ntime:\n  tempo:\n    - at: 0\n      bpm: 120\n  meter:\n    - at: 0\n      numerator: 4\n      denominator: 4\nlength: [12]\n',
  );
}

interface Line {
  midi: number[];
  host_ms: number;
  timestamp_ms?: number;
}

interface Monitor {
  child: ChildProcessWithoutNullStreams;
  lines: Line[];
  stderr: string;
  ended: boolean;
  closed: Promise<void>;
}

// Notes `length` samples long on channel 16, starting at each of `starts`.
function notes(starts: number[], length: number, first = 40): MidiOut['events'] {
  const events = starts.flatMap((sample, i) => [
    { sample, midi: [ON, first + i, 100] },
    { sample: sample + length, midi: [OFF, first + i, 0] },
  ]);
  return events.sort((a, b) => a.sample - b.sample || a.midi[0]! - b.midi[0]!);
}

// The pitches a run of monitor lines leaves sounding.
function held(lines: Line[]): Set<number> {
  const sounding = new Set<number>();
  for (const { midi } of lines) {
    if (midi[0] === ON && midi[2]! > 0) sounding.add(midi[1]!);
    else if (midi[0] === OFF || midi[0] === ON) sounding.delete(midi[1]!);
  }
  return sounding;
}

describe.skipIf(!binary)('MIDI outputs through the daemon', () => {
  let root: string;
  let client: AudiodClient;
  const monitors: Monitor[] = [];
  const name = (what: string) => `Field Seq Test ${process.pid} ${what}`;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'field-midi-out-'));
    scaffold(root);
    client = await AudiodClient.connect(root, { nullOutput: true, idleSeconds: 60 });
    await client.session((await compileSession(root, 'bed')).session);
  });

  afterEach(async () => {
    delete process.env['FIELD_AUDIOD_CAPTURE_OUTPUTS'];
    const left = monitors.splice(0);
    for (const monitor of left) if (!monitor.ended) monitor.child.kill('SIGKILL');
    await Promise.all(left.map((monitor) => monitor.closed));
    try {
      await client.quit();
    } catch {
      // already gone
    }
    client.close();
    await removeTempProject(root);
  });

  // Prints what the source `port` sends, or with `destination`, publishes
  // a virtual destination named `port` and prints what reaches it.
  async function monitor(port: string, destination = false): Promise<Monitor> {
    const child = spawn(binary!, ['--midi-monitor', port, ...(destination ? ['--destination'] : [])], { stdio: 'pipe' });
    const watching: Monitor = {
      child,
      lines: [],
      stderr: '',
      ended: false,
      closed: new Promise((resolve) => child.on('close', () => resolve())),
    };
    child.on('close', () => {
      watching.ended = true;
    });
    child.stdin.on('error', () => {});
    child.stderr.on('data', (chunk) => {
      watching.stderr += String(chunk);
    });
    let ready = false;
    createInterface({ input: child.stdout }).on('line', (text) => {
      const line = JSON.parse(text) as Record<string, unknown>;
      if ('ready' in line) ready = true;
      else if ('error' in line) watching.stderr += String(line['error']);
      else watching.lines.push(line as unknown as Line);
    });
    monitors.push(watching);
    await waitFor(() => ready || watching.ended, 6000, `--midi-monitor ${port}`);
    if (!ready) throw new Error(`--midi-monitor ${port} exited: ${watching.stderr}`);
    return watching;
  }

  // Opens an output, or skips where the machine has no virtual MIDI.
  // CoreMIDI can refuse a new source for a moment after an earlier test's
  // went away, so a refusal on macOS is tried again for a second.
  async function open(ctx: TestContext, output: MidiOut, through: AudiodClient = client) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await through.midiOut(output);
      } catch (error) {
        const message = String(error);
        if (/cannot create a virtual MIDI source/.test(message)) {
          if (process.platform === 'linux' && !existsSync('/dev/snd/seq')) {
            const reason = `no MIDI service: this Linux machine has no ALSA sequencer at /dev/snd/seq, and midi_out said ${message}`;
            console.warn(`skipping a MIDI output test: ${reason}`);
            ctx.skip(reason);
          }
          if (process.platform === 'win32') {
            const reason = `no virtual MIDI ports on Windows, and midi_out said ${message}`;
            console.warn(`skipping a MIDI output test: ${reason}`);
            ctx.skip(reason);
          }
          if (process.platform === 'darwin' && attempt < 4) {
            await sleep(250);
            continue;
          }
        }
        throw error;
      }
    }
  }

  it('checks its selection, held notes, clock, and flush against a fake clock', async () => {
    const { stdout } = await execFileAsync(binary!, ['--midi-out-selftest']);
    expect(stdout.trim()).toBe('{"ok":true}');
  });

  it('advertises midi-out, and refuses a malformed schedule, an unknown destination, and an unknown close', async () => {
    expect(client.supports('midi-out')).toBe(true);
    const base = { name: 'bad', rate: RATE, lead: 0, events: [] };
    await expect(client.request('midi_out', { ...base, source: 'A', destination: 'B' }, okResponseSchema)).rejects.toThrow(
      'midi_out takes a source or a destination, and not both',
    );
    await expect(
      client.midiOut({ ...base, source: name('bad'), events: [{ sample: 10, midi: [ON, 1, 1] }, { sample: 5, midi: [OFF, 1, 0] }] }),
    ).rejects.toThrow('events are in time order');
    await expect(client.midiOut({ ...base, destination: name('nowhere') })).rejects.toThrow(`no MIDI destination named ${name('nowhere')}`);
    await expect(client.closeMidiOut('bad')).rejects.toThrow('no MIDI output named "bad"');
    expect((await client.status()).outputs).toBeUndefined();
  });

  it(
    'sends a schedule on time across a loop wrap, as a MIDI take in the same daemon records it, with none late',
    { timeout: 30_000 },
    async (ctx) => {
      // A take leaves the daemon's own outputs out, unless this seam lets
      // it hear them; it reaches the daemon at its spawn, so the daemon
      // the setup started is replaced.
      try {
        await client.quit();
      } catch {
        // the daemon can close the connection before it answers
      }
      client.close();
      process.env['FIELD_AUDIOD_CAPTURE_OUTPUTS'] = '1';
      await waitFor(
        async () => {
          try {
            (await AudiodClient.connect(root, { spawnIfNeeded: false })).close();
            return false;
          } catch {
            return true;
          }
        },
        5000,
        'the first daemon to exit',
      );
      client = await AudiodClient.connect(root, { nullOutput: true, idleSeconds: 60 });
      await client.session((await compileSession(root, 'bed')).session);

      // Short notes off the block grid, one at the loop's start and one
      // ending just before its end, through a one-bar loop.
      const starts = [0, 6137, 15011, 30500, 48001, 61999, 79123, 94500];
      const events = notes(starts, 1300);
      const source = name('timing');
      await open(ctx, { name: 'seq:timing', source, rate: RATE, lead: 0, events });
      await waitFor(
        async () => (await client.armMidi('//songs/bed/track:voice')).sources.includes(source),
        5000,
        `${source} to be armed`,
      );
      await client.loop(0, BAR);
      const started = await client.record();
      await sleep(4600);
      const stopped = await client.stop();
      const take = stopped.take!;
      const lines: MidiTakeLine[] = readFileSync(join(root, take.file), 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => midiTakeLineSchema.parse(JSON.parse(line)))
        .filter((line) => events.some((e) => e.midi[0] === line.midi[0] && e.midi[1] === line.midi[1]));

      const startedAt = started.started_at_samples >= 0 ? started.started_at_samples : take.started_at_samples!;
      let afterWrap = 0;
      for (const line of lines) {
        const bed = (startedAt + line.at) % BAR;
        if (startedAt + line.at >= BAR) afterWrap++;
        const scheduled = events.filter((e) => e.midi.join() === line.midi.join());
        const off = Math.min(...scheduled.map((e) => Math.min(Math.abs(e.sample - bed), BAR - Math.abs(e.sample - bed))));
        expect(off, `${JSON.stringify(line.midi)} at bed sample ${bed}`).toBeLessThanOrEqual(48);
      }
      // Two passes and more, each with every note.
      expect(lines.length).toBeGreaterThanOrEqual(2 * events.length);
      expect(afterWrap).toBeGreaterThanOrEqual(events.length);
      const [output] = (await client.status()).outputs!;
      expect(output).toMatchObject({ name: 'seq:timing', source, late: 0, dropped: 0 });
    },
  );

  it(
    'ends every note it started on stop, pause, locate, wrap, a replaced schedule, a close, and a dropped connection',
    { timeout: 60_000 },
    async (ctx) => {
      // Notes two seconds long, one every tenth of a second: half a second
      // in, five are sounding and none has ended on its own.
      const starts = Array.from({ length: 20 }, (_, i) => i * 4800);
      const events = notes(starts, 2 * RATE);

      // Acts, then waits for a note-off for every note that sounded just
      // before, and for nothing to sound after.
      async function endsNotes(watching: Monitor, what: string, act: () => Promise<unknown>) {
        await waitFor(() => held(watching.lines).size >= 3, 3000, `notes to sound before the ${what}`);
        const mark = watching.lines.length;
        const sounding = held(watching.lines);
        await act();
        await waitFor(
          () => [...sounding].every((pitch) => watching.lines.slice(mark).some((l) => l.midi[0] === OFF && l.midi[1] === pitch)),
          2000,
          `a note-off for each of ${[...sounding].join(', ')} after the ${what}`,
        );
      }

      const source = name('held');
      await open(ctx, { name: 'seq:held', source, rate: RATE, lead: 0, events });
      const watching = await monitor(source);

      await client.locate(0);
      await client.play();
      await endsNotes(watching, 'stop', () => client.stop());
      expect(held(watching.lines)).toEqual(new Set());

      await client.play();
      await endsNotes(watching, 'pause', () => client.pause());
      expect(held(watching.lines)).toEqual(new Set());

      // A locate ends the notes and starts none of them again: the notes
      // under bar 9 started before it.
      await client.stop();
      await client.play();
      await endsNotes(watching, 'locate', () => client.locate(8 * BAR + 24000));
      const afterLocate = watching.lines.length;
      await sleep(300);
      expect(watching.lines.slice(afterLocate).filter((l) => l.midi[0] === ON)).toEqual([]);

      // The wrap of a one-second loop ends every note before the loop's
      // start begins the first one again.
      await client.stop();
      await client.loop(0, RATE);
      const beforeWrap = watching.lines.length;
      await client.play();
      await waitFor(
        () => watching.lines.slice(beforeWrap).filter((l) => l.midi[0] === ON && l.midi[1] === 40).length >= 2,
        4000,
        'the loop to wrap',
      );
      const lap = watching.lines.slice(beforeWrap);
      const again = lap.findIndex((l, i) => i > 0 && l.midi[0] === ON && l.midi[1] === 40);
      expect(held(lap.slice(0, again))).toEqual(new Set());
      await client.stop();
      await client.loop();

      // A replaced schedule ends the old one's notes, and the new one's
      // play from the same source.
      await client.play();
      await endsNotes(watching, 'replaced schedule', () =>
        client.midiOut({ name: 'seq:held', source, rate: RATE, lead: 0, events: notes(starts, 2 * RATE, 80) }),
      );
      await waitFor(() => watching.lines.some((l) => l.midi[0] === ON && l.midi[1]! >= 80), 3000, 'the new schedule to play');

      await endsNotes(watching, 'close', () => client.closeMidiOut('seq:held'));
      expect(held(watching.lines)).toEqual(new Set());
      expect((await client.status()).outputs).toBeUndefined();

      // An output closes with the connection that opened it.
      await client.stop();
      const dropping = await AudiodClient.connect(root, { spawnIfNeeded: false });
      const dropped = name('dropped');
      await open(ctx, { name: 'seq:dropped', source: dropped, rate: RATE, lead: 0, events }, dropping);
      const watchingDropped = await monitor(dropped);
      await client.play();
      await endsNotes(watchingDropped, 'dropped connection', async () => dropping.close());
      await waitFor(async () => (await client.status()).outputs === undefined, 2000, 'the output to close');
    },
  );

  it('leaves its own outputs out of a MIDI take', { timeout: 30_000 }, async (ctx) => {
    const source = name('beside');
    await open(ctx, { name: 'seq:beside', source, rate: RATE, lead: 0, events: notes([0, 4800, 9600], 2400) });
    const keys = spawn(binary!, ['--keys', name('keys')], { stdio: 'pipe' });
    const keyLines: string[] = [];
    createInterface({ input: keys.stdout }).on('line', (line) => keyLines.push(line));
    keys.stdin.on('error', () => {});
    const keysClosed = new Promise((resolve) => keys.on('close', resolve));
    try {
      await waitFor(() => keyLines.some((line) => line.includes('"ready"')), 5000, '--keys to publish');
      // Until the helper's source reaches the daemon's list, it may have
      // nothing to arm but its own output, which it leaves out.
      let sources: string[] = [];
      await waitFor(
        async () => {
          try {
            sources = (await client.armMidi('//songs/bed/track:voice')).sources;
          } catch (error) {
            if (!/no MIDI sources to record from/.test(String(error))) throw error;
          }
          return sources.includes(name('keys'));
        },
        5000,
        `${name('keys')} to be armed`,
      );
      expect(sources).not.toContain(source);
      await client.locate(0);
      const started = await client.record();
      await sleep(150);
      keys.stdin.write(`${JSON.stringify({ midi: [ON, 100, 90] })}\n${JSON.stringify({ midi: [OFF, 100, 0] })}\n`);
      await sleep(400);
      await client.stop();
      const lines = readFileSync(join(root, started.file), 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => midiTakeLineSchema.parse(JSON.parse(line)))
        .filter((line) => (line.midi[0]! & 0x0f) === 0x0f);
      expect(lines.map((line) => line.midi)).toEqual([
        [ON, 100, 90],
        [OFF, 100, 0],
      ]);
      expect((await client.status()).outputs![0]!.sent).toBeGreaterThanOrEqual(6);
    } finally {
      keys.kill('SIGKILL');
      await keysClosed;
    }
  });

  it.skipIf(process.platform !== 'darwin')(
    "stamps a destination's messages with the time its source sends them, handing each to CoreMIDI early, across a wrap",
    { timeout: 30_000 },
    async (ctx) => {
      // A loop of 94 blocks keeps every block on the 512-frame grid, and
      // each event sits mid-block, so it is queued well before its time.
      const loop = 94 * 512;
      const starts = [256, 4864, 10496, 20224, 30976, 40192, 47360];
      const events = notes(starts, 512);
      const destination = name('destination');
      const source = name('source');
      const atDestination = await monitor(destination, true);
      await waitFor(
        async () => {
          try {
            await client.midiOut({ name: 'seq:destination', destination, rate: RATE, lead: 0, events });
            return true;
          } catch (error) {
            if (!/no MIDI destination named/.test(String(error))) throw error;
            return false;
          }
        },
        5000,
        `${destination} to be listed`,
      );
      await open(ctx, { name: 'seq:source', source, rate: RATE, lead: 0, events });
      const fromSource = await monitor(source);
      await client.loop(0, loop);
      await client.locate(0);
      await client.play();
      await waitFor(() => fromSource.lines.length >= 3 * events.length, 6000, 'three passes from the source');
      await client.stop();
      await sleep(200);

      const passes = 3 * events.length;
      const sent = fromSource.lines.slice(0, passes);
      const stamped = atDestination.lines.slice(0, passes);
      expect(stamped.map((l) => l.midi)).toEqual(sent.map((l) => l.midi));
      for (let i = 0; i < passes; i++) {
        expect(Math.abs(stamped[i]!.timestamp_ms! - sent[i]!.host_ms), `message ${i} ${JSON.stringify(sent[i]!.midi)}`).toBeLessThan(1);
      }
      // A stop with nothing still scheduled sends the destination no
      // flush, which reaches it as a System Reset.
      expect(atDestination.lines.some((l) => l.midi[0] === 0xff)).toBe(false);
      // Every event of the passes compared went to CoreMIDI ahead of its
      // time; the stop's note-offs went at once.
      const toDestination = (await client.status()).outputs!.find((o) => o.name === 'seq:destination')!;
      expect(toDestination).toMatchObject({ destination, late: 0, dropped: 0 });
      expect(toDestination.early).toBeGreaterThanOrEqual(passes);
    },
  );

  it(
    "sends MIDI clock only while playing, with Start, Stop, Song Position Pointer, and Continue at the transport's changes",
    { timeout: 30_000 },
    async (ctx) => {
      const pulses = Array.from({ length: 12 * 96 }, (_, i) => i * 1000);
      const source = name('clock');
      await open(ctx, { name: 'seq:clock', source, rate: RATE, lead: 0, events: [], clock: { pulses } });
      const watching = await monitor(source);
      const settle = () => sleep(400);

      await client.locate(0);
      await client.play();
      await settle();
      await client.stop();
      await settle();
      await client.locate(2 * BAR); // bar 3
      await client.play();
      await settle();
      await client.locate(8 * BAR + 24000); // beat 2 of bar 9
      await settle();
      await client.loop(8 * BAR, 9 * BAR); // wraps from bar 10 to bar 9
      await waitFor(
        () => watching.lines.filter((l) => l.midi[0] === 0xfc).length >= 3,
        4000,
        'the wrap',
      );
      await settle();
      await client.pause();
      await settle();
      await client.stop();
      await client.loop();
      await client.locate(193500); // between sixteenths
      await client.play();
      await settle();
      await client.stop();
      await settle();

      const transport = watching.lines.filter((l) => l.midi[0] !== 0xf8);
      expect(transport.map((l) => l.midi)).toEqual([
        [0xfa], // play from the top: Start
        [0xfc], // stop
        [0xf2, 32, 0], // play from bar 3
        [0xfb],
        [0xfc], // locate to beat 2 of bar 9 while playing
        [0xf2, 4, 1], // 132
        [0xfb],
        [0xfc], // the wrap to bar 9
        [0xf2, 0, 1], // 128
        [0xfb],
        [0xfc], // pause
        [0xf2, 33, 0], // play from pulse 193.5: the next sixteenth is 33
        [0xfb],
        [0xfc], // stop
      ]);

      // No pulse between a Stop and the Start or Continue after it, and
      // after each Continue the next pulse is 6 times the position: at
      // once on a sixteenth, and 4500 samples on from pulse 193.5.
      let stopped = false;
      const firstPulseAfter: number[] = [];
      let resumedAt: number | undefined;
      for (const line of watching.lines) {
        if (line.midi[0] === 0xfc) stopped = true;
        else if (line.midi[0] === 0xfa || line.midi[0] === 0xfb) {
          stopped = false;
          resumedAt = line.host_ms;
        } else if (line.midi[0] === 0xf8) {
          expect(stopped, `a pulse at ${line.host_ms} while stopped`).toBe(false);
          if (resumedAt !== undefined) firstPulseAfter.push(line.host_ms - resumedAt);
          resumedAt = undefined;
        }
      }
      expect(firstPulseAfter).toHaveLength(5);
      for (const gap of firstPulseAfter.slice(0, 4)) expect(gap).toBeLessThan(5);
      expect(firstPulseAfter[4]).toBeGreaterThan((4500 / RATE) * 1000 - 5);
      expect(firstPulseAfter[4]).toBeLessThan((4500 / RATE) * 1000 + 15);

      // 48 pulses a second while it plays.
      const spacing = watching.lines
        .filter((l) => l.midi[0] === 0xf8)
        .map((l, i, all) => (i > 0 ? l.host_ms - all[i - 1]!.host_ms : NaN))
        .filter((gap) => gap > 0 && gap < 100)
        .sort((a, b) => a - b);
      expect(spacing[Math.floor(spacing.length / 2)]).toBeCloseTo(1000 / 48, 0);
    },
  );
});
