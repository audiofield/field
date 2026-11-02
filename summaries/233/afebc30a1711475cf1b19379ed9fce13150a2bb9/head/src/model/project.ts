import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { parseDocument } from 'yaml';
import type { z } from 'zod';
import { PROJECT_MANIFEST } from '../constants.js';
import { readWavHeader } from '../audio/wav.js';
import { generatorFor } from '../generators/index.js';
import { entryRef, expandLoop, generatorName, mintsGenerator, partRenders, placedWindow } from '../generators/stem.js';
import { validateInstrument } from '../generators/voice-render.js';
import { isSlug } from '../ids.js';
import { notesFileOrder, notesFileSchema, type NotesFile } from '../schema/notes.js';
import { notesLength, placementAnchor, resolveNotes, takeAnchor } from '../time/notes.js';
import { MeterMap, TempoMap } from '../time/tempo.js';
import { canonicalText, hasAnchorsOrAliases, type KeyOrder } from '../yaml/emit.js';
import { checkCables, entryName, type Cable } from './cables.js';
import {
  findInstalled,
  indexStateBlobs,
  pluginSlug,
  readInventory,
  resolveStateRef,
  type PluginInventory,
  type StateBlob,
} from '../audio/plugins.js';
import { sha256File } from '../hash.js';
import { genRefName, recordRefName, sharedAssetName, SONG_OUTPUT_NAME } from '../labels.js';
import type { SourceNames } from '../generators/types.js';
import {
  assetsFileOrder,
  assetsFileSchema,
  projectOrder,
  projectSchema,
  songOrder,
  songSchema,
  generativeTakesOrder,
  generativeTakesSchema,
  TAKES_FILENAME,
  RECORD_TAKES_FILENAME,
  isMidiTakeRow,
  recordTakesOrder,
  recordTakesSchema,
  trackOrder,
  trackSchema,
  type Asset,
  type AssetsFile,
  type GenerativeTakes,
  type RecordTakes,
  type Project,
  type Song,
  type SongTime,
  type Track,
} from '../schema/index.js';

export interface Diagnostic {
  file: string; // project-relative path
  message: string;
  // Absent means error — the gate stays shut. A warning reports without
  // failing anything: `check` prints it and still says ok, `build`
  // proceeds, `watch` keeps building (nested-tracks.md §19 chunk 4,
  // which needed the level for a dangling cable end: wiring
  // incrementally is normal, so half a cable must not stop the mix).
  severity?: 'warning';
}

export const diagnosticErrors = (diagnostics: Diagnostic[]): Diagnostic[] =>
  diagnostics.filter((d) => d.severity === undefined);
export const diagnosticWarnings = (diagnostics: Diagnostic[]): Diagnostic[] =>
  diagnostics.filter((d) => d.severity === 'warning');

// The one spelling of a diagnostic line, so `check`, `build` and `watch`
// cannot drift on how a warning announces itself.
export function formatDiagnostic(d: Diagnostic): string {
  return `${d.file}: ${d.severity === 'warning' ? 'warning: ' : ''}${d.message}`;
}

// Every loaded file carries the KeyOrder it was validated under, so
// formatting decisions never re-infer a file's role from its path.
export interface LoadedFile<T> {
  path: string; // project-relative
  data: T;
  raw: string;
  order: KeyOrder;
}

export interface LoadedSong {
  name: string;
  dir: string; // project-relative
  song?: LoadedFile<Song> | undefined;
  // song.yaml's `time:`, surfaced beside the file it rides in.
  time?: SongTime | undefined;
  assets?: LoadedFile<AssetsFile> | undefined;
  tracks: LoadedFile<Track>[];
  // Run-recorded state for `generative:` entries, keyed by gen node
  // name (nested-tracks.md §18 step 3): audio/<name>/variants.yaml,
  // merged here once so nothing downstream learns the file layout.
  // Absent from the map means nothing has been generated yet, which is
  // legal.
  genTakes: Map<string, LoadedFile<GenerativeTakes>>;
  // The same for `record:` entries (recording.md §3), keyed by record
  // node name: audio/<name>/takes.yaml. Absent means nothing has been
  // recorded yet, which builds as silence (§4).
  recordTakes: Map<string, LoadedFile<RecordTakes>>;
  // The song's parts (sequencer.md §3.2): songs/<song>/notes/<name>.yaml,
  // keyed by name, whether or not an entry places them.
  parts: Map<string, LoadedFile<NotesFile>>;
  // Each chosen MIDI take's notes file, keyed by the take's ledger name.
  // Read for the render and never formatted: the ledger pins its bytes.
  takeNotes: Map<string, LoadedFile<NotesFile>>;
  // The song's resolved cables (nested-tracks.md §19), derived by
  // validate: complete, acyclic, arrivals agreed. The graph consumes
  // these rather than re-walking, so check and build cannot answer
  // "when does this signal arrive" differently. Dangling and broken
  // cables never appear here — their diagnostics do.
  cables: Cable[];
}

export interface LoadedProject {
  root: string; // absolute
  manifest?: LoadedFile<Project> | undefined;
  // shared/assets.yaml — the shared scope's ledger, same shape as a
  // song's, paths relative to shared/ (project-layout.md §1.6).
  shared?: LoadedFile<AssetsFile> | undefined;
  songs: LoadedSong[];
  diagnostics: Diagnostic[];
}

export function findProjectRoot(from: string): string | undefined {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, PROJECT_MANIFEST))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

interface FileSpec<T> {
  schema: z.ZodType<T>;
  order: KeyOrder;
}

// Project-relative paths are slash-separated wherever they are data, not
// display: label pkgs derive from song.dir, diagnostics quote the paths
// YAML spells with `/` (the schemas reject `\` outright), and the graph
// compares them as strings. `relative()` answers in the platform
// separator, so on Windows the raw answer would put backslashes inside
// labels and no typed pattern could ever match. join() accepts the
// forward slashes on the way back in, on every platform.
export function projectPath(root: string, absPath: string): string {
  return relative(root, absPath).split(sep).join('/');
}

function loadFile<T>(
  project: LoadedProject,
  absPath: string,
  spec: FileSpec<T>,
): LoadedFile<T> | undefined {
  const path = projectPath(project.root, absPath);
  let raw: string;
  try {
    raw = pendingOverride?.path === resolve(absPath) ? pendingOverride.text : readFileSync(absPath, 'utf8');
  } catch (err) {
    project.diagnostics.push({ file: path, message: `unreadable: ${(err as Error).message}` });
    return undefined;
  }
  const doc = parseDocument(raw);
  if (doc.errors.length > 0) {
    project.diagnostics.push({ file: path, message: `invalid YAML: ${doc.errors[0]!.message}` });
    return undefined;
  }
  if (hasAnchorsOrAliases(doc)) {
    project.diagnostics.push({
      file: path,
      message: 'anchors and aliases are not allowed in project files',
    });
    return undefined;
  }
  const parsed = spec.schema.safeParse(doc.toJS());
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const at = issue.path.length > 0 ? ` at ${issue.path.join('.')}` : '';
      project.diagnostics.push({ file: path, message: `${issue.message}${at}` });
    }
    return undefined;
  }
  return { path, data: parsed.data, raw, order: spec.order };
}

// Dotfiles are editor debris, not project files: Emacs writes a dangling
// symlink named `.#track.yaml` while a buffer is unsaved, which ends in
// .yaml and would otherwise be loaded — under `build --watch` that turns
// simply opening a file into a load error (#34 review footnote).
function yamlFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yaml') && !f.startsWith('.'))
    .sort()
    .map((f) => join(dir, f));
}

// The takes beside a generative request's audio, if a run has happened.
// Absent is not a diagnostic: a request with no takes is a request rather
// than a broken record (bloom-in-tree.md §3), and `build` is what refuses.
// A malformed one *is* diagnosed, against its own path, so the message
// points at the file you would edit.
export function takesPath(songDir: string, genName: string): string {
  return join(songDir, 'audio', genName, TAKES_FILENAME);
}

