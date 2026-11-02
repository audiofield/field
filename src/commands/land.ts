import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Document, isSeq, parseDocument } from 'yaml';
import { readWavHeader } from '../audio/wav.js';
import { anyTakeSchema, midiTakeLineSchema, type AnyTake, type MidiTake, type Take } from '../audiod/protocol.js';
import { DEFAULT_SAMPLE_RATE } from '../constants.js';
import { generatorName, placedWindow } from '../generators/stem.js';
import { sha256File } from '../hash.js';
import { parseLabel, SONG_OUTPUT_NAME } from '../labels.js';
import { takenSongNames } from '../model/namespace.js';
import type { TrackTime } from '../graph/graph.js';
import { loadProject, recordTakesPath, type LoadedProject, type LoadedSong } from '../model/project.js';
import { recordTakesOrder, recordTakesSchema, type InputEntry, type RecordedTake } from '../schema/index.js';
import { formatNotesFile, notesFromMessages, type CapturedMessage, type TimedNotes } from '../schema/notes.js';
import { entryTick } from '../time/notes.js';
import { MeterMap, TempoMap } from '../time/tempo.js';
import { canonicalizeDocument, stringifyDocument } from '../yaml/emit.js';
import { appendLedgerRow, openLedger } from './import.js';
import { songDirOfPath } from './transport.js';

// Landing a take (recording.md §3, chunk 2): the daemon finalized a
// transaction under .field/recording/<id>/ — bytes, manifest, journal —
// and this is what turns it into a take of the project. The bytes move
// to audio/<node>/<id>.wav and pin in the song's ledger, where recorded
// audio pins (project-layout.md §1.6); the record goes beside them as a
// row in audio/<node>/takes.yaml, placed on the recording track's own
// timeline; the new take is chosen (§11, resolved 2026-09-06: tracking
// wants to hear what it just sang); and the transaction directory goes
// away, because the project now holds everything it held.

export interface RecordNode {
  song: LoadedSong;
  trackName: string;
  node: string; // the record node: the track's name, or <track>-<id>
  entry: InputEntry;
  // The track's, which decides the kind of take (sequencer.md §3.4).
  instrument?: string | undefined;
}

// The record entry a track carries, resolved from the label a take
// names. One per track for now: a second would need the take to say
// which node it lands in, which nothing asks yet.
export function recordNodeFor(project: LoadedProject, trackLabel: string): RecordNode {
  const label = parseLabel(trackLabel);
  const songDir = label.pkg.replace(/\/track$/, '');
  const song = project.songs.find((s) => s.dir === songDir);
  const track = song?.tracks.find((t) => t.data.name === label.name);
  if (song === undefined || track === undefined) {
    throw new Error(`no such track ${trackLabel}`);
  }
  const entries = track.data.inputs.filter((e) => e.record !== undefined);
  if (entries.length === 0) {
    throw new Error(
      `${track.data.name} has no \`record:\` entry — add \`- record:\` to its inputs so its ` +
        `takes have somewhere to attach (recording.md §4)`,
    );
  }
  if (entries.length > 1) {
    throw new Error(
      `${track.data.name} carries ${entries.length} record entries; a take lands in one, and ` +
        `nothing says which yet — keep one`,
    );
  }
  const entry = entries[0]!;
  return {
    song,
    trackName: track.data.name,
    node: generatorName(entry, track.data.name),
    entry,
    instrument: track.data.instrument,
  };
}

