import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILD_DAEMON } from '../remedies.js';
import { socketPathFor as sharedSocketPath } from '../socketPath.js';
import type { z } from 'zod';
import {
  armMidiResponseSchema,
  armTracksResponseSchema,
  armResponseSchema,
  devicesResponseSchema,
  errorResponseSchema,
  eventSchema,
  helloResponseSchema,
  inputResponseSchema,
  loadResponseSchema,
  midiOutResponseSchema,
  okResponseSchema,
  PROTOCOL_VERSION,
  recordResponseSchema,
  recordingsResponseSchema,
  recoverResponseSchema,
  SOCKET_RELATIVE,
  statusResponseSchema,
  stopResponseSchema,
  type ArmTrack,
  type ChasedController,
  type AudiodEvent,
  type ClickSchedule,
  type MidiOut,
} from './protocol.js';

// Client for the per-project field-audiod daemon (playback.md §3): connects
// to .field/audiod.sock, spawning the daemon on demand when nobody owns the
// socket — daemon-lite lifecycle. The daemon runs with its cwd at the
// project root and a root-relative socket path, keeping the bound path
// inside sun_path's 104 bytes regardless of how deep the project lives.

// The built daemon binary, or undefined if it has not been built. FIELD_AUDIOD
// overrides for wrappers and tests; the default is the CMake output inside
// this package (dist/audiod/client.js → package root → native build dir).
export function daemonBinary(): string | undefined {
  const override = process.env['FIELD_AUDIOD'];
  if (override) {
    // Resolved now because the daemon spawns with its cwd at the project
    // root, where a relative override would no longer mean anything.
    const absolute = resolve(override);
    if (!existsSync(absolute)) {
      throw new Error(`FIELD_AUDIOD points at a missing binary: ${override}`);
    }
    return absolute;
  }
  const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  // Same artefact directory on every platform — MSVC is a multi-config
  // generator, but build:native pins --config Release, so the layout
  // matches the single-config one. Only the suffix differs.
  const built = join(
    packageRoot,
    `native/audiod/build/field-audiod_artefacts/Release/field-audiod${process.platform === 'win32' ? '.exe' : ''}`,
  );
  return existsSync(built) ? built : undefined;
}

function socketPathFor(root: string): string {
  return sharedSocketPath(root, SOCKET_RELATIVE);
}

function tryConnect(path: string, timeoutMs: number): Promise<Socket | undefined> {
  return new Promise((resolve) => {
    const socket = createConnection(path);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(undefined);
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', () => {
      clearTimeout(timer);
      resolve(undefined);
    });
  });
}

export interface ConnectOptions {
  spawnIfNeeded?: boolean;
  nullOutput?: boolean; // spawn flag, for tests
  idleSeconds?: number; // spawn flag
}

