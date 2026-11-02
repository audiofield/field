import type { AudiodClient } from './client.js';
import { compileSession, type CompiledSession, type SessionInput } from '../graph/live.js';

// The inputs a song's input windows read, each named
// `<kind>:<song>/<track>`: the ring of a voice that `field keys` plays,
// `keys:` (live-supercollider.md chunk 3), that `field seq` plays, `seq:`,
// and that `field sc voice` plays, `voice:` (sequencer.md §2.6), and an
// armed input a `field record --monitoring host` hears, `capture:`
// (live-supercollider.md §12). Every command that loads a song's session
// compiles in the ones open for it, so a reload from `field play`, its
// watch, `field ui`, or `field record` keeps all four heard. A `seq:`
// input also tells the compile that its track's notes play live
// (src/graph/live.ts).
export type LiveInputKind = 'keys' | 'seq' | 'voice' | 'capture';
const LIVE_INPUT = /^(?:keys|seq|voice|capture):([^/]+)\/(.+)$/;

export function liveInputName(kind: LiveInputKind, song: string, track: string): string {
  return `${kind}:${song}/${track}`;
}

// The open inputs for `song`, as `compileSession` takes them.
export async function liveInputsFor(client: AudiodClient, song: string): Promise<SessionInput[]> {
  if (!client.supports('live-input')) return [];
  const { inputs } = await client.status();
  return (inputs ?? []).flatMap(({ name }) => {
    const match = LIVE_INPUT.exec(name);
    return match !== null && match[1] === song ? [{ track: match[2]!, input: name }] : [];
  });
}

// `song` as a reload would compile it now: with whatever inputs are open,
// plus `extra`, and whatever the session loaded now was compiled and set
// with: its loop, its region, and its solo. Throws as compileSession does,
// so a caller can learn before it opens an input that the song cannot
// hear it.
export async function compileWithInputs(
  client: AudiodClient,
  root: string,
  song: string,
  extra: SessionInput[] = [],
): Promise<{ compiled: CompiledSession; region: [number, number] | undefined }> {
  const status = await client.status();
  const same = status.live === true && status.song === song;
  const compiled = await compileSession(root, song, {
    ...(same && status.looping === true ? { loop: true } : {}),
    ...(same && status.solo !== undefined ? { solo: status.solo } : {}),
    inputs: [...(await liveInputsFor(client, song)), ...extra],
  });
  const region: [number, number] | undefined =
    same && status.loop_from !== undefined && status.loop_to !== undefined ? [status.loop_from, status.loop_to] : undefined;
  return { compiled, region };
}

// Loads `song` again as compileWithInputs compiles it. Opening or closing
// an input changes only the inputs.
export async function reloadWithInputs(client: AudiodClient, root: string, song: string): Promise<void> {
  const { compiled, region } = await compileWithInputs(client, root, song);
  await client.session(compiled.session);
  if (region !== undefined) await client.loop(region[0], region[1]);
}

// After closing inputs: loads `song` again without them only while the
// daemon still plays it and no take records, so a song another terminal
// loaded meanwhile plays on, and a take another terminal records keeps
// its bed and its loop region. Under a take, a closed input reads silence
// until the next load.
export async function reloadIfPlaying(client: AudiodClient, root: string, song: string): Promise<void> {
  const status = await client.status();
  if (status.live === true && status.song === song && status.record?.state !== 'recording') {
    await reloadWithInputs(client, root, song);
  }
}