// Where a track's timeline begins on the song's: the sum of the `at`s
// down its first placement path from the output track, in seconds.
// The daemon reported the take's start on the song's timeline (the
// session it played), and the take is placed on the track's, so this is
// the difference between them. A track placed more than once records
// against its earliest placement — `placements` says how many there
// were, so the caller can say so — and a track the song does not place
// at all has its own timeline from zero.
export function trackOrigin(
  project: LoadedProject,
  song: LoadedSong,
  target: string,
): { seconds: number; placements: number } {
  const songRate = song.song?.data.rate ?? project.manifest?.data.sample_rate ?? DEFAULT_SAMPLE_RATE;
  const tempo = song.time ? new TempoMap(song.time.tempo, songRate) : undefined;
  const byName = new Map(song.tracks.map((t) => [t.data.name, t.data]));
  const origins: number[] = [];
  const visit = (name: string, origin: number, path: Set<string>): void => {
    if (name === target) {
      origins.push(origin);
      return;
    }
    const track = byName.get(name);
    if (track === undefined || path.has(name)) return;
    const onPath = new Set(path).add(name);
    for (const entry of track.inputs) {
      if (entry.track === undefined) continue;
      // `at` is samples at the placing track's rate when absolute, ticks
      // under the song's map otherwise (validate resolved every array).
      const at =
        entry.anchor === 'absolute'
          ? entry.at / (track.rate ?? songRate)
          : tempo !== undefined
            ? tempo.ticksToSeconds(entry.at)
            : 0;
      visit(entry.track, origin + at, onPath);
    }
  };
  visit(SONG_OUTPUT_NAME, 0, new Set());
  return { seconds: origins.length > 0 ? Math.min(...origins) : 0, placements: origins.length };
}

export interface LandOptions {
  monitoring?: string | undefined; // audio-engine.md "Monitoring": apollo-direct by default, or host
  consolePreset?: string | undefined;
}

export interface LandedTake {
  song: string;
  track: string;
  node: string;
  asset: string; // the take's ledger name
  file: string; // song-relative
  row: RecordedTake;
  // Track samples: where a MIDI take's musical position falls, or the
  // entry's window start + started_at_samples - latency for an audio take.
  placedAt: number;
  placements: number; // how many times the song places the track
  frames: number;
  sampleRate: number;
  events?: number; // a MIDI take's captured messages
}

// A finalized transaction's manifest, read back from disk for --land.
export function readTransaction(root: string, id: string): AnyTake {
  const path = join(root, '.field', 'recording', id, 'manifest.json');
  if (!existsSync(path)) throw new Error(`no recording transaction ${id}`);
  const take = anyTakeSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  if (!take.complete) {
    throw new Error(`${id} is not complete — field record --recover ${id} finalizes it first`);
  }
  return take;
}

function musicalPosition(meter: MeterMap, ticks: number): number[] {
  const parts = meter
    .format(Math.max(0, ticks))
    .split('.')
    .map((p) => Number(p));
  // [17, 1, 1] is bar 17, which the array form spells [17].
  while (parts.length > 1 && parts[parts.length - 1] === 1) parts.pop();
  return parts;
}

// What every take shares on its way into the project, whatever it holds:
// the checks, the node it lands in, the ledger it pins in, and where it
// sits on the recording track.
interface Landing {
  root: string;
  take: AnyTake;
  node: RecordNode;
  songDir: string;
  ledger: ReturnType<typeof openLedger>['doc'];
  trackRate: number;
  startedAt: number;
  windowStart: number;
  placements: number;
  position: number[] | undefined;
  // Where the take started on the track, in seconds, and the track's own
  // maps: what a MIDI take's ticks count from and through.
  startSeconds: number;
  time: TrackTime;
}