export class AudiodClient extends EventEmitter {
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (response: unknown) => void; reject: (err: Error) => void }
  >();
  private buffer = '';

  // What the daemon's hello declared; connect() fills all three.
  readonly features: string[] = [];
  readonly pid: number | undefined = undefined;

  private constructor(
    private readonly socket: Socket,
    readonly daemonVersion: string,
  ) {
    super();
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('error', () => {}); // close handles it; a raw error must not crash the CLI
    socket.on('close', () => {
      // A dead daemon must surface as an error on every in-flight request,
      // never as a silent hang.
      for (const [, entry] of this.pending) {
        entry.reject(new Error('field-audiod connection closed'));
      }
      this.pending.clear();
      this.emit('close');
    });
  }

  static async connect(root: string, options: ConnectOptions = {}): Promise<AudiodClient> {
    const path = socketPathFor(root);
    let socket = await tryConnect(path, 1000);
    if (!socket) {
      if (!(options.spawnIfNeeded ?? true)) {
        throw new Error('field-audiod is not running');
      }
      const binary = daemonBinary();
      if (!binary) {
        throw new Error(`field-audiod is not built (${BUILD_DAEMON}, or set FIELD_AUDIOD)`);
      }
      // POSIX gets the relative path (the daemon binds it against its
      // cwd, staying inside sun_path); Windows gets the full pipe name,
      // since a pipe is not a filesystem path and cwd means nothing to
      // it. Client and daemon agree because both strings come from here.
      const args = ['--socket', process.platform === 'win32' ? path : SOCKET_RELATIVE];
      // FIELD_AUDIOD_NULL covers spawns the caller doesn't parameterize
      // (field play in CI or on a deviceless machine).
      if (options.nullOutput ?? process.env['FIELD_AUDIOD_NULL'] === '1') args.push('--null-output');
      if (options.idleSeconds !== undefined) args.push('--idle', String(options.idleSeconds));
      // .field/ is otherwise created lazily by the build cache; a project
      // that has never built must still be able to spawn the daemon
      // (which also binds its socket in there).
      mkdirSync(join(root, '.field'), { recursive: true });
      // A detached daemon's stderr would otherwise vanish; the log is the
      // only witness when startup fails.
      const log = openSync(join(root, '.field', 'audiod.log'), 'a');
      const child = spawn(binary, args, { cwd: root, detached: true, stdio: ['ignore', 'ignore', log] });
      child.on('error', () => {}); // surfaced as the connect timeout below
      child.unref();
      closeSync(log);
      // The daemon binds before serving; poll rather than racing it. The
      // window is generous because a loaded machine (CI, parallel tests)
      // can be slow to schedule the new process.
      for (let attempt = 0; attempt < 120 && !socket; attempt++) {
        await new Promise((r) => setTimeout(r, 50));
        socket = await tryConnect(path, 250);
      }
      if (!socket) throw new Error('field-audiod did not start (spawned but never answered)');
    }

    const client = new AudiodClient(socket, 'unknown');
    const hello = await client.request('hello', {}, helloResponseSchema);
    if (hello.protocol !== PROTOCOL_VERSION) {
      client.close();
      throw new Error(
        `field-audiod speaks protocol ${hello.protocol}, this CLI speaks ${PROTOCOL_VERSION} — rebuild the daemon`,
      );
    }
    (client as { daemonVersion: string }).daemonVersion = hello.version;
    (client as { features: string[] }).features = hello.features;
    (client as { pid: number | undefined }).pid = hello.pid;
    return client;
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8');
    let newline;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue; // a malformed daemon line must not crash the CLI
      }
      if (typeof message['id'] === 'number') {
        const entry = this.pending.get(message['id']);
        if (entry) {
          this.pending.delete(message['id']);
          entry.resolve(message);
        }
      } else if (typeof message['event'] === 'string') {
        const event = eventSchema.safeParse(message);
        if (event.success) this.emit('event', event.data satisfies AudiodEvent);
      }
    }
  }

  async request<T>(
    op: string,
    params: Record<string, unknown>,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const id = this.nextId++;
    const raw = await new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.write(JSON.stringify({ id, op, ...params }) + '\n', (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
    const error = errorResponseSchema.safeParse(raw);
    if (error.success) throw new Error(`audiod ${op}: ${error.data.error}`);
    return schema.parse(raw);
  }

  devices() {
    return this.request('devices', {}, devicesResponseSchema);
  }
  selectDevice(name: string) {
    return this.request('device.select', { name }, okResponseSchema);
  }
  // Capability check (realtime.md §3): the hello's features array, so
  // callers stop parsing daemonVersion.
  supports(feature: string): boolean {
    return this.features.includes(feature);
  }
  // The compiled live session (session.ts). Requires supports('session').
  session(session: unknown) {
    return this.request('session', { session }, loadResponseSchema);
  }
  // A live input (live-supercollider.md §2): a ring FieldOut writes,
  // which the session's input window named `name` reads. Requires
  // supports('live-input').
  openInput(name: string) {
    return this.request('input', { name }, inputResponseSchema);
  }
  closeInput(name: string) {
    return this.request('input_close', { name }, okResponseSchema);
  }
  // A window gain glide on the live session (session.ts rampRequestSchema).
  ramp(track: string, input: number, gainDb: number, rampMs = 15) {
    return this.request(
      'ramp',
      { track, input, gain_db: gainDb, ramp_ms: rampMs },
      okResponseSchema,
    );
  }
  load(path: string, loop = false) {
    // The flag is only sent when set: an older daemon would silently
    // ignore it, so callers version-guard before asking (play.ts).
    return this.request('load', loop ? { path, loop: true } : { path }, loadResponseSchema);
  }
  play() {
    return this.request('play', {}, okResponseSchema);
  }
  // Both end a take in progress and hand its manifest back (recording.md
  // §6): the caller that stopped gets the take without a second
  // round-trip; everyone else hears the `take` event.
  pause() {
    return this.request('pause', {}, stopResponseSchema);
  }
  stop() {
    return this.request('stop', {}, stopResponseSchema);
  }
  // The input side (recording.md §5–6). All require supports('record').
  // `input` counts from 1, as a person reads it off the interface; an
  // absent device means the system's default input.
  arm(track: string, input: number, device?: string) {
    return this.request(
      'arm',
      device !== undefined ? { track, input, device } : { track, input },
      armResponseSchema,
    );
  }
  // Arm for MIDI (keyboard-instrument.md §12.4, supports('record-midi')):
  // every MIDI input the daemon can see, and no audio input. A take then
  // records their messages; `record` and `stop` work as for audio, and
  // loop takes are refused. `controllers` (supports('midi-chase')) are
  // where the take starts.
  armMidi(track: string, controllers: ChasedController[] = []) {
    return this.request('arm', { track, kind: 'midi', ...chase(controllers) }, armMidiResponseSchema);
  }

  // Arms every track at once (arming.md §2.2), on `device` for the audio
  // ones; daemon feature "record-tracks".
  armTracks(tracks: ArmTrack[], device?: string, controllers: ChasedController[] = []) {
    return this.request(
      'arm',
      { tracks, ...(device !== undefined ? { device } : {}), ...chase(controllers) },
      armTracksResponseSchema,
    );
  }
  disarm() {
    return this.request('disarm', {}, okResponseSchema);
  }
  // Start a take: at `at` (a sample on the bed's timeline, needing a
  // loaded bed) or wherever the transport is. The response carries the
  // transaction id and the position the callback latched. With `start`
  // (recording.md §7, needs supports('record-start')) the transport
  // pre-rolls from there and the take begins exactly at `at`; the
  // response's position is -1 until then, and status says pending.
  // `until` (recording.md §10.4, supports('record-until')) ends the take
  // on that exact sample and finalizes it while the transport keeps
  // going; `loop` makes the live session loop [at, until) with every
  // pass a take, each arriving as a `take` event.
  record(at?: number, start?: number, until?: number, loop?: boolean) {
    return this.request(
      'record',
      {
        ...(at !== undefined ? { at } : {}),
        ...(start !== undefined ? { start } : {}),
        ...(until !== undefined ? { until } : {}),
        ...(loop === true ? { loop: true } : {}),
      },
      recordResponseSchema,
    );
  }
  // The live session's region loop (supports('loop-region')): the clock
  // wraps from `to` — the content's extent when omitted — back to
  // `from`. No arguments clears it.
  loop(from?: number, to?: number) {
    return this.request(
      'loop',
      { ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}) },
      okResponseSchema,
    );
  }
  // The metronome schedule (protocol.ts clickScheduleSchema). Requires
  // supports('click'); an empty ticks list clears it, and so does loading
  // a new bed.
  click(schedule: ClickSchedule) {
    return this.request('click', schedule, okResponseSchema);
  }
  // A MIDI output (protocol.ts midiOutSchema). Requires supports('midi-out').
  // Under a name already open, it replaces the schedule and keeps the
  // port; the output closes with this connection.
  midiOut(output: MidiOut) {
    return this.request('midi_out', output, midiOutResponseSchema);
  }
  closeMidiOut(name: string) {
    return this.request('midi_out_close', { name }, okResponseSchema);
  }
  // Every transaction under .field/recording/, complete or not.
  recordings() {
    return this.request('recordings', {}, recordingsResponseSchema);
  }
  // Patch the header of a transaction a dead daemon left behind. The
  // field is `transaction` because `id` is the request's own.
  recover(id: string) {
    return this.request('recover', { transaction: id }, recoverResponseSchema);
  }
  locate(sample: number) {
    return this.request('locate', { sample }, okResponseSchema);
  }
  status() {
    return this.request('status', {}, statusResponseSchema);
  }
  quit() {
    return this.request('quit', {}, okResponseSchema);
  }

  close(): void {
    this.socket.destroy();
  }
}

// An arm names `controllers` only when it has some, so a daemon without
// "midi-chase" never sees the field.
function chase(controllers: ChasedController[]): { controllers?: ChasedController[] } {
  return controllers.length > 0 ? { controllers } : {};
}
