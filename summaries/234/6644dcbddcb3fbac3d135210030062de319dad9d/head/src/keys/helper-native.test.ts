import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { afterEach, describe, expect, it, type TestContext } from 'vitest';
import { daemonBinary } from '../audiod/client.js';
import { TEXT_POSITIONS } from '../schema/keymap.js';

// The native round trip (keyboard-instrument.md §4): `field-audiod --keys`
// publishes a virtual MIDI source and `--midi-monitor` reads it back. The
// probe for a MIDI service is `--keys` itself, and the only error allowed
// to skip is a Linux machine without the ALSA sequencer, so a green run
// without a MIDI service never reads as coverage.

const binary = (() => {
  try {
    return daemonBinary();
  } catch {
    return undefined;
  }
})();

// What `keyboard-layout.cpp` must report: every position a keymap binds
// that types a character. A position added to the schema fails here until
// the helper reports it.
const BINDABLE_POSITIONS = TEXT_POSITIONS;

const LINE_TIMEOUT_MS = 5000;

type Line = Record<string, unknown>;

interface Helper {
  args: string[];
  child: ChildProcessWithoutNullStreams;
  stdout: string[];
  stderr: string;
  ended: boolean;
  closed: Promise<number | null>;
}

const running: Helper[] = [];

function spawnHelper(...args: string[]): Helper {
  const child = spawn(binary!, args, { stdio: 'pipe' });
  const helper: Helper = {
    args,
    child,
    stdout: [],
    stderr: '',
    ended: false,
    closed: new Promise((resolve) => {
      child.on('close', (code) => {
        helper.ended = true;
        resolve(code);
      });
    }),
  };
  child.on('error', (error) => {
    helper.stderr += String(error);
  });
  // A write to a helper that has already exited shows up in its exit
  // code and output; without a listener the EPIPE would kill the worker.
  child.stdin.on('error', () => {});
  child.stderr.on('data', (chunk) => {
    helper.stderr += String(chunk);
  });
  createInterface({ input: child.stdout }).on('line', (line) => helper.stdout.push(line));
  running.push(helper);
  return helper;
}