// A generative entry's takes, beside the audio under its gen node's
// name (nested-tracks.md §18 step 3): audio/<name>/variants.yaml with
// `gen: <name>`. Absent is legal — a request with no takes is the shape
// a project ships in.
function loadEntryTakes(
  project: LoadedProject,
  songDirAbs: string,
  genName: string,
): LoadedFile<GenerativeTakes> | undefined {
  const abs = takesPath(songDirAbs, genName);
  if (!existsSync(abs)) return undefined;
  const loaded = loadFile(project, abs, {
    schema: generativeTakesSchema,
    order: generativeTakesOrder,
  });
  if (!loaded) return undefined;
  if (loaded.data.gen !== genName) {
    project.diagnostics.push({
      file: loaded.path,
      message: `takes name "${loaded.data.gen}" must match the directory audio/${genName}/`,
    });
    return undefined;
  }
  return loaded;
}

// A record entry's takes, beside the audio under its record node's name
// (recording.md §3): audio/<name>/takes.yaml with `record: <name>`.
// Absent is legal — a session that has not happened yet.
export function recordTakesPath(songDir: string, name: string): string {
  return join(songDir, 'audio', name, RECORD_TAKES_FILENAME);
}

function loadRecordTakes(
  project: LoadedProject,
  songDirAbs: string,
  name: string,
): LoadedFile<RecordTakes> | undefined {
  const abs = recordTakesPath(songDirAbs, name);
  if (!existsSync(abs)) return undefined;
  const loaded = loadFile(project, abs, { schema: recordTakesSchema, order: recordTakesOrder });
  if (!loaded) return undefined;
  if (loaded.data.record !== name) {
    project.diagnostics.push({
      file: loaded.path,
      message: `takes name "${loaded.data.record}" must match the directory audio/${name}/`,
    });
    return undefined;
  }
  return loaded;
}

// The take a record node plays: the row `chosen` names, if any.
export function chosenTake(takes: RecordTakes | undefined) {
  if (takes?.chosen === undefined) return undefined;
  return takes.takes.find((t) => t.asset === takes.chosen);
}

// Where a committed source's bytes live (undefined for anything that
// renders): the song's ledger, the shared ledger, a generative entry's
// chosen take, or a record entry's. The one resolver for both passes — validate's
// loop tiling and buildGraph's planning must answer alike, and two
// constructions of one relation is how the #58 asset readings came to
// disagree. `base` is the project-relative root the file resolves
// against (the song's directory, or shared).
export function committedFileResolver(
  project: LoadedProject,
  song: LoadedSong,
): (ref: string) => { base: string; file: string } | undefined {
  const sharedFileByName = new Map(project.shared?.data.assets.map((a) => [a.name, a.file]) ?? []);
  const assetFileByName = new Map(song.assets?.data.assets.map((a) => [a.name, a.file]) ?? []);
  return (ref) => {
    const shared = sharedAssetName(ref);
    if (shared !== undefined) {
      const file = sharedFileByName.get(shared);
      return file !== undefined ? { base: 'shared', file } : undefined;
    }
    const asset = assetFileByName.get(ref);
    if (asset !== undefined) return { base: song.dir, file: asset };
    // A generative entry's chosen take is committed content under its
    // gen node's name.
    const gen = genRefName(ref);
    if (gen !== undefined) {
      const takes = song.genTakes.get(gen)?.data;
      const variant = takes?.chosen !== undefined ? takes.variants[takes.chosen - 1] : undefined;
      if (variant) return { base: song.dir, file: variant.file };
    }
    // A record entry's chosen take pins in the ledger like imported
    // audio (project-layout.md §1.6), so its row names an asset there.
    const rec = recordRefName(ref);
    if (rec !== undefined) {
      const take = chosenTake(song.recordTakes.get(rec)?.data);
      const file = take !== undefined ? assetFileByName.get(take.asset) : undefined;
      if (file !== undefined) return { base: song.dir, file };
    }
    return undefined;
  };
}

// A file's text as it would be, for one load: `field ui` asks whether an
// edit leaves the project valid before it writes the edit, so the file
// on disk never holds a state the loader refuses. Set only for the
// duration of one synchronous loadProject call.
let pendingOverride: { path: string; text: string } | undefined;

export function loadProject(
  root: string,
  options: { override?: { path: string; text: string } } = {},
): LoadedProject {
  pendingOverride = options.override && { path: resolve(options.override.path), text: options.override.text };
  try {
    return loadProjectFiles(root);
  } finally {
    pendingOverride = undefined;
  }
}

function loadProjectFiles(root: string): LoadedProject {
  const project: LoadedProject = { root: resolve(root), songs: [], diagnostics: [] };

  project.manifest = loadFile(project, join(project.root, PROJECT_MANIFEST), {
    schema: projectSchema,
    order: projectOrder,
  });

  const sharedAssets = join(project.root, 'shared', 'assets.yaml');
  if (existsSync(sharedAssets)) {
    project.shared = loadFile(project, sharedAssets, {
      schema: assetsFileSchema,
      order: assetsFileOrder,
    });
  }

  const songsDir = join(project.root, 'songs');
  const songDirs = existsSync(songsDir)
    ? readdirSync(songsDir)
        .sort()
        .map((name) => join(songsDir, name))
        .filter((p) => statSync(p).isDirectory())
    : [];

  for (const dir of songDirs) {
    const song: LoadedSong = {
      name: basename(dir),
      dir: projectPath(project.root, dir),
      tracks: [],
      genTakes: new Map(),
      recordTakes: new Map(),
      parts: new Map(),
      takeNotes: new Map(),
      cables: [],
    };

    // The casts on time-carrying files (song, tracks) are
    // the load boundary of musical-time.md §1.6: their schemas parse the
    // file types, whose time fields may be [bar, beat?, tick?] arrays;
    // validate() resolves every array to a tick scalar (or diagnoses)
    // before loadProject returns, which is what makes the resolved types
    // true for every caller.
    const songYaml = join(dir, 'song.yaml');
    if (existsSync(songYaml)) {
      song.song = loadFile(project, songYaml, { schema: songSchema, order: songOrder }) as
        | LoadedFile<Song>
        | undefined;
    } else {
      project.diagnostics.push({ file: song.dir, message: 'missing song.yaml' });
    }

    // The song's maps ride song.yaml; `time` here is the loaded copy so
    // consumers never reach through the file shape.
    song.time = song.song?.data.time;
    if (song.song && song.time === undefined) {
      project.diagnostics.push({ file: song.song.path, message: 'missing time: (tempo and meter)' });
    }


    const assetsYaml = join(dir, 'assets.yaml');
    if (existsSync(assetsYaml)) {
      song.assets = loadFile(project, assetsYaml, {
        schema: assetsFileSchema,
        order: assetsFileOrder,
      });
    }

    for (const file of yamlFiles(join(dir, 'tracks'))) {
      const track = loadFile(project, file, { schema: trackSchema, order: trackOrder }) as
        | LoadedFile<Track>
        | undefined;
      if (track) song.tracks.push(track);
    }
    // Stitch each generative entry's takes in by gen node name. Two
    // entries minting one name is a collision diagnosed in the check
    // pass; loading the same file twice here is merely idempotent.
    for (const track of song.tracks) {
      for (const entry of track.data.inputs) {
        if (entry.generative !== undefined) {
          const name = generatorName(entry, track.data.name);
          const takes = loadEntryTakes(project, dir, name);
          if (takes) song.genTakes.set(name, takes);
        } else if (entry.record !== undefined) {
          const name = generatorName(entry, track.data.name);
          const takes = loadRecordTakes(project, dir, name);
          if (takes) song.recordTakes.set(name, takes);
        }
      }
    }
    // A chosen MIDI take's notes, through the ledger row that pins them.
    // A row that names nothing, or a file outside the project, is
    // validate's to diagnose, so neither is read here.
    for (const takes of song.recordTakes.values()) {
      const take = chosenTake(takes.data);
      if (take === undefined || !isMidiTakeRow(take)) continue;
      const asset = song.assets?.data.assets.find((a) => a.name === take.asset);
      const { path } = asset !== undefined ? resolveAssetFile(project.root, song.dir, asset.file) : {};
      const notes = path !== undefined ? loadFile(project, path, { schema: notesFileSchema, order: notesFileOrder }) : undefined;
      if (notes) song.takeNotes.set(take.asset, notes);
    }

    for (const file of yamlFiles(join(dir, 'notes'))) {
      const part = loadFile(project, file, { schema: notesFileSchema, order: notesFileOrder });
      if (part) song.parts.set(basename(file, '.yaml'), part);
    }

    project.songs.push(song);
  }

  validate(project);
  return project;
}

