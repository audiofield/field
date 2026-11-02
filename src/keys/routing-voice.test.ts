import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { copyFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AudiodClient, daemonBinary } from '../audiod/client.js';
import { createSong, createTrack } from '../commands/create.js';
import { init } from '../commands/init.js';
import { sclangCommand } from '../generators/supercollider.js';
import { removeTempProject } from '../testing/temp.js';
import { routeArmed, type Routing } from './routing.js';
import { fieldOutPluginDir, VoiceHost } from './voice-host.js';

// The whole path of live-supercollider.md chunk 3 through real programs:
// a track routed into the daemon, the voice host on sclang and scsynth
// with FieldOut, and a note from a published MIDI source. The daemon must
// hear the note on the track's input. It needs SuperCollider, the built
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
const bloomPad = join(dirname(fileURLToPath(import.meta.url)), '../../examples/bloom/shared/instruments/pad.scd');

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!binary || !sclang || !fieldOut || process.platform === 'win32')(
  'field keys through the effects, end to end',
  () => {
    let root: string;
    let routing: Routing | undefined;
    let host: VoiceHost | undefined;
    let keys: ChildProcessWithoutNullStreams | undefined;

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
      keys?.kill('SIGKILL');
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

    it('carries a note from the voice host into the track\'s input in the daemon', { timeout: 90_000 }, async () => {
      // A MIDI source first, so the host connects it as it boots.
      const source = `Field Keys Routing ${process.pid}`;
      keys = spawn(binary!, ['--keys', source], { stdio: 'pipe' });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('--keys was not ready in 5 s')), 5000);
        createInterface({ input: keys!.stdout }).on('line', (text) => {
          const line = JSON.parse(text) as Record<string, unknown>;
          if ('keyboard' in line) return;
          clearTimeout(timer);
          if ('error' in line) reject(new Error(String(line['error'])));
          else resolve();
        });
      });

      const program = join(root, 'shared/instruments/pad.scd');
      routing = (await routeArmed([{ program, track: 'creek/bass', unheardEffects: [] }], root)) as Routing;
      expect(routing.rings[0]).toBeGreaterThan(0);
      host = await VoiceHost.start({ instruments: routing.programs, rings: routing.rings, fieldOut: routing.fieldOut });
      await host.ready;

      const client = await AudiodClient.connect(root);
      try {
        // Stopped, so the idle path plays the input.
        expect((await client.status()).state).toBe('stopped');
        await client.status(); // clears the peak
        keys.stdin.write(`${JSON.stringify({ midi: [0x90, 60, 100] })}\n`);
        let loudest = 0;
        for (let i = 0; i < 30 && loudest < 0.01; i++) {
          await sleep(100);
          loudest = Math.max(loudest, (await client.status()).inputs![0]!.peak);
        }
        keys.stdin.write(`${JSON.stringify({ midi: [0x80, 60, 0] })}\n`);
        expect(loudest).toBeGreaterThan(0.01);
      } finally {
        client.close();
      }
    });
  },
);
