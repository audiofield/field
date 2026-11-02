import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { resolveRecordTarget } from '../commands/record.js';
import { findProjectRoot, loadProject, type LoadedSong } from '../model/project.js';
import { instrumentPath } from './voice-host.js';

// A bare instrument name resolves on the project's instruments shelf, as a
// supercollider: entry's source does; a path resolves from the project
// root, or from here outside a project (keyboard-instrument.md §2.1).
export function resolveInstrument(spec: string, cwd = process.cwd()): string {
  const root = findProjectRoot(cwd);
  if (root === undefined && !spec.includes('/')) {
    throw new Error(
      `field keys ${spec}: a bare instrument name resolves in a project's shared/instruments/, ` +
        'and this is not inside a Field project; give the program by path instead',
    );
  }
  const path = instrumentPath(spec, root ?? cwd);
  if (!existsSync(path)) {
    const shelf = root !== undefined ? `\n${describeShelf(root)}` : '';
    throw new Error(`field keys ${spec}: no instrument program at ${path}${shelf}`);
  }
  return path;
}

// The programs on a project's instruments shelf, by name, split by whether
// they can play from notes. A program that never reads FIELD_MODE cannot
// answer voice mode, so its text is enough to tell, without starting
// sclang for each one (keys.md "Make an instrument playable"). Each is
// listed by a name field keys resolves: `.scd` is added back only to a
// name with no extension, so pad.v2.scd lists whole.
function shelfInstruments(root: string): { playable: string[]; renderOnly: string[] } {
  const dir = join(root, 'shared', 'instruments');
  const playable: string[] = [];
  const renderOnly: string[] = [];
  if (!existsSync(dir)) return { playable, renderOnly };
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.scd'))
    .map((entry) => entry.name)
    .sort();
  for (const file of files) {
    const stem = file.slice(0, -'.scd'.length);
    const name = extname(stem) === '' ? stem : file;
    (readFileSync(join(dir, file), 'utf8').includes('FIELD_MODE') ? playable : renderOnly).push(name);
  }
  return { playable, renderOnly };
}

function describeShelf(root: string): string {
  const { playable, renderOnly } = shelfInstruments(root);
  if (playable.length + renderOnly.length === 0) return 'shared/instruments/ has no programs yet.';
  const lines = ['In shared/instruments/:', `  plays from notes: ${playable.length > 0 ? playable.join(', ') : 'none'}`];
  if (renderOnly.length > 0) {
    lines.push(`  renders only:     ${renderOnly.join(', ')} (no FIELD_MODE=voice branch; Field's docs/keys.md says how to add one)`);
  }
  return lines.join('\n');
}

// What `field keys` plays (arming.md §2.1): each instrument it was given
// by program, and each track with an instrument it was given or found
// under a track it was given, all at once.
export interface ArmedInstrument {
  program: string; // absolute path to the instrument's program
  track?: string; // the track it plays for, `song/track`
  // Tracks above the one named, the one named, and those down to the
  // track it plays for, top-down, whose inserts the
  // voice does not pass through yet (live-supercollider.md).
  unheardEffects: string[];
}

export function isTrackTarget(target: string): boolean {
  return target.includes('track:');
}

// A target with `track:` in it is a track; anything else is an
// instrument, by name or path, as keyboard-instrument.md §2.1 resolves
// one. Tracks need a project; instruments by path do not.
export function resolveKeysTargets(targets: string[], cwd = process.cwd()): ArmedInstrument[] {
  // One entry per track, or per program given as an instrument; a track
  // reached through several targets keeps the effects of every one.
  const armed = new Map<string, ArmedInstrument>();
  const add = (instrument: ArmedInstrument): void => {
    const key = instrument.track ?? instrument.program;
    const earlier = armed.get(key);
    if (earlier === undefined) armed.set(key, instrument);
    else earlier.unheardEffects = [...new Set([...earlier.unheardEffects, ...instrument.unheardEffects])];
  };
  for (const target of targets) {
    if (!isTrackTarget(target)) {
      add({ program: resolveInstrument(target, cwd), unheardEffects: [] });
      continue;
    }
    const root = findProjectRoot(cwd);
    if (root === undefined) throw new Error(`field keys ${target}: a track resolves inside a Field project`);
    const { song: songName, track } = resolveRecordTarget(root, target);
    const project = loadProject(root);
    const song = project.songs.find((s) => s.name === songName)!;
    const found = instrumentTracksUnder(song, track);
    if (found.length === 0) {
      throw new Error(
        `field keys ${target}: no instrument there — give the track one with \`instrument: <name>\`, ` +
          'or name a track under it that has one',
      );
    }
    if (found.length > 1) {
      throw new Error(
        `field keys ${target}: ${found.length} tracks with instruments are under ${track}, and field keys ` +
          `plays the ones you name: ${found.map((f) => `${songName}/track:${f.track}`).join(', ')}`,
      );
    }
    // resolveRecordTarget loads a valid project, and validation already
    // refuses an instrument with no program.
    const [played] = found as [InstrumentTrack];
    add({
      program: instrumentPath(played.instrument, root),
      track: `${songName}/${played.track}`,
      unheardEffects: [...new Set([...effectsAbove(song, track), ...played.effects])],
    });
  }
  return [...armed.values()];
}

// The tracks above `name` with inserts, top-down from main: what a voice
// on `name` passes through on its way to the speakers, besides the
// effects on and under `name` itself.
function effectsAbove(song: LoadedSong, name: string): string[] {
  const byName = new Map(song.tracks.map((t) => [t.data.name, t.data]));
  const found = new Set<string>();
  const visit = (trackName: string, above: string[], path: Set<string>): void => {
    if (trackName === name) {
      for (const effect of above) found.add(effect);
      return;
    }
    const track = byName.get(trackName);
    if (track === undefined || path.has(trackName)) return;
    const effects = track.inserts.length > 0 ? [...above, trackName] : above;
    const onPath = new Set(path).add(trackName);
    for (const entry of track.inputs) if (entry.track !== undefined) visit(entry.track, effects, onPath);
  };
  visit('main', [], new Set());
  return [...found];
}

interface InstrumentTrack {
  track: string;
  instrument: string;
  effects: string[]; // tracks on the way down, this one included, that have inserts
}

// The named track itself when it has an instrument; otherwise every such
// track under it, down its `track:` inputs, once each however many paths
// reach it, with the effects of all of them.
function instrumentTracksUnder(song: LoadedSong, name: string): InstrumentTrack[] {
  const byName = new Map(song.tracks.map((t) => [t.data.name, t.data]));
  const found = new Map<string, InstrumentTrack>();
  const visit = (trackName: string, above: string[], path: Set<string>): void => {
    const track = byName.get(trackName);
    if (track === undefined || path.has(trackName)) return;
    const effects = track.inserts.length > 0 ? [...above, trackName] : above;
    const instrument = track.instrument;
    if (instrument !== undefined) {
      const earlier = found.get(trackName);
      found.set(trackName, {
        track: trackName,
        instrument,
        effects: [...new Set([...(earlier?.effects ?? []), ...effects])],
      });
      return;
    }
    const onPath = new Set(path).add(trackName);
    for (const entry of track.inputs) if (entry.track !== undefined) visit(entry.track, effects, onPath);
  };
  visit(name, [], new Set());
  return [...found.values()];
}