// Every loaded file in declaration order, for generic passes like
// formatting checks.
export function allFiles(project: LoadedProject): LoadedFile<unknown>[] {
  const files: (LoadedFile<unknown> | undefined)[] = [
    project.manifest,
    project.shared,
    ...project.songs.flatMap((s): (LoadedFile<unknown> | undefined)[] => [
      s.song,
      s.assets,
      ...s.genTakes.values(),
      ...s.recordTakes.values(),
      ...s.tracks,
      ...s.parts.values(),
    ]),
  ];
  return files.filter((f) => f !== undefined);
}

// Semantic checks beyond per-file schemas: identity rules, tempo/meter
// validity, referential integrity, and canonical formatting.
function validate(project: LoadedProject): void {
  const push = (file: string, message: string, severity?: 'warning') =>
    project.diagnostics.push({ file, message, ...(severity !== undefined ? { severity } : {}) });
  const root = project.root;
  // Hosted-insert lookups, made at most once per validate: the blob pool
  // listing and the machine-local scan inventory (null = not yet read;
  // undefined = read, no scan exists).
  let validateStateBlobs: StateBlob[] | undefined;
  let validateInventory: PluginInventory | undefined | null = null;

  // The shared ledger validates like a song's, against its own scope root
  // (project-layout.md §1.6); its names are what //shared/asset: refs
  // resolve against below.
  const sharedNames = new Set<string>();
  const sharedFileByName = new Map<string, string>();
  if (project.shared) {
    for (const asset of project.shared.data.assets) {
      if (sharedNames.has(asset.name)) {
        push(project.shared.path, `duplicate asset "${asset.name}"`);
      }
      sharedNames.add(asset.name);
      sharedFileByName.set(asset.name, asset.file);
      if (asset.file !== posix.normalize(asset.file) || asset.file.includes('\\')) {
        push(
          project.shared.path,
          `asset "${asset.name}" file path not in normalized form: ${asset.file}`,
        );
      }
      const resolved = resolveAssetFile(project.root, 'shared', asset.file);
      if (resolved.problem) {
        push(project.shared.path, `asset "${asset.name}" ${resolved.problem}`);
      }
    }
  }

  for (const song of project.songs) {
    if (song.song && song.song.data.name !== song.name) {
      push(song.song.path, `name "${song.song.data.name}" must match directory "${song.name}"`);
    }
    if (song.song?.data.loop === true && song.song.data.length === undefined) {
      push(song.song.path, 'loop needs a declared length — the loop point is the length');
    }

    // The song's rate: what its output renders at and what every track
    // without a `rate:` inherits (multi-rate.md decision 3, amended
    // 2026-08-10 — track.rate ?? song.rate ?? project sample_rate).
    const songRate =
      song.song?.data.rate ?? project.manifest?.data.sample_rate ?? 48000;
    let tempoMap: TempoMap | undefined;
    let meterMap: MeterMap | undefined;
    if (song.time && song.song) {
      try {
        tempoMap = new TempoMap(song.time.tempo, songRate);
      } catch (err) {
        push(song.song.path, (err as Error).message);
      }
      try {
        meterMap = new MeterMap(song.time.meter);
      } catch (err) {
        push(song.song.path, (err as Error).message);
      }
    }

    // Musical time arrays resolve to tick scalars here, at the load
    // boundary (musical-time.md §1.5–1.6): the schema admits the
    // [bar, beat?, tick?] shapes, the meter map gives them meaning, and
    // everything downstream — the rest of validate included — sees only
    // ticks. The resolved types exported from schemas.ts are this pass's
    // promise, which is why a failed resolution always pushes a
    // diagnostic: nothing past the check gate may meet an array.
    const musical = (
      file: string,
      what: string,
      value: number | number[] | undefined,
      resolve: (meter: MeterMap, arr: number[]) => number,
      // The map to read this file's musical time under — the song's, or a
      // track's own (nested-tracks.md §13). Passed rather than defaulted:
      // `undefined` means *no valid map applies*, which a track with a
      // broken local map reaches as surely as a song with a broken
      // time:. Falling back to the song's there would resolve the
      // positions against a map the author did not write, inventing
      // numbers on top of an error that was already reported.
      meter: MeterMap | undefined,
    ): number | undefined => {
      if (!Array.isArray(value)) return value;
      if (!meter) {
        push(file, `${what} is musical time but no valid meter map applies`);
        return undefined;
      }
      try {
        return resolve(meter, value);
      } catch (err) {
        push(file, `${what}: ${(err as Error).message}`);
        return undefined;
      }
    };
    const positionTicks = (
      file: string,
      what: string,
      value: number | number[],
      map: MeterMap | undefined,
    ) =>
      musical(file, what, value, (meter, arr) => meter.positionTicks(arr[0]!, arr[1], arr[2]), map);
    const spanTicks = (
      file: string,
      what: string,
      value: number | number[] | undefined,
      from: number,
      map: MeterMap | undefined,
    ) => musical(file, what, value, (meter, arr) => meter.spanTicks(from, arr), map);

    if (song.song?.data.length !== undefined) {
      const resolved = spanTicks(song.song.path, 'length', song.song.data.length, 0, meterMap);
      if (resolved !== undefined) {
        if (resolved <= 0) push(song.song.path, 'length resolves to zero ticks');
        else song.song.data.length = resolved;
      }
    }

    const assetNames = new Set<string>();
    if (song.assets) {
      for (const asset of song.assets.data.assets) {
        if (assetNames.has(asset.name)) {
          push(song.assets.path, `duplicate asset "${asset.name}"`);
        }
        assetNames.add(asset.name);
        // Normalized form required (§3.6 flavor, deferred from #5): with
        // exactly one spelling per path, exact-string comparisons are sound
        // everywhere.
        if (asset.file !== posix.normalize(asset.file) || asset.file.includes('\\')) {
          push(
            song.assets.path,
            `asset "${asset.name}" file path not in normalized form: ${asset.file}`,
          );
        }
        const resolved = resolveAssetFile(project.root, song.dir, asset.file);
        if (resolved.problem) {
          push(song.assets.path, `asset "${asset.name}" ${resolved.problem}`);
        }
      }
    }

    // The namespace a bare `audio:` ref resolves in (§4.3): the
    // ledger, plus the shared scope's for the one cross-scope spelling.
    const names: SourceNames = {
      assets: assetNames,
      shared: sharedNames,
    };

    // Entry references resolve per kind, each in its field's own
    // namespace (nested-tracks.md §18) — the whole visibility rule
    // (project-layout.md §1.5) is that no spelling reaches another song,
    // and the one cross-scope spelling is `audio: //shared/asset:`.
    const fileBySource = committedFileResolver(project, song);
    // Names first, in full: a track may place a track declared in any
    // file, and a forward reference is fine.
    const trackByName = new Map(song.tracks.map((t) => [t.data.name, t.data]));
    const trackPathByName = new Map(song.tracks.map((t) => [t.data.name, t.path]));
    // Every generator entry's node name, up front: the audio: diagnostic
    // below asks "does this name render", and forward references across
    // files are as fine for generators as for tracks.
    const genNodeNames = new Set<string>();
    for (const trackFile of song.tracks) {
      for (const entry of trackFile.data.inputs) {
        if (mintsGenerator(entry)) genNodeNames.add(generatorName(entry, trackFile.data.name));
      }
    }

    // One timeline per track file, resolved once (nested-tracks.md §13):
    // everything positioned on a track — its clips today, a recorded
    // take's record when recording arrives — resolves ticks through that
    // track's time, not the song's (#95 review).
    const timeByTrack = new Map<
      string,
      { tempo: TempoMap | undefined; meter: MeterMap | undefined; rate: number }
    >();
    // The renders a part's later loop repetitions mint (partRenders), so
    // each can be checked against the generator names once all are known.
    const repetitionRenders: { name: string; path: string; what: string; repetition: number }[] = [];
    for (const track of song.tracks) {
      // At the track's effective rate (multi-rate.md decision 3): the
      // sample-domain checks below — fade fit, loop expansion — have to
      // project ticks exactly as the plan will, and a 44.1 kHz track's
      // bar is fewer samples than the song's. The song's own map serves
      // any track at the song rate, which is every track without a
      // `rate:`.
      const trackSampleRate = track.data.rate ?? songRate;
      let tempo =
        trackSampleRate === songRate || song.time === undefined || tempoMap === undefined
          ? tempoMap
          : new TempoMap(song.time.tempo, trackSampleRate);
      let meter = meterMap;
      const time = track.data.time;
      if (time?.tempo) {
        try {
          tempo = new TempoMap(time.tempo, trackSampleRate);
        } catch (err) {
          push(track.path, `local tempo: ${(err as Error).message}`);
          tempo = undefined;
        }
      }
      if (time?.meter) {
        try {
          meter = new MeterMap(time.meter);
        } catch (err) {
          push(track.path, `local meter: ${(err as Error).message}`);
          meter = undefined;
        }
      }
      timeByTrack.set(track.data.name, { tempo, meter, rate: trackSampleRate });
    }
    for (const track of song.tracks) {
      const expected = basename(track.path, '.yaml');
      if (track.data.name !== expected) {
        push(track.path, `name "${track.data.name}" must match filename "${expected}"`);
      }
      // The output track is the song, and the song's rate is song.yaml's
      // `rate:` (falling back to project.yaml's `sample_rate`) — a
      // `rate:` here could only restate it or contradict it, and a field
      // with one correct value should not exist (the argument that
      // retired the normalize insert).
      const trackSampleRate = track.data.rate ?? songRate;
      if (track.data.name === SONG_OUTPUT_NAME && track.data.rate !== undefined) {
        push(
          track.path,
          `the song's output renders at the song's rate — rate: in song.yaml ` +
            `(or sample_rate in project.yaml) is that choice (multi-rate.md decision 3); ` +
            `delete rate: here`,
        );
      }

      // A track's own timeline (nested-tracks.md §1.5, §13). Everything in
      // this file — its clips and the `at` of every track it places — is
      // in this track's time, so one map governs the whole file. Each half
      // falls back to the song's independently: a 7/8 figure at the song's
      // tempo declares a meter and nothing else.
      //
      // The song's maps, not the placing parent's. A track can be placed
      // in two parents (§1.3) and renders once, so "bar 2" inside it has
      // to mean one thing regardless of who consumes it.
      const { tempo: trackTempo, meter: trackMeter } = timeByTrack.get(track.data.name)!;

      // Resolved by the render's own rule, so check and the build find
      // the program the same way.
      const instrument = track.data.instrument;
      if (instrument !== undefined) {
        validateInstrument(instrument, {
          root: project.root,
          push: (message: string) => push(track.path, message),
          resolveFile: (baseDir: string, file: string) => resolveAssetFile(project.root, baseDir, file),
        });
      }

      // One entry loop (nested-tracks.md §18): what an entry plays is
      // named by its field, so resolution is per kind and never guesses —
      // audio: refuses a name that renders, pointing at the field that
      // owns the name.
      const entryIds = new Set<string>();
      track.data.inputs.forEach((entry, i) => {
        // A receive is not a placement (nested-tracks.md §19): it has no
        // window, no fades, no time to resolve. Its checks — the ends,
        // the path, the arrivals — are checkCables', below.
        if (entry.receive !== undefined) return;
        // Named by id when it has one — ids are optional (§18 decision
        // 3) — else by position and target (cables.ts entryName).
        const what = entryName(entry, i);
        if (entry.id !== undefined) {
          if (entryIds.has(entry.id)) push(track.path, `duplicate input id "${entry.id}"`);
          entryIds.add(entry.id);
        }
        if (entry.track !== undefined) {
          if (entry.track === track.data.name) {
            // The locally decidable cycle, with its own message —
            // "cycle: a → a" describes the mistake less well than
            // naming it.
            push(track.path, `${what} places this track inside itself`);
            return;
          }
          if (!trackByName.has(entry.track)) {
            // Diagnosed, not fatal to the entry: the time fields still
            // resolve, the way an unknown clip source always worked —
            // one mistake, one message, the rest of the file readable.
            push(track.path, `${what} references unknown track "${entry.track}"`);
          }
        } else if (entry.audio !== undefined) {
          const shared = sharedAssetName(entry.audio);
          if (shared !== undefined) {
            if (!names.shared.has(shared)) {
              push(track.path, `${what} references unknown shared asset "${shared}"`);
            }
          } else if (!names.assets.has(entry.audio)) {
            // A name that renders is not committed bytes: a gen node's
            // takes live under audio/<name>/, but the way to play them
            // is to place the track that carries the request.
            push(
              track.path,
              genNodeNames.has(entry.audio)
                ? `${what} audio: names the generator "${entry.audio}" — a render is ` +
                    `not committed bytes; place the track that carries the entry ` +
                    `(nested-tracks.md §18)`
                : `${what} references unknown audio "${entry.audio}"`,
            );
          }
        } else if (entry.supercollider !== undefined) {
          // The generator's own rule validates the entry the way it
          // validates a sound file — same program-path resolution, same
          // messages — against a spec built exactly as buildGraph builds
          // it, so the two sites cannot answer differently.
          const spec = {
            name: generatorName(entry, track.data.name),
            type: 'supercollider' as const,
            ...entry.supercollider,
          };
          generatorFor(spec).validate(spec, {
            root: project.root,
            songDir: song.dir,
            names,
            push: (message: string) => push(track.path, `${what} ${message}`),
            resolveFile: (baseDir: string, file: string) =>
              resolveAssetFile(project.root, baseDir, file),
          });
        } else if (entry.generative !== undefined) {
          // Through lookupAsset for the same reason the sound pass is:
          // this check and `field generate` may not answer "which asset
          // is this" differently (voice-generation.md §1.3).
          if (
            entry.generative.voice_ref !== undefined &&
            lookupAsset(project, song.name, entry.generative.voice_ref) === undefined
          ) {
            push(
              track.path,
              `${what} voice_ref references unknown asset "${entry.generative.voice_ref}" — ` +
                `a reference recording is a committed asset (voice-generation.md §1.3)`,
            );
          }
          // Takes with nothing picked never comes from a command —
          // `field generate` chooses its first take — so reaching it
          // means a hand edit, same as the sound-side rule.
          const gname = generatorName(entry, track.data.name);
          const takes = song.genTakes.get(gname)?.data;
          if (takes !== undefined && takes.chosen === undefined && takes.variants.length > 0) {
            push(
              track.path,
              `${what} has takes but no chosen variant yet — field choose ${song.name}/${gname} first`,
            );
          }
        } else if (entry.record !== undefined) {
          // A record entry with no takes builds as silence (recording.md
          // §4): the session has not happened yet, and refusing would
          // stop the mix being placed and looped before it does. A
          // warning, so check still says ok. Takes with nothing chosen
          // is the hand-edit case, exactly as for a generative entry.
          const rname = generatorName(entry, track.data.name);
          const takes = song.recordTakes.get(rname)?.data;
          if (takes === undefined || takes.takes.length === 0) {
            push(
              track.path,
              `${what} has no takes yet — field record ${song.name}/track:${track.data.name}`,
              'warning',
            );
          } else if (takes.chosen === undefined) {
            push(
              track.path,
              `${what} has takes but none chosen — field choose ${song.name}/${rname} --take <name> first`,
            );
          }
          // The track's instrument decides the kind of take the entry
          // records (sequencer.md §3.4), so every take must be of that kind.
          for (const take of takes?.takes ?? []) {
            if (isMidiTakeRow(take) && instrument === undefined) {
              push(track.path, `take "${take.asset}" is a MIDI take, and ${track.data.name} has no instrument to play it`);
            } else if (!isMidiTakeRow(take) && instrument !== undefined) {
              push(track.path, `take "${take.asset}" is an audio take, and ${track.data.name} records MIDI for ${instrument}`);
            }
          }
        } else if (entry.notes !== undefined) {
          if (instrument === undefined) {
            push(
              track.path,
              `${what} places notes, and ${track.data.name} has no instrument to play them — ` +
                'give the track one with `instrument: <name>`',
            );
          }
          if (!song.parts.has(entry.notes) && !existsSync(join(project.root, song.dir, 'notes', `${entry.notes}.yaml`))) {
            push(track.path, `${what} places the part "${entry.notes}", and there is no ${song.dir}/notes/${entry.notes}.yaml`);
          }
        }
        // Musical arrays need the musical anchor: an absolute entry's
        // scalars are samples, and silently converting [9, 2] would be a
        // unit pun, not a convenience. An entry whose time fields fail to
        // resolve skips the numeric checks below — its diagnostic already
        // holds the gate.
        if (
          entry.anchor === 'absolute' &&
          [entry.at, entry.duration, entry.loop?.every].some((v) => Array.isArray(v))
        ) {
          push(
            track.path,
            `${what} uses musical time on an absolute entry — ` +
              `musical arrays need anchor: musical`,
          );
          return;
        }
        const pos = positionTicks(track.path, `${what} at`, entry.at, trackMeter);
        if (pos === undefined) return;
        entry.at = pos;
        // A take in ticks plays from its record entry (§2.4), so it has to
        // start on the track and resolve from there as a part would.
        if (entry.record !== undefined && trackTempo && trackMeter) {
          const chosen = chosenTake(song.recordTakes.get(generatorName(entry, track.data.name))?.data);
          const notes = chosen !== undefined ? song.takeNotes.get(chosen.asset) : undefined;
          if (chosen !== undefined && isMidiTakeRow(chosen) && notes !== undefined && notes.data.sample_rate === undefined) {
            try {
              resolveNotes(notes.data, takeAnchor(entry, chosen, trackTempo), { tempo: trackTempo, meter: trackMeter });
            } catch (err) {
              push(track.path, `take "${chosen.asset}": ${(err as Error).message}`);
            }
          }
        }
        // An *absent* duration is the entry declining to truncate, and has
        // to be told apart from one that failed to resolve: the second
        // already pushed a diagnostic and must skip the checks below,
        // while the first is a valid entry that still has to pass them.
        // Collapsing the two would let `duration:` be omitted and take
        // every remaining check with it.
        if (entry.duration !== undefined) {
          const dur = spanTicks(track.path, `${what} duration`, entry.duration, pos, trackMeter);
          if (dur === undefined) return;
          if (dur <= 0) {
            push(track.path, `${what} duration resolves to zero ticks`);
            return;
          }
          entry.duration = dur;
        } else if (entry.loop?.enabled) {
          // A loop tiles a window, so it needs one (clip-looping.md §1).
          // "As long as the source" and "repeat to fill the window" are
          // contrary instructions, not a default and an override.
          push(
            track.path,
            `${what} loops but declares no duration — a loop tiles a window, ` +
              `so give it a duration or drop the loop`,
          );
          return;
        }
        // A part resolves from where the entry places it, so a position
        // out of range is this placement's to report. Its length is known
        // here, which is what lets a looping notes entry omit `every`.
        const part = entry.notes !== undefined ? song.parts.get(entry.notes) : undefined;
        if (part !== undefined && trackTempo) {
          const time = { tempo: trackTempo, meter: trackMeter };
          try {
            resolveNotes(part.data, placementAnchor(entry, trackTempo), time);
          } catch (err) {
            push(track.path, `${what} places ${part.path}, which does not resolve there: ${(err as Error).message}`);
            return;
          }
          if (entry.loop?.enabled && entry.loop.every === undefined) {
            const every = notesLength(part.data, entry, time);
            if (every <= 0) {
              push(track.path, `${what} loops a part with no length — give ${part.path} a length or the loop an every`);
              return;
            }
            entry.loop.every = every;
          }
        }
        if (entry.loop?.every !== undefined) {
          const every = spanTicks(track.path, `${what} loop.every`, entry.loop.every, pos, trackMeter);
          if (every === undefined) return;
          if (every <= 0) {
            push(track.path, `${what} loop.every resolves to zero ticks`);
            return;
          }
          entry.loop.every = every;
        }
        if (part !== undefined && trackTempo && entry.loop?.enabled) {
          const name = generatorName(entry, track.data.name);
          try {
            const { renders, repetitions } = partRenders(part.data, entry, name, { tempo: trackTempo, meter: trackMeter });
            for (const render of renders.slice(1)) {
              repetitionRenders.push({ name: render.name, path: track.path, what, repetition: repetitions.indexOf(render.name) + 1 });
            }
          } catch (err) {
            push(track.path, `${what} places ${part.path}, which does not resolve ${(err as Error).message}`);
            return;
          }
        }
        // Loops are diagnosed here in full — running the same expansion the
        // plan will run — because check is the gate: a check-clean project
        // must never fail to construct its graph (#21 review).
        if (entry.loop?.enabled && trackTempo) {
          const loop = entry.loop;
          const committed = fileBySource(entryRef(entry, track.data.name));
          if (committed === undefined && loop.every === undefined) {
            const kind =
              entry.track !== undefined
                ? 'track'
                : entry.supercollider !== undefined
                  ? 'generator'
                  : entry.generative !== undefined
                    ? 'generative entry'
                    : 'source';
            push(
              track.path,
              `${what} loops a ${kind} — set loop.every ` +
                `(a ${kind}'s length is unknown before it builds)`,
            );
          } else {
            // Tiling at source length needs the frame count; the seek-based
            // header read costs no audio bytes (wav.ts).
            let frames: number | undefined;
            let sourceUnreadable = false;
            if (committed !== undefined && loop.every === undefined) {
              const resolved = resolveAssetFile(project.root, committed.base, committed.file);
              if (resolved.path) {
                try {
                  const header = readWavHeader(resolved.path);
                  if (header.sampleRate !== trackSampleRate) {
                    // The edge conversion (multi-rate.md decision 4)
                    // changes the source's length, so tiling at "its"
                    // length would tile at the wrong one — the converted
                    // count exists only after the conversion renders,
                    // which is the same reason a buildable demands every.
                    sourceUnreadable = true;
                    push(
                      track.path,
                      `${what} loops a ${header.sampleRate} Hz source on a ` +
                        `${trackSampleRate} Hz track — set loop.every: the edge ` +
                        `conversion changes its length, which is unknown before it builds`,
                    );
                  } else {
                    frames = header.frames;
                  }
                } catch (err) {
                  sourceUnreadable = true;
                  push(track.path, `${what} loop source: ${(err as Error).message}`);
                }
              } else {
                sourceUnreadable = true; // the source itself is already diagnosed
              }
            }
            if (!sourceUnreadable) {
              try {
                for (const rep of expandLoop(entry, loop, trackTempo, frames)) {
                  // Fades must fit slots (clip-looping.md §3): overlapping
                  // seam fades duck the audio silently — every: 30 at 120 bpm
                  // makes 750-sample slots the default 480+480 outgrows.
                  if (rep.fade_in + rep.fade_out > rep.duration) {
                    push(
                      track.path,
                      `${what} loop fades (${rep.fade_in} + ${rep.fade_out} samples) ` +
                        `exceed a ${rep.duration}-sample repetition — ` +
                        `shrink loop.fade or lengthen loop.every`,
                    );
                    break;
                  }
                }
              } catch (err) {
                push(track.path, (err as Error).message); // names the entry itself
              }
            }
          }
        }
        // Fades live inside the window; whether they fit is only known
        // in samples, so musical entries are checked through the tempo map.
        if (trackTempo) {
          const { duration } = placedWindow(entry, trackTempo);
          // An omitted duration has no window until the source renders, so
          // the daemon is the only place that check can happen.
          if (duration !== undefined && entry.fade_in + entry.fade_out > duration) {
            push(
              track.path,
              `${what} fades (${entry.fade_in} + ${entry.fade_out} samples) ` +
                `exceed its ${duration}-sample window`,
            );
          }
        }
      });

    }

    // A generator entry's render is a node, so it needs a name no other
    // generator claims (nested-tracks.md §18 step 2): the owning track's,
    // or <track>-<id>. The first claimant is recorded so a collision can
    // say what actually collided: within one track, two un-id'd entries
    // (the fix is the message: give them ids) — the same-track same-id
    // case is already the duplicate-id diagnostic above, and a second
    // message could only give false advice. Across tracks (`kit-sc` with
    // `id: b` against a track named `kit-sc-b`), no id is missing, so
    // the message names both files instead.
    const genNames = new Map<string, string>();
    for (const trackFile of song.tracks) {
      for (const entry of trackFile.data.inputs) {
        if (!mintsGenerator(entry)) continue;
        const name = generatorName(entry, trackFile.data.name);
        // A generative entry's takes claim audio/<name>/, and so does an
        // asset: imports land in audio/<name>/ too (project-layout.md
        // §4.11) — so one name may not be both. A record entry's takes
        // claim the directory the same way (recording.md §3).
        if ((entry.generative !== undefined || entry.record !== undefined) && assetNames.has(name)) {
          push(
            trackFile.path,
            `${entry.record !== undefined ? 'record' : 'generative'} entry mints the name ` +
              `"${name}", which the asset "${name}" also ` +
              `holds — both claim audio/${name}/ (rename the track, the entry id, or ` +
              `the asset)`,
          );
        }
        const first = genNames.get(name);
        if (first === undefined) {
          genNames.set(name, trackFile.path);
        } else if (first === trackFile.path) {
          // Same track, same name: same id (diagnosed above) or no ids.
          if (entry.id === undefined) {
            push(
              trackFile.path,
              `two generator entries share the name "${name}" — give each an id so ` +
                `its render has a name of its own (nested-tracks.md §18)`,
            );
          }
        } else {
          push(
            trackFile.path,
            `a generator entry here and one in ${first} both mint the render ` +
              `name "${name}" — rename a track or change an id so each render ` +
              `has a name of its own (nested-tracks.md §18)`,
          );
        }
      }
    }
    for (const render of repetitionRenders) {
      const owner = genNames.get(render.name);
      if (owner !== undefined) {
        push(
          render.path,
          `repetition ${render.repetition} of ${render.what} renders as "${render.name}", which the ` +
            `generator in ${owner} also names — rename a track or change an id so each render has a name of its own`,
        );
      }
    }

    // Hosted plugin inserts (plugin-hosting.md §3). Repository facts —
    // pins, ids, state refs — are judged everywhere; what only an
    // installed plugin can validate (parameter names, version drift) is
    // judged exactly where a scan inventory exists and deferred
    // everywhere else (decision 3).
    for (const trackFile of song.tracks) {
      const hosted = trackFile.data.inserts.filter(
        (insert): insert is Extract<(typeof trackFile.data.inserts)[number], { plugin: string }> =>
          'plugin' in insert,
      );
      if (hosted.length === 0) continue;

      const insertIds = new Set<string>();
      for (const insert of hosted) {
        if (insert.id === undefined) continue;
        if (insertIds.has(insert.id)) {
          push(trackFile.path, `duplicate insert id "${insert.id}"`);
        }
        insertIds.add(insert.id);
      }
      const byIdentity = new Map<string, typeof hosted>();
      for (const insert of hosted) {
        const identity = insert.au ?? insert.vst3 ?? `name:${insert.plugin}`;
        byIdentity.set(identity, [...(byIdentity.get(identity) ?? []), insert]);
      }
      for (const group of byIdentity.values()) {
        if (group.length > 1 && group.some((insert) => insert.id === undefined)) {
          push(
            trackFile.path,
            `"${group[0]!.plugin}" appears ${group.length} times in one chain — give ` +
              `each an id so a knob lands on the right one (plugin-hosting.md decision 6)`,
          );
        }
      }

      for (const insert of hosted) {
        const format =
          insert.au !== undefined ? ('au' as const) : insert.vst3 !== undefined ? ('vst3' as const) : undefined;
        if (format === undefined) {
          push(
            trackFile.path,
            `"${insert.plugin}" is not pinned — field plugins scan, then check writes ` +
              `the identity back (plugin-hosting.md decision 2)`,
          );
        } else if (insert.version === undefined) {
          push(
            trackFile.path,
            `"${insert.plugin}" has an identity but no version: — field plugins pin completes it`,
          );
        }

        if (insert.state !== undefined) {
          validateStateBlobs ??= indexStateBlobs(root);
          const { blob, problem } = resolveStateRef(insert.state, validateStateBlobs);
          if (problem !== undefined) {
            push(trackFile.path, problem);
          } else {
            const expected = `shared/plugins/${pluginSlug(insert.plugin)}/${blob!.sha256}.state`;
            if (blob!.path !== expected) {
              push(
                trackFile.path,
                `state blob for "${insert.plugin}" lives at ${blob!.path}; the ` +
                  `write-time convention is ${expected} — git mv tidies it (reads ` +
                  `resolve by hash either way)`,
                'warning',
              );
            }
          }
        }

        if (validateInventory === null) validateInventory = readInventory(root);
        const installed =
          format !== undefined && validateInventory !== undefined
            ? findInstalled(validateInventory, format, (insert.au ?? insert.vst3)!)
            : undefined;
        if (installed === undefined) continue;
        if (insert.version !== undefined && installed.version !== insert.version) {
          push(
            trackFile.path,
            `"${insert.plugin}" is pinned at ${insert.version}; installed is ` +
              `${installed.version} — a rebuild will refuse until field plugins pin ` +
              `--update accepts the change (plugin-hosting.md decision 9)`,
            'warning',
          );
        }
        for (const key of Object.keys(insert.params ?? {})) {
          const hash = key.lastIndexOf('#');
          const name = hash >= 0 ? key.slice(0, hash) : key;
          const paramId = hash >= 0 ? key.slice(hash + 1) : undefined;
          const matches = installed.params.filter((p) =>
            paramId !== undefined ? p.id === paramId : p.name === name,
          );
          if (matches.length === 0) {
            push(trackFile.path, `"${insert.plugin}" has no parameter "${key}"`);
          } else if (matches.length > 1) {
            push(
              trackFile.path,
              `"${insert.plugin}" has ${matches.length} parameters named "${name}" — ` +
                `spell it ${matches.map((m) => `${name}#${m.id}`).join(' or ')} ` +
                `(plugin-hosting.md decision 3)`,
            );
          } else if (paramId !== undefined && matches[0]!.name !== name) {
            push(
              trackFile.path,
              `param "${key}": id ${paramId} is named "${matches[0]!.name}", not "${name}"`,
            );
          }
          // Decision 3's split, enforced where the scan can judge it: a
          // string is legal only on a labeled (discrete) parameter, and
          // only as a label the plugin offers. An inventory scanned
          // before discreteness was recorded defers, like no scan.
          const value = insert.params?.[key];
          const info = matches.length === 1 ? matches[0]! : undefined;
          if (typeof value === 'string' && info !== undefined) {
            if (info.discrete === false) {
              push(
                trackFile.path,
                `param "${key}" takes a number — string spellings are for labeled ` +
                  `parameters (plugin-hosting.md decision 3)`,
              );
            } else if (
              info.discrete === true &&
              info.labels !== undefined &&
              info.labels.length > 0 &&
              !info.labels.includes(value)
            ) {
              push(
                trackFile.path,
                `param "${key}": "${value}" is not one of ${info.labels.join(', ')}`,
              );
            }
          }
        }
      }
    }

    for (const [name, part] of song.parts) {
      if (!isSlug(name)) {
        push(part.path, `a part is named by its file, and "${name}" is not a lowercase slug that a notes: entry can name`);
      }
    }

    // A generative entry's takes get the checks a generative sound's do
    // (the deliberate-sounds block above): committed, content-addressed,
    // contained in audio/<name>/, `chosen` naming a take that exists.
    // Pushed against the takes file, which is the file you would edit.
    for (const [name, takesFile] of song.genTakes) {
      const takes = takesFile.data;
      takes.variants.forEach((_, i) => {
        const label = `${name}-${i + 1}`;
        if (genNames.has(label)) {
          push(
            takesFile.path,
            `variant ${i + 1} audition label "${label}" collides with the generator of that name`,
          );
        }
      });
      const variantFiles = new Set<string>();
      for (const variant of takes.variants) {
        if (variantFiles.has(variant.file)) {
          push(takesFile.path, `duplicate variant file "${variant.file}"`);
        }
        variantFiles.add(variant.file);
        if (variant.file !== posix.normalize(variant.file) || variant.file.includes('\\')) {
          push(takesFile.path, `variant file path not in normalized form: ${variant.file}`);
          continue;
        }
        if (!variant.file.startsWith(`audio/${name}/`)) {
          push(takesFile.path, `variant file must live in audio/${name}/: ${variant.file}`);
        }
        const resolved = resolveAssetFile(project.root, song.dir, variant.file);
        if (resolved.problem) {
          push(takesFile.path, `variant ${resolved.problem}`);
        }
      }
      if (takes.chosen !== undefined && takes.chosen > takes.variants.length) {
        push(
          takesFile.path,
          `chosen variant ${takes.chosen} does not exist (${takes.variants.length} variants)`,
        );
      }
    }

    // A record entry's takes get their own checks (recording.md §3):
    // `chosen` names a row, every row's asset is in the ledger with its
    // bytes under audio/<name>/, no row twice. Pushed against the takes
    // file, which is the file you would edit.
    for (const [name, takesFile] of song.recordTakes) {
      const takes = takesFile.data;
      const seen = new Set<string>();
      for (const take of takes.takes) {
        if (seen.has(take.asset)) push(takesFile.path, `duplicate take "${take.asset}"`);
        seen.add(take.asset);
        const asset = song.assets?.data.assets.find((a) => a.name === take.asset);
        if (asset === undefined) {
          push(
            takesFile.path,
            `take "${take.asset}" is not in the ledger — recorded audio pins in ` +
              `assets.yaml (recording.md §3)`,
          );
        } else if (!asset.file.startsWith(`audio/${name}/`)) {
          push(
            takesFile.path,
            `take "${take.asset}" must live in audio/${name}/: the ledger has it at ${asset.file}`,
          );
        }
      }
      if (takes.chosen !== undefined && !seen.has(takes.chosen)) {
        push(takesFile.path, `chosen take "${takes.chosen}" is not one of the takes`);
      }
    }

    // Nothing else ever opens audio/, so a renamed track or entry id
    // strands its takes — model-minutes of them — with check green and
    // the takes silently gone from the model. A directory holding a
    // takes file is claimed by the generative request named like it;
    // unclaimed is a rename's leftover, and this names it. Asset item
    // directories carry no takes file and are skipped; a claimed
    // directory with the wrong key inside is the attachment
    // diagnostics' to say, not a second message here.
    const claimedTakesDirs = new Set<string>();
    for (const trackFile of song.tracks) {
      for (const entry of trackFile.data.inputs) {
        if (entry.generative !== undefined) {
          claimedTakesDirs.add(generatorName(entry, trackFile.data.name));
        }
      }
    }
    // The same for record entries (recording.md §3): a recorded take is
    // a performance nobody can regenerate, so a stranded takes.yaml is
    // the worse of the two.
    const claimedRecordDirs = new Set<string>();
    for (const trackFile of song.tracks) {
      for (const entry of trackFile.data.inputs) {
        if (entry.record !== undefined) {
          claimedRecordDirs.add(generatorName(entry, trackFile.data.name));
        }
      }
    }
    const audioDir = join(project.root, song.dir, 'audio');
    if (existsSync(audioDir)) {
      for (const item of readdirSync(audioDir).sort()) {
        const itemDir = join(audioDir, item);
        if (!statSync(itemDir).isDirectory()) continue;
        if (!claimedTakesDirs.has(item) && existsSync(join(itemDir, TAKES_FILENAME))) {
          push(
            `${song.dir}/audio/${item}/${TAKES_FILENAME}`,
            `no generative request claims audio/${item}/ — a renamed track or id ` +
              `leaves its takes behind; rename the directory (and its gen: key) ` +
              `to follow, or delete it`,
          );
        }
        if (!claimedRecordDirs.has(item) && existsSync(join(itemDir, RECORD_TAKES_FILENAME))) {
          push(
            `${song.dir}/audio/${item}/${RECORD_TAKES_FILENAME}`,
            `no record entry claims audio/${item}/ — a renamed track or id leaves ` +
              `its takes behind; rename the directory (and its record: key) to ` +
              `follow, or add \`- record:\` back to the track`,
          );
        }
      }
    }

    // Cables (nested-tracks.md §19): both ends resolve 1:1, dangling
    // ends warn, the receive's path up to the cable's ancestor is
    // undisplaced, the containment paths agree on arrivals, and the
    // combined graph — containment plus cables — stays acyclic. After
    // the entry loop, which resolved every musical time the walk reads.
    // The survivors ride the model into the graph.
    song.cables = checkCables(song.tracks, timeByTrack, push);

    // Containment cycles. Sound sources already made cycles declarable
    // (effects.md §3) and this is the same detector for the same reason:
    // check is the gate, so it must name the cycle before the build
    // walker trips over it and reports something about its own ordering.
    // Direct self-placement is diagnosed above and skipped here, so its
    // clearer message is the only one that appears.
    const containmentState = new Map<string, 'visiting' | 'done'>();
    const visitTrack = (name: string, path: string[]): void => {
      if (containmentState.get(name) === 'done') return;
      if (containmentState.get(name) === 'visiting') {
        const cycle = [...path.slice(path.indexOf(name)), name].join(' → ');
        push(trackPathByName.get(name)!, `track containment cycle: ${cycle}`);
        return;
      }
      containmentState.set(name, 'visiting');
      // The entries that are containment edges are exactly the ones that
      // place a track (§18) — audio and generator entries are leaves.
      for (const entry of trackByName.get(name)?.inputs ?? []) {
        if (entry.track !== undefined && entry.track !== name && trackByName.has(entry.track)) {
          visitTrack(entry.track, [...path, name]);
        }
      }
      containmentState.set(name, 'done');
    };
    for (const track of song.tracks) visitTrack(track.data.name, []);
  }
}