function beginLanding(root: string, take: AnyTake): Landing {
  if (!take.complete || take.frames === undefined) {
    throw new Error(`${take.id} is not complete — field record --recover ${take.id} finalizes it first`);
  }
  const project = loadProject(root);
  const errors = project.diagnostics.filter((d) => d.severity !== 'warning');
  if (errors.length > 0) {
    throw new Error(`project has errors (field check) — fix them before landing ${take.id}`);
  }
  const node = recordNodeFor(project, take.track);
  const { song, trackName, entry, instrument } = node;
  const midi = 'kind' in take;
  // The track's instrument decides the kind of take it records
  // (sequencer.md §3.4), so a take of the other kind has no business
  // landing in it.
  if (midi && instrument === undefined) {
    throw new Error(
      `${take.id} is a MIDI take, and ${trackName} has no instrument to play it — ` +
        'give the track one with `instrument: <name>`',
    );
  }
  if (!midi && instrument !== undefined) {
    throw new Error(`${take.id} is an audio take, and ${trackName} records MIDI for ${instrument}`);
  }
  const songDir = join(root, song.dir);
  const track = song.tracks.find((t) => t.data.name === trackName)!.data;
  if (!existsSync(join(root, take.file))) throw new Error(`${take.file} is missing — nothing to land`);
  const { doc: ledger, assets } = openLedger(songDir);
  if (assets.some((a) => a.name === take.id) || takenSongNames(songDir).has(take.id)) {
    throw new Error(`"${take.id}" is already a name in ${song.name} — was this take landed already?`);
  }

  // The record: placement counted from the record entry's own window,
  // at the track's rate — the same reading the graph makes (graph.ts
  // withTakes adds the window start back), so the entry's placement
  // fields mean what they mean on every other kind and moving its `at`
  // moves its takes. The daemon's start is on the bed's timeline at the
  // bed's rate; the track's origin on that timeline comes off, the rate
  // changes, then the entry's window start comes off in track samples.
  const songRate = song.song?.data.rate ?? project.manifest?.data.sample_rate ?? DEFAULT_SAMPLE_RATE;
  const trackRate = track.rate ?? songRate;
  const timelineRate = take.timeline_rate ?? take.sample_rate;
  const origin = trackOrigin(project, song, trackName);
  const startedOnBed = take.started_at_samples ?? 0;
  const onTrack = Math.round(
    ((startedOnBed - Math.round(origin.seconds * timelineRate)) * trackRate) / timelineRate,
  );
  // The entry's window under the track's own map, as the graph projects
  // it (nested-tracks.md §13): a track's `time:` when it has one, else
  // the song's at the track's rate.
  // A project without errors has the song's `time:`.
  const time: TrackTime = {
    tempo: new TempoMap(track.time?.tempo ?? song.time!.tempo, trackRate),
    meter: new MeterMap(track.time?.meter ?? song.time!.meter),
  };
  const windowStart = placedWindow(entry, time.tempo).start;
  // What the song's map said at capture, when the bed was the song —
  // its live session, or an artifact of it (a stem, a take) — and not
  // when it was some other file.
  const bedIsSong =
    take.song === song.name ||
    (take.source !== undefined && songDirOfPath(root, take.source) === song.dir);
  const position =
    bedIsSong && song.time !== undefined
      ? musicalPosition(
          new MeterMap(song.time.meter),
          Math.round(new TempoMap(song.time.tempo, timelineRate).samplesToTicks(startedOnBed)),
        )
      : undefined;
  return {
    root,
    take,
    node,
    songDir,
    ledger,
    trackRate,
    startedAt: onTrack - windowStart,
    windowStart,
    placements: origin.placements,
    position,
    startSeconds: startedOnBed / timelineRate - origin.seconds,
    time,
  };
}