function parse(helper: Helper, index: number): Line {
  const raw = helper.stdout[index]!;
  try {
    return JSON.parse(raw) as Line;
  } catch {
    throw new Error(`${helper.args.join(' ')}: stdout line ${index + 1} is not JSON: ${raw}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function lineAt(helper: Helper, index: number): Promise<Line> {
  const deadline = Date.now() + LINE_TIMEOUT_MS;
  while (helper.stdout.length <= index) {
    const said = `${helper.args.join(' ')} printed ${helper.stdout.length} lines; stderr: ${helper.stderr}`;
    if (helper.ended) throw new Error(`exited before stdout line ${index + 1}: ${said}`);
    if (Date.now() > deadline) throw new Error(`timed out waiting for stdout line ${index + 1}: ${said}`);
    await sleep(10);
  }
  return parse(helper, index);
}

function linesFrom(helper: Helper, index: number): Line[] {
  return helper.stdout.slice(index).map((_, offset) => parse(helper, index + offset));
}

function withoutLayoutReports(lines: Line[]): Line[] {
  return lines.filter((line) => !('keyboard' in line));
}

function expectFullLayoutReport(line: Line): void {
  expect(Object.keys(line)).toEqual(['keyboard']);
  const report = line['keyboard'] as { name: unknown; keys: Record<string, unknown>; dead: string[] };
  expect(typeof report.name).toBe('string');
  expect(report.name).not.toBe('');
  for (const typed of Object.values(report.keys)) expect(typeof typed).toBe('string');
  expect([...Object.keys(report.keys), ...report.dead].sort()).toEqual([...BINDABLE_POSITIONS].sort());
}

// Starts `--keys <name>` and returns it with the index of the first line
// after `ready`. On macOS the layout report must come first.
async function startKeys(ctx: TestContext, name: string): Promise<{ keys: Helper; afterReady: number }> {
  const keys = spawnHelper('--keys', name);
  let index = 0;
  if (process.platform === 'darwin') expectFullLayoutReport(await lineAt(keys, index++));

  const published = await lineAt(keys, index++);
  if ('error' in published && process.platform === 'linux' && !existsSync('/dev/snd/seq')) {
    const reason =
      `no MIDI service: this Linux machine has no ALSA sequencer at /dev/snd/seq, ` +
      `and --keys said ${JSON.stringify(published['error'])}`;
    console.warn(`skipping the native MIDI round trip: ${reason}`);
    ctx.skip(reason);
  }
  // Windows has no virtual MIDI ports for --keys to publish
  // (windows-portability.md §7.2), so the helper refuses there by design.
  if ('error' in published && process.platform === 'win32') {
    const reason = `no virtual MIDI ports on Windows, and --keys said ${JSON.stringify(published['error'])}`;
    console.warn(`skipping the native MIDI round trip: ${reason}`);
    ctx.skip(reason);
  }
  // On macOS the ready line also names the system output, which the
  // voice host gives scsynth for both directions.
  const { output, ...ready } = published;
  expect(ready).toEqual({ ready: true, name });
  // macOS always reports the system output, so a helper that stops
  // sending it fails here; every other platform reports none.
  if (process.platform === 'darwin') {
    expect(typeof output).toBe('string');
    expect(output).not.toBe('');
  } else {
    expect(output).toBeUndefined();
  }
  return { keys, afterReady: index };
}

describe.skipIf(!binary)('field-audiod --keys and --midi-monitor (native round trip)', () => {
  const base = `Field Keys Test ${process.pid}`;

  afterEach(async () => {
    const left = running.splice(0);
    for (const helper of left) if (!helper.ended) helper.child.kill('SIGKILL');
    await Promise.all(left.map((helper) => helper.closed));
  });

  it(
    'delivers each message to a monitor in order, and exits 0 at the end of its input',
    { timeout: 20_000 },
    async (ctx) => {
      const { keys, afterReady } = await startKeys(ctx, base);
      const monitor = spawnHelper('--midi-monitor', base);
      expect(await lineAt(monitor, 0)).toEqual({ ready: true, name: base });

      keys.child.stdin.write('{"midi":[144,60,100]}\n\n  \n{"midi":[128,60,0]}\n');
      const on = await lineAt(monitor, 1);
      const off = await lineAt(monitor, 2);
      expect(on).toEqual({ midi: [144, 60, 100], host_ms: expect.any(Number) });
      expect(off).toEqual({ midi: [128, 60, 0], host_ms: expect.any(Number) });
      expect(off['host_ms']).toBeGreaterThanOrEqual(on['host_ms'] as number);

      keys.child.stdin.end();
      expect(await keys.closed).toBe(0);
      expect(withoutLayoutReports(linesFrom(keys, afterReady))).toEqual([]);

      monitor.child.kill('SIGTERM');
      expect(await monitor.closed).toBe(0);
      expect(linesFrom(monitor, 3)).toEqual([]);
    },
  );

  it.for([
    ['not JSON', 'note on 60'],
    ['a JSON array', '[144,60,100]'],
    ['no bytes', '{"midi":[]}'],
    ['four bytes', '{"midi":[144,60,100,0]}'],
    ['no status byte', '{"midi":[60,100]}'],
    ['a byte above 255', '{"midi":[144,60,256]}'],
    ['a property besides midi', '{"midi":[144,60,100],"at":0}'],
  ] as const)('answers a line with %s with an error and exit 1', { timeout: 20_000 }, async ([what, line], ctx) => {
    const { keys, afterReady } = await startKeys(ctx, `${base} ${what}`);
    keys.child.stdin.write(`${line}\n`);
    expect(await keys.closed).toBe(1);
    expect(withoutLayoutReports(linesFrom(keys, afterReady))).toEqual([{ error: expect.any(String) }]);
  });
});