// Resolve an asset's file path safely, or say why it can't be used. The
// single source of truth for asset-path rules — validate diagnoses with the
// problem, and verifyAssetHashes reads only what this accepts, so the two
// passes cannot drift apart.
function resolveAssetFile(
  root: string,
  songDir: string,
  file: string,
): { path?: string; problem?: string } {
  if (isAbsolute(file)) return { problem: `file path must be relative: ${file}` };
  const path = resolve(root, songDir, file);
  if (path !== root && !path.startsWith(root + sep)) {
    return { problem: `file path escapes the project: ${file}` };
  }
  if (!existsSync(path)) return { problem: `file not found: ${file}` };
  if (!statSync(path).isFile()) return { problem: `file is not a regular file: ${file}` };
  return { path };
}

// Resolving a ref that must name a *committed asset* — the rule
// `voice_ref` follows (voice-generation.md §1.3). One function, because
// two passes read it: validate diagnoses a ref that names nothing, and
// `field generate` turns the same ref into the path it feeds the worker
// and the hash it writes into the recipe. Both #58 review findings were
// two readings of "which asset is this" disagreeing — a name resolved in
// the wrong namespace, and a hash that pinned nothing — so the readings
// are one reading now. Bare names are scoped to their song
// (project-layout.md §4.3); `//shared/asset:<name>` crosses scope.
export interface AssetLookup {
  asset: Asset;
  base: string; // scope dir, project-relative — what `asset.file` is relative to
  path?: string | undefined; // absolute, when the file resolves
  problem?: string | undefined; // why it does not, in resolveAssetFile's words
  // How many ledger rows carry this name. A schema-valid ledger can hold
  // two rows called `ref-voice` pointing at different recordings, and
  // validate diagnoses that separately — but `find` would still hand back
  // the first one, so a caller that never looked at diagnostics would act
  // on an arbitrary answer to a question that has none. Being the single
  // reading means reporting that, not resolving it (#61 review): a
  // *lookup* can only say the name is ambiguous, and whether that is
  // fatal is the caller's to decide.
  matches: number;
}