// Ledger first, then the row that names it, then the transaction goes:
// at every point a crash leaves a project `check` can describe — an
// orphan file, a pinned asset no row names — rather than a row whose
// bytes are not there.
function finishLanding(landing: Landing, pin: Parameters<typeof appendLedgerRow>[2], row: RecordedTake): void {
  const { root, take, songDir, ledger } = landing;
  const node = landing.node.node;
  appendLedgerRow(songDir, ledger, pin);
  const takesPath = recordTakesPath(songDir, node);
  let doc: Document;
  if (existsSync(takesPath)) {
    doc = parseDocument(readFileSync(takesPath, 'utf8'));
    if (doc.errors.length > 0) {
      throw new Error(`invalid YAML in ${takesPath}: ${doc.errors[0]!.message}`);
    }
    const parsed = recordTakesSchema.safeParse(doc.toJS());
    if (!parsed.success || parsed.data.record !== node) {
      throw new Error(`the takes in audio/${node}/ are invalid or attach elsewhere (field check)`);
    }
  } else {
    doc = new Document({ record: node, takes: [] });
  }
  if (!isSeq(doc.getIn(['takes']))) doc.setIn(['takes'], doc.createNode([]));
  doc.addIn(['takes'], doc.createNode(row));
  doc.setIn(['chosen'], take.id);
  canonicalizeDocument(doc, recordTakesOrder);
  writeFileSync(takesPath, stringifyDocument(doc));
  rmSync(join(root, '.field', 'recording', take.id), { recursive: true, force: true });
}

function landed(landing: Landing, file: string, row: RecordedTake, frames: number, sampleRate: number): LandedTake {
  return {
    song: landing.node.song.name,
    track: landing.node.trackName,
    node: landing.node.node,
    asset: landing.take.id,
    file,
    row,
    placedAt: landing.windowStart + row.started_at_samples - row.latency,
    placements: landing.placements,
    frames,
    sampleRate,
  };
}

// The take's file under the record node's directory, written by `write`,
// with what the ledger pins it by.
async function placeFile(
  landing: Landing,
  extension: string,
  write: (dest: string) => void,
): Promise<{ file: string; dest: string; sha256: string; bytes: number }> {
  const file = `audio/${landing.node.node}/${landing.take.id}${extension}`;
  const dest = join(landing.songDir, file);
  mkdirSync(dirname(dest), { recursive: true });
  write(dest);
  return { file, dest, sha256: await sha256File(dest), bytes: statSync(dest).size };
}

// The row's fields every take has; each kind adds its own.
function sharedRow(landing: Landing, latency: number) {
  return {
    asset: landing.take.id,
    started_at_samples: landing.startedAt,
    ...(landing.position !== undefined ? { musical_position: landing.position } : {}),
    latency,
    recorded_at: landing.take.started_wall,
  };
}

export async function landTake(root: string, take: Take, options: LandOptions = {}): Promise<LandedTake> {
  const landing = beginLanding(root, take);
  // The bytes, into the song's ledger under the record node's directory.
  const { file, dest, sha256, bytes } = await placeFile(landing, '.wav', (to) => copyFileSync(join(root, take.file), to));
  const header = readWavHeader(dest);

  // Latency is the device's declared round trip (recording.md §12.3 —
  // input plus output, which is what a performer hearing the interface's
  // direct path actually runs behind), scaled from device samples to the
  // track's.
  const latency = Math.round(((take.input_latency + take.output_latency) * landing.trackRate) / take.sample_rate);
  const row: RecordedTake = {
    ...sharedRow(landing, latency),
    device: take.device,
    input: take.input,
    ...(options.monitoring !== undefined ? { monitoring: options.monitoring } : {}),
    ...(options.consolePreset !== undefined ? { console_preset: options.consolePreset } : {}),
  };
  finishLanding(landing, { name: take.id, file, sha256, bytes, header }, row);
  return landed(landing, file, row, header.frames, header.sampleRate);
}

