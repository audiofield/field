import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { daemonBinary } from '../audiod/client.js';
import { BUILD_DAEMON } from '../remedies.js';
import type { KeyboardLayout } from './position.js';
import type { MidiMessage } from './session.js';

export const SOURCE_NAME = 'Field Keys';

// The helper's lines (keyboard-instrument.md §2.5).
const helperLine = z.union([
  z.object({ keyboard: z.object({ name: z.string(), keys: z.record(z.string(), z.string()), dead: z.array(z.string()) }) }),
  z.object({ ready: z.literal(true), name: z.string(), output: z.string().optional() }),
  z.object({ error: z.string() }),
]);

export interface HelperOptions {
  onKeyboard?: (layout: KeyboardLayout) => void;
  // Called when the helper exits on its own after it was ready.
  onExit?: (reason: string) => void;
  // Replaces `field-audiod --keys <name>`, for tests.
  command?: { file: string; args: string[] };
}

// `field-audiod --keys`: the native half of `field keys`, which owns the
// virtual MIDI source and reads the keyboard layout. Closing its input
// removes the source, so the source never outlives this process.
export class KeysHelper {
  private closing = false;
  // The system output on macOS, which the voice host names for scsynth.
  defaultOutput: string | undefined;

  private constructor(private readonly child: ChildProcessWithoutNullStreams) {
    // A write after the helper died must not kill this process; the exit
    // handler reports why the helper went.
    child.stdin.on('error', () => {});
  }

  static start(name: string, options: HelperOptions = {}): Promise<KeysHelper> {
    const command = options.command ?? { file: requireDaemon(), args: ['--keys', name] };
    const child = spawn(command.file, command.args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const helper = new KeysHelper(child);
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-2000);
    });

    return new Promise((resolve, reject) => {
      let ready = false;
      let lastError: string | undefined;
      const why = (code: number | null, signal: NodeJS.Signals | null): string =>
        lastError ?? (stderr.trim() || `field-audiod --keys exited ${signal !== null ? `on ${signal}` : `with code ${code}`}`);

      child.on('error', (err) => reject(new Error(`could not start field-audiod --keys: ${err.message}`)));
      child.on('exit', (code, signal) => {
        if (!ready) reject(new Error(why(code, signal)));
        else if (!helper.closing) options.onExit?.(why(code, signal));
      });

      createInterface({ input: child.stdout }).on('line', (line) => {
        if (line.trim() === '') return;
        let parsed: z.infer<typeof helperLine>;
        try {
          parsed = helperLine.parse(JSON.parse(line));
        } catch {
          lastError = `field-audiod --keys printed an unexpected line: ${line}`;
          return;
        }
        if ('keyboard' in parsed) options.onKeyboard?.(parsed.keyboard);
        else if ('error' in parsed) lastError = parsed.error;
        else if (!ready) {
          ready = true;
          helper.defaultOutput = parsed.output;
          resolve(helper);
        }
      });
    });
  }

  send(message: MidiMessage): void {
    if (!this.closing) this.child.stdin.write(`${JSON.stringify({ midi: message })}\n`);
  }

  close(): Promise<number | null> {
    this.closing = true;
    if (this.child.exitCode !== null || this.child.signalCode !== null) return Promise.resolve(this.child.exitCode);
    return new Promise((resolve) => {
      this.child.once('exit', (code) => resolve(code));
      this.child.stdin.end();
    });
  }
}

function requireDaemon(): string {
  const binary = daemonBinary();
  if (binary === undefined) {
    throw new Error(`field-audiod is not built (${BUILD_DAEMON}, or set FIELD_AUDIOD)`);
  }
  return binary;
}
