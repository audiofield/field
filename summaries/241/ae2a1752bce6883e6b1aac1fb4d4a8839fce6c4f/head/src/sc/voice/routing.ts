import { AudiodClient } from '../../audiod/client.js';
import { liveInputName, reloadIfPlaying, reloadWithInputs } from '../../audiod/live-inputs.js';
import { BUILD_DAEMON } from '../../remedies.js';
import { fieldOutPluginDir } from './host.js';

// A voice to play: its program, and the track it plays for, `song/track`,
// or none for an instrument named by program.
export interface Voice {
  program: string;
  track?: string | undefined;
}

// The commands that host voices, by the kind of input each opens for a
// track's voice (sequencer.md §2.6).
export type VoiceInputKind = 'keys' | 'seq' | 'voice';
const COMMAND: Record<VoiceInputKind, string> = { keys: 'field keys', seq: 'field seq', voice: 'field sc voice' };

// Playing through the effects (live-supercollider.md chunk 3): each
// track gets an input in the daemon, named for the command that plays
// it, the song's live session is loaded with those inputs, and the voice
// host writes each track's voice into its input's ring through FieldOut.
// An instrument named by program, with no track, still plays straight to
// the device.
export interface Routing {
  // One program per voice, in order: a track gets its own voice, even
  // when it shares a program with another, because its voice goes to its
  // own ring.
  programs: string[];
  // Each entry's ring, or null for one that plays straight to the device.
  rings: (number | null)[];
  fieldOut: string;
  // The daemon's output device, which the voice host must boot on so the
  // two share a clock; undefined when the daemon names none (null output).
  device: string | undefined;
  // Whether FieldOut is writing every ring this routing opened, within
  // `ms`: FieldOut writes every block, silence included, so a ring that
  // stays empty means scsynth never ran the route.
  flowing(ms?: number): Promise<boolean>;
  // Closes every input this routing opened and loads the song again with
  // whatever inputs others still hold, so the daemon is not left reading
  // rings nobody writes.
  close(): Promise<void>;
}

// Why the voice plays dry instead, said on the instrument's line.
export interface Unrouted {
  reason: string;
}

export async function routeVoices(
  armed: readonly Voice[],
  root: string,
  options: { kind: VoiceInputKind; device?: string; env?: NodeJS.ProcessEnv },
): Promise<Routing | Unrouted | undefined> {
  const tracks = armed.filter((a) => a.track !== undefined);
  if (tracks.length === 0) return undefined;
  const songs = [...new Set(tracks.map((a) => a.track!.split('/')[0]!))];
  if (songs.length > 1) return { reason: `the tracks are in ${songs.join(' and ')}, and one session plays one song` };
  if (process.platform === 'win32') return { reason: 'live inputs need POSIX shared memory, which Windows does not have yet' };
  const fieldOut = fieldOutPluginDir(options.env);
  if (fieldOut === undefined) {
    const named = (options.env ?? process.env)['FIELD_FIELDOUT'];
    return {
      reason:
        named !== undefined && named !== ''
          ? `FIELD_FIELDOUT names ${named}, which holds no FieldOut plugin`
          : `FieldOut is not built: run ${BUILD_DAEMON}`,
    };
  }

  let client: AudiodClient;
  try {
    client = await AudiodClient.connect(root);
  } catch (err) {
    return { reason: `field-audiod did not answer: ${(err as Error).message.split('\n')[0]!}` };
  }
  const opened: string[] = [];
  const song = songs[0]!;
  const closeOpened = async (): Promise<void> => {
    for (const name of opened.splice(0)) await client.closeInput(name).catch(() => {});
  };
  // The song with whatever inputs are open now, others' included; this
  // load changes only the inputs.
  const reload = (): Promise<void> => reloadWithInputs(client, root, song);
  const unrouted = async (reason: string): Promise<Unrouted> => {
    if (opened.length > 0) {
      await closeOpened();
      await reloadIfPlaying(client, root, song).catch(() => {});
    }
    client.close();
    return { reason };
  };
  try {
    // Loading a session under a take swaps the bed it is recording
    // against, and a loop take's region cannot be set again while it
    // records.
    if ((await client.status()).record?.state === 'recording') {
      client.close();
      return { reason: `a take is recording: start ${COMMAND[options.kind]} again once it stops` };
    }
    if (!client.supports('live-input')) {
      return await unrouted(`field-audiod ${client.daemonVersion} predates live inputs: run field transport quit, then play again`);
    }
    // The voice is heard on the daemon's device, so it must be made on
    // that device's clock too.
    const daemonDevice = (await client.status()).device?.name;
    if (options.device !== undefined && daemonDevice !== undefined && options.device !== daemonDevice) {
      return await unrouted(`--device names ${options.device}, but the daemon plays on ${daemonDevice}`);
    }
    const rings: (number | null)[] = [];
    for (const entry of armed) {
      if (entry.track === undefined) {
        rings.push(null);
        continue;
      }
      const name = liveInputName(options.kind, song, entry.track.slice(song.length + 1));
      const { ring } = await client.openInput(name);
      opened.push(name);
      rings.push(ring);
    }
    await reload();
    // A device that cannot run at the song's rate makes the daemon
    // convert, and an input is written at the device's rate.
    const status = await client.status();
    if (status.resampling) {
      return await unrouted(`the device does not run at the song's ${status.sample_rate} Hz, so the daemon converts it`);
    }
    return {
      programs: armed.map((a) => a.program),
      rings,
      fieldOut,
      device: daemonDevice,
      flowing: async (ms = 2000) => {
        const deadline = Date.now() + ms;
        for (;;) {
          const written = new Map(((await client.status()).inputs ?? []).map((i) => [i.name, i.written]));
          if (opened.every((name) => (written.get(name) ?? 0) > 0)) return true;
          if (Date.now() > deadline) return false;
          await new Promise((r) => setTimeout(r, 100));
        }
      },
      close: async () => {
        try {
          await closeOpened();
          // The song as it is now: without these inputs, with any others,
          // while the daemon still plays it and no take records. A song
          // that no longer compiles keeps the session it has.
          await reloadIfPlaying(client, root, song);
        } catch {
          // the daemon or the project went away; nothing is left to restore
        } finally {
          client.close();
        }
      },
    };
  } catch (err) {
    return await unrouted((err as Error).message.split('\n')[0]!);
  }
}