// A MIDI take (keyboard-instrument.md §12.1, sequencer.md §2.4): the
// captured messages pair into notes, and every time becomes ticks from
// the take's start through the track's tempo map, after the output
// latency comes off, because a player presses a key in time with what
// they hear, which runs behind the playhead by that much. A note pressed
// that early in the take's first moments starts with the take, and one
// that ended before the take or its track began is dropped. Its one
// writer writes the file once, pinned in the ledger by hash like any take,
// with no WAV facts. The row's started_at_ticks is where the take starts, counted
// from the tick its record entry's window starts on, which is where its
// notes play from, so the take moves with the entry; its
// musical_position records where that was on the track, in the track's
// own time.
export async function landMidiTake(root: string, take: MidiTake): Promise<LandedTake> {
  const landing = beginLanding(root, take);
  const messages: CapturedMessage[] = readFileSync(join(root, take.file), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => midiTakeLineSchema.parse(JSON.parse(line)));
  const { tempo, meter } = landing.time;
  const heard = (at: number): number => landing.startSeconds + (at - take.output_latency) / take.sample_rate;
  const tickAt = (seconds: number): number => Math.round(tempo.secondsToTicks(Math.max(0, seconds)));
  const start = tickAt(landing.startSeconds);
  const ticks = (at: number): number => Math.max(0, tickAt(heard(at)) - start);
  const played = notesFromMessages(messages, take.frames!);
  const notes: TimedNotes = {
    length: ticks(take.frames!),
    notes: played.notes
      .filter((n) => heard(n.at + n.length) >= 0 && tickAt(heard(n.at + n.length)) >= start)
      .map((n) => ({ ...n, at: ticks(n.at), length: ticks(n.at + n.length) - ticks(n.at) })),
    controls: played.controls.map((c) => ({ ...c, at: ticks(c.at) })),
    bends: played.bends.map((b) => ({ ...b, at: ticks(b.at) })),
  };
  const { file, sha256, bytes } = await placeFile(landing, '.notes.yaml', (to) => writeFileSync(to, formatNotesFile(notes)));

  const row: RecordedTake = {
    ...sharedRow(landing, Math.round((take.output_latency * landing.trackRate) / take.sample_rate)),
    started_at_ticks: start - entryTick(landing.node.entry, tempo),
    musical_position: musicalPosition(meter, start),
    sources: take.sources,
  };
  finishLanding(landing, { name: take.id, file, sha256, bytes }, row);
  return {
    ...landed(landing, file, row, take.frames!, take.sample_rate),
    placedAt: tempo.ticksToSamples(start),
    events: messages.length,
  };
}

// Lands either kind of take, by what its manifest says it is.
export function landAnyTake(root: string, take: AnyTake, options: LandOptions = {}): Promise<LandedTake> {
  return 'kind' in take ? landMidiTake(root, take) : landTake(root, take, options);
}

// `field choose <song>/<node> --take <name>`: repoint which take the
// record entry plays, the way choosing a variant repoints a gen node.
// One line in audio/<node>/takes.yaml; the bytes never move.
export async function chooseTake(
  root: string,
  songName: string,
  node: string,
  takeName: string,
): Promise<{ previous?: string | undefined }> {
  const project = loadProject(root);
  const song = project.songs.find((s) => s.name === songName);
  if (song === undefined) throw new Error(`song "${songName}" does not exist`);
  const minted = song.tracks.some((t) =>
    t.data.inputs.some((e) => e.record !== undefined && generatorName(e, t.data.name) === node),
  );
  if (!minted) throw new Error(`no record entry "${node}" in ${songName}`);
  const takesPath = recordTakesPath(join(root, song.dir), node);
  if (!existsSync(takesPath)) {
    throw new Error(`"${node}" has no takes yet — field record ${songName}/track:${node}`);
  }
  const doc = parseDocument(readFileSync(takesPath, 'utf8'));
  const parsed = recordTakesSchema.safeParse(doc.toJS());
  if (!parsed.success || parsed.data.record !== node) {
    throw new Error(`the takes in audio/${node}/ are invalid or attach elsewhere (field check)`);
  }
  if (!parsed.data.takes.some((t) => t.asset === takeName)) {
    throw new Error(
      `no take "${takeName}" in audio/${node}/ — the takes are: ${parsed.data.takes.map((t) => t.asset).join(', ')}`,
    );
  }
  const previous = parsed.data.chosen;
  doc.setIn(['chosen'], takeName);
  canonicalizeDocument(doc, recordTakesOrder);
  writeFileSync(takesPath, stringifyDocument(doc));
  return { previous };
}
