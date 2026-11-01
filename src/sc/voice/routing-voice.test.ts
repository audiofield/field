import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { copyFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AudiodClient, daemonBinary } from '../../audiod/client.js';
import { createSong, createTrack } from '../../commands/create.js';
import { init } from '../../commands/init.js';
import { sclangCommand } from '../../generators/supercollider.js';
import { removeTempProject } from '../../testing/temp.js';
import { routeVoices, type Routing } from './routing.js';
import { fieldOutPluginDir, VoiceHost } from './host.js';

// The whole path of live-supercollider.md chunk 3 through real programs:
// a track routed into the daemon, the voice host on sclang and scsynth
// with FieldOut, and a note from a published MIDI source. The daemon must
// hear the note on the track's input, and only on the inputs of the
// voices that play from that source. It needs SuperCollider, the built
// plugin, and an output device for scsynth, so it runs on a workstation.

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
const fieldOut = fieldOutPluginDir();
const bloomPad = join(dirname(fileURLToPath(import.meta.url)), '../../../examples/bloom/shared/instruments/pad.scd');

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!binary || !sclang || !fieldOut || process.platform === 'win32')(
  'voices through the effects, end to end',
  () => {
    let root: string;
    let routing: Routing | undefined;
    let host: VoiceHost | undefined;
    let published: ChildProcessWithoutNullStreams[] = [];

    // A virtual MIDI source under `name`, published before the host
    // starts, so the host connects it as it boots.
    const publish = async (name: string): Promise<ChildProcessWithoutNullStreams> => {
      const source = spawn(binary!, ['--keys', name], { stdio: 'pipe' });
      published.push(source);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('--keys was not ready in 5 s')), 5000);
        createInterface({ input: source.stdout }).on('line', (text) => {
          const line = JSON.parse(text) as Record<string, unknown>;
          if ('keyboard' in line) return;
          clearTimeout(timer);
          if ('error' in line) reject(new Error(String(line['error'])));
          else resolve();
        });
      });
      return source;
    };
    const send = (source: ChildProcessWithoutNullStreams, midi: number[]): void => {
      source.stdin.write(`${JSON.stringify({ midi })}\n`);
    };

    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), 'field-routing-voice-'));
      process.env['FIELD_AUDIOD_NULL'] = '1';
      init({ dir: root, name: 'routing-voice' });
      copyFileSync(bloomPad, join(root, 'shared/instruments/pad.scd'));
      createSong(root, 'creek');
      createTrack(root, 'creek', 'bass');
      writeFileSync(join(root, 'songs/creek/tracks/bass.yaml'), 'name: bass\ninstrument: pad\ninputs:\n  - record:\n');
      writeFileSync(join(root, 'songs/creek/tracks/main.yaml'), 'name: main\ninputs:\n  - track: bass\n');
    });
    afterEach(async () => {
      for (const source of published.splice(0)) source.kill('SIGKILL');
      await host?.close();
      await routing?.close();
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

    // The loudest each input read over about three seconds, or until
    // `until` says to stop looking.
    const loudest = async (client: AudiodClient, until: (peaks: Map<string, number>) => boolean): Promise<Map<string, number>> => {
      const peaks = new Map<string, number>();
      await client.status(); // clears the peaks
      for (let i = 0; i < 30 && !until(peaks); i++) {
        await sleep(100);
        for (const { name, peak } of (await client.status()).inputs ?? []) peaks.set(name, Math.max(peaks.get(name) ?? 0, peak));
      }
      return peaks;
    };

    it('carries a note from the voice host into the track\'s input in the daemon', { timeout: 90_000 }, async () => {
      const keys = await publish(`Field Keys Routing ${process.pid}`);
      const program = join(root, 'shared/instruments/pad.scd');
      routing = (await routeVoices([{ program, track: 'creek/bass' }], root, { kind: 'keys' })) as Routing;
      expect(routing.rings[0]).toBeGreaterThan(0);
      host = await VoiceHost.start({ instruments: routing.programs, rings: routing.rings, fieldOut: routing.fieldOut });
      await host.ready;

      const client = await AudiodClient.connect(root);
      try {
        // Stopped, so the idle path plays the input.
        expect((await client.status()).state).toBe('stopped');
        send(keys, [0x90, 60, 100]);
        const peaks = await loudest(client, (p) => (p.get('keys:creek/bass') ?? 0) > 0.01);
        send(keys, [0x80, 60, 0]);
        expect(peaks.get('keys:creek/bass')).toBeGreaterThan(0.01);
      } finally {
        client.close();
      }
    });

    // sequencer.md §2.6: each voice plays from its own sources. Two
    // sources, named apart from Field's own, each play one track's voice.
    it('plays each voice from the sources it names alone', { timeout: 90_000 }, async () => {
      const [first, second] = [`Voice Source One ${process.pid}`, `Voice Source Two ${process.pid}`];
      const one = await publish(first);
      const two = await publish(second);
      createTrack(root, 'creek', 'lead');
      writeFileSync(join(root, 'songs/creek/tracks/lead.yaml'), 'name: lead\ninstrument: pad\ninputs:\n  - record:\n');
      writeFileSync(join(root, 'songs/creek/tracks/main.yaml'), 'name: main\ninputs:\n  - track: bass\n  - track: lead\n');

      const program = join(root, 'shared/instruments/pad.scd');
      routing = (await routeVoices(
        [
          { program, track: 'creek/bass' },
          { program, track: 'creek/lead' },
        ],
        root,
        { kind: 'voice' },
      )) as Routing;
      host = await VoiceHost.start({
        instruments: routing.programs,
        sources: [[first], [second]],
        rings: routing.rings,
        fieldOut: routing.fieldOut,
      });
      await host.ready;

      const client = await AudiodClient.connect(root);
      try {
        for (const [source, heard, unheard] of [
          [one, 'voice:creek/bass', 'voice:creek/lead'],
          [two, 'voice:creek/lead', 'voice:creek/bass'],
        ] as const) {
          send(source, [0x90, 60, 100]);
          const peaks = await loudest(client, (p) => (p.get(heard) ?? 0) > 0.01);
          send(source, [0x80, 60, 0]);
          expect(peaks.get(heard)).toBeGreaterThan(0.01);
          expect(peaks.get(unheard)).toBeLessThan(0.001);
          // The released note's tail dies before the next source plays.
          await sleep(3000);
        }
      } finally {
        client.close();
      }
    });
  },
);