export function lookupAsset(
  project: LoadedProject,
  songName: string,
  ref: string,
): AssetLookup | undefined {
  const shared = sharedAssetName(ref);
  const song = project.songs.find((s) => s.name === songName);
  const scope =
    shared !== undefined
      ? { name: shared, base: 'shared', ledger: project.shared?.data.assets }
      : { name: ref, base: song?.dir ?? '', ledger: song?.assets?.data.assets };
  const matched = scope.ledger?.filter((a) => a.name === scope.name) ?? [];
  const asset = matched[0];
  if (!asset) return undefined;
  return {
    asset,
    base: scope.base,
    matches: matched.length,
    ...resolveAssetFile(project.root, scope.base, asset.file),
  };
}

// Files whose formatting differs from canonical (project-core.md §3.6).
export function unformattedFiles(project: LoadedProject): string[] {
  return allFiles(project)
    .filter((file) => canonicalText(file.raw, file.order) !== file.raw)
    .map((file) => file.path);
}

// Content verification: every declared asset's bytes must match its
// recorded size and hash to its recorded sha256. Separate from loadProject
// because it reads full asset files — check runs it; fmt and status don't
// need it. Only paths resolveAssetFile accepts are read, so unusable paths
// (already diagnosed by validate) are never opened.
export async function verifyAssetHashes(project: LoadedProject): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  // One ledger per scope (project-layout.md §1.6): shared/assets.yaml and
  // each song's assets.yaml verify identically, paths relative to their
  // scope root.
  const ledgers = [
    ...(project.shared ? [{ ledger: project.shared, base: 'shared' }] : []),
    ...project.songs.flatMap((s) => (s.assets ? [{ ledger: s.assets, base: s.dir }] : [])),
  ];
  for (const { ledger, base } of ledgers) {
    for (const asset of ledger.data.assets) {
      const { path } = resolveAssetFile(project.root, base, asset.file);
      if (!path) continue; // already diagnosed by validate
      // Size first: cheaper than hashing, and truncation gets a clearer
      // message than a bare hash mismatch.
      const size = statSync(path).size;
      if (size !== asset.bytes) {
        diagnostics.push({
          file: ledger.path,
          message: `asset "${asset.name}" is ${size} bytes on disk but ${asset.bytes} recorded`,
        });
        continue;
      }
      const actual = await sha256File(path);
      if (actual !== asset.sha256) {
        diagnostics.push({
          file: ledger.path,
          message: `asset "${asset.name}" content does not match its recorded sha256 (${asset.file} hashes to ${actual})`,
        });
        continue;
      }
      // Recorded WAV facts are stored derived values (project-core.md
      // §3.1, multi-rate.md decision 5): the hash just proved the bytes
      // are the import-time bytes, so a disagreement here is a
      // hand-edited ledger row rather than a drifted file — and a row
      // that lies about its rate would misprice every placement.
      if (asset.sample_rate === undefined) continue;
      try {
        const h = readWavHeader(path);
        const pairs = [
          ['sample_rate', asset.sample_rate, h.sampleRate],
          ['bit_depth', asset.bit_depth, h.bitsPerSample],
          ['channels', asset.channels, h.channels],
          ['frames', asset.frames, h.frames],
        ] as const;
        for (const [key, recorded, fact] of pairs) {
          if (recorded !== undefined && recorded !== fact) {
            diagnostics.push({
              file: ledger.path,
              message: `asset "${asset.name}" records ${key} ${recorded} but the file says ${fact}`,
            });
          }
        }
      } catch (err) {
        diagnostics.push({
          file: ledger.path,
          message:
            `asset "${asset.name}" records WAV facts but its header cannot be read: ` +
            `${(err as Error).message}`,
        });
      }
    }
  }
  // A voice request's reference recording is pinned by hash for the same
  // reason its variants are (voice-generation.md §1.3 and §6). Without
  // this the hash is a field, not a pin: the recording could be swapped
  // under a request that still claimed to describe it and the project
  // stayed check-green (#58 review). Compared against the ledger's
  // recorded sha rather than re-hashing, because the loop above has
  // already proved recorded matches actual.
  //
  // Resolved per song through lookupAsset, which is what makes a bare
  // name mean its own song's asset (project-layout.md §4.3). The map this
  // replaced was built once and keyed by bare name, so a later song's
  // `ref-voice` overwrote an earlier song's and a request then verified
  // against a recording from a different song entirely — false drift one
  // way, a silent pass the other (#58 review).
  //
  // The entry's authored pair is the pin (§18 step 3): the hash is
  // authored up front and generate verifies it at run time, but a swap
  // *between* runs has to surface here or the entry stays check-green
  // while describing a different voice.
  for (const song of project.songs) {
    for (const track of song.tracks) {
      for (const entry of track.data.inputs) {
        const ref = entry.generative?.voice_ref;
        const declared = entry.generative?.voice_ref_sha256;
        if (ref === undefined || declared === undefined) continue;
        const recorded = lookupAsset(project, song.name, ref)?.asset.sha256;
        if (recorded === undefined) continue; // already diagnosed by validate
        if (recorded !== declared) {
          diagnostics.push({
            file: track.path,
            message:
              `voice_ref "${ref}" is recorded as ${recorded} but the entry declares ` +
              `${declared} — the reference recording changed under the request`,
          });
        }
      }
    }
  }
  // Takes are committed artifacts with recorded hashes too
  // (project-layout.md §1.4) — a request whose WAVs drifted is
  // provenance that lies, which is the one thing provenance must never
  // do. Verified against the takes file, which is what recorded the
  // hash and what you would regenerate from.
  for (const song of project.songs) {
    for (const takesFile of song.genTakes.values()) {
      for (const variant of takesFile.data.variants) {
        const { path } = resolveAssetFile(project.root, song.dir, variant.file);
        if (!path) continue; // already diagnosed by validate
        const actual = await sha256File(path);
        if (actual !== variant.sha256) {
          diagnostics.push({
            file: takesFile.path,
            message: `variant "${variant.file}" content does not match its recorded sha256 (hashes to ${actual})`,
          });
        }
      }
    }
  }
  // The state-blob pool's drift guard (plugin-hosting.md decision 4):
  // a blob's filename *is* its declared hash, so verification is content
  // hashing to its own name — the same guard a ledger pin gives an
  // asset, intrinsic instead of recorded.
  for (const blob of indexStateBlobs(project.root)) {
    const actual = await sha256File(join(project.root, blob.path));
    if (actual !== blob.sha256) {
      diagnostics.push({
        file: blob.path,
        message: `state blob content does not hash to its filename (hashes to ${actual})`,
      });
    }
  }
  return diagnostics;
}
