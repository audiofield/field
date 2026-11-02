import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readWav, readWavHeader } from '../audio/wav.js';
import { generatorName, mintsGenerator, placedWindow } from '../generators/stem.js';
import type { LoadedSong } from '../model/project.js';
import { barTicks, MeterMap, TempoMap } from '../time/tempo.js';
import { sha256Text } from '../hash.js';
import type { InputEntry, TrackTime } from '../schema/index.js';
import type { UiInsert, UiMark, UiTimeline, UiTimelineLane } from './ui-protocol.js';

// The song seen in time: a pure projection from the loaded project to
// lanes with absolute sample windows, plus the bar marks the ruler
// draws.
//
// From the files, not the compiled session, for the plan's reason: the
// session is a build artifact whose shape depends on cache state, so a
// frozen child's clips collapse into one rendered stem and lanes would
// gain and lose their insides as the cache warms. The window is a fact
// about the placement.
//
// The windows come from `placedWindow`, the planner's own function.
// Re-deriving `at`/`duration` here would be a second implementation of
// the arithmetic that decides where audio actually lands, and the two
// would drift silently — the picture disagreeing with the render is the
// one bug this view cannot afford, because the picture is the evidence.

// Bars are not linear in samples: a tempo event may ramp, so a client
// interpolating between two marks draws the grid wrong exactly where
// the music is doing something interesting. Every bar gets its own
// mark, projected through the real map.
function barMarks(tempo: TempoMap, meter: MeterMap, lengthSamples: number): UiMark[] {
  const marks: UiMark[] = [];
  let bar = 1;
  let tick = 0;
  // Walk the meter segments the map already validated, using its own
  // barTicks rather than recomputing a bar's length from numerator and
  // denominator — the same reason the windows come from placedWindow.
  // Bounded rather than while(true): a pathological map should not spin
  // the server even though validation makes one unreachable.
  for (let i = 0; i < 4096; i++) {
    const sample = Math.round(tempo.ticksToSamples(tick));
    if (sample > lengthSamples) break;
    marks.push({ sample, bar });
    let seg = 0;
    while (seg + 1 < meter.events.length && meter.events[seg + 1]!.at <= tick) seg++;
    const length = barTicks(meter.events[seg]!);
    if (length <= 0) break;
    tick += length;
    bar++;
  }
  return marks;
}

// A source's header, or undefined while it is missing or mid-rename.
function headerOf(path: string): { frames: number; sampleRate: number } | undefined {
  try {
    const { frames, sampleRate } = readWavHeader(path);
    return { frames, sampleRate };
  } catch {
    return undefined;
  }
}

// Peak envelope for a lane: the frames [from, to) of the source the
// placement reads, in buckets across the drawn window.
//
// Deliberately the cheap half of waveforms. Doing them properly means a
// peaks artifact with a build rule, a cache and an invalidation story —
// a project of its own, and still the right answer for long material.
// This computes the envelope on demand from the stem the build already
// materialized and memoises it by that file's identity, which is enough
// for songs of a few minutes and buys the picture its content now.
const peakCache = new Map<string, number[]>();
export function peaksFor(path: string, buckets: number, from = 0, to?: number): number[] | undefined {
  if (!existsSync(path)) return undefined;
  // Keyed on the artifact's own identity — size and modification time —
  // rather than on anything about the song. An earlier version keyed on
  // the session's total length, which does not move when a stem's
  // contents change, so every same-length edit (a fader, a mute, an
  // insert: nearly all of them) redrew the previous audio. The build
  // materializes by rename and skips entirely when the bytes already
  // match, so mtime moves exactly when the content does and not
  // otherwise.
  let key: string;
  let wav;
  try {
    // Both reads race the same thing and need the same guard: the build
    // replaces this artifact by rename while the view is asking about
    // it, so it can vanish between the existsSync above and either call.
    const stat = statSync(path);
    key = `${path}:${stat.size}:${stat.mtimeMs}:${from}:${to ?? ''}`;
    const cached = peakCache.get(key);
    if (cached) return cached;
    wav = readWav(path);
  } catch {
    return undefined; // an unreadable artifact is a lane without a picture
  }
  const total = wav.channels[0]?.length ?? 0;
  const first = Math.min(from, total);
  const end = Math.min(total, to ?? total);
  const frames = end - first;
  if (frames <= 0) return undefined;
  const out: number[] = new Array(buckets).fill(0);
  const per = frames / buckets;
  for (let b = 0; b < buckets; b++) {
    const from = first + Math.floor(b * per);
    const to = Math.min(end, first + Math.floor((b + 1) * per));
    let peak = 0;
    // Stride large buckets: a 16-second stem at 48 k is 768 k frames and
    // the envelope only needs the shape, not every sample.
    const step = Math.max(1, Math.floor((to - from) / 512));
    for (const ch of wav.channels) {
      for (let i = from; i < to; i += step) {
        const v = Math.abs(ch[i] ?? 0);
        if (v > peak) peak = v;
      }
    }
    out[b] = Math.min(1, peak);
  }
  peakCache.set(key, out);
  if (peakCache.size > 64) peakCache.delete(peakCache.keys().next().value as string);
  return out;
}

// The entries that draw a lane, each with its index in the document's
// `inputs:` list. Receives draw none, so the lane list is shorter than
// `inputs:` whenever one is present; every socket op addresses the
// document by `entry`, so the index has to survive the filter rather
// than be re-counted after it.
function placements(inputs: InputEntry[]): Array<[InputEntry, number]> {
  return inputs.flatMap((entry, i): Array<[InputEntry, number]> => (entry.receive === undefined ? [[entry, i]] : []));
}

// An owner track's clock, for the view and for the edits made through
// it: the track's own tempo and meter, else the song's (nested-tracks.md
// §13), built at the session rate because every position the view draws
// and every offset an edit carries is in session samples.
export function ownerClock(
  owner: { data: { time?: TrackTime | undefined } },
  song: Pick<LoadedSong, 'time'>,
  rate: number,
): { tempo: TempoMap; meter: MeterMap } {
  return {
    tempo: new TempoMap(owner.data.time?.tempo ?? song.time?.tempo ?? [{ at: 0, bpm: 120 }], rate),
    meter: new MeterMap(owner.data.time?.meter ?? song.time?.meter ?? [{ at: 0, numerator: 4, denominator: 4 }]),
  };
}

export function projectTimeline(
  root: string,
  song: LoadedSong,
  sessionRate: number,
  lengthSamples: number,
  peakBuckets: number,
): UiTimeline {
  const byName = new Map(song.tracks.map((t) => [t.data.name, t]));
  const assetFile = (name: string): string | undefined => {
    const row = song.assets?.data.assets.find((a) => a.name === name);
    return row === undefined ? undefined : join(root, song.dir, row.file);
  };
  const main = byName.get('main');
  const songTempo = new TempoMap(song.time?.tempo ?? [{ at: 0, bpm: 120 }], sessionRate);
  const songMeter = new MeterMap(song.time?.meter ?? [{ at: 0, numerator: 4, denominator: 4 }]);

  // One lane per placement, recursing into placed tracks. Depth is
  // bounded by the track graph, which validation already proves acyclic;
  // `seen` is a backstop so a project that somehow reached here with a
  // cycle produces a truncated picture rather than a hung server.
  const laneFor = (
    // The LoadedFile itself: its `raw` is the exact text `data` was
    // parsed from, which is what makes the hash below describe the
    // document the lane was actually built out of. Re-reading the file
    // here would let the lane's content come from one read and its
    // stale guard from another, and an edit validated against the
    // second would land on a document the view never rendered.
    owner: { data: { name: string; inputs: InputEntry[]; time?: TrackTime | undefined }; path: string; raw: string },
    entry: InputEntry,
    index: number,
    originSample: number,
    depth: number,
    seen: ReadonlySet<string>,
  ): UiTimelineLane => {
    // Everything in a track file is in that track's own time
    // (nested-tracks.md §13), falling back to the song's.
    const localTempo = ownerClock(owner, song, sessionRate).tempo;
    const w = placedWindow(entry, localTempo);
    const startSample = originSample + w.start;

    const placedName = entry.track;
    const placed = placedName !== undefined ? byName.get(placedName) : undefined;
    // What the placement reads, where the view can find it: a placed
    // track's rendered stem, or a song asset's file. The engine plays an
    // open window for the source's length past the read offset
    // (`source_offset - slip`, in source frames), so that, not the song's
    // end, is how long an open window is, and the envelope is drawn from
    // the slice the window reads rather than the whole source.
    const sourcePath =
      placedName !== undefined
        ? join(root, '.field', 'out', song.dir, 'track', `${placedName}.wav`)
        : entry.audio !== undefined
          ? assetFile(entry.audio)
          : undefined;
    const source = sourcePath !== undefined ? headerOf(sourcePath) : undefined;
    const readOffset = entry.source_offset - entry.slip;
    const toSession = source ? sessionRate / source.sampleRate : 1;
    const openLength = source
      ? Math.round((source.frames - readOffset) * toSession)
      : lengthSamples - startSample;
    const duration = w.duration ?? Math.max(0, Math.min(openLength, lengthSamples - startSample));
    const recurse = placed !== undefined && !seen.has(placedName!) && depth < 6;
    // Where the placed track's own sample 0 falls on the timeline. The
    // planner reads the placed render from `source_offset - slip`
    // (stem.ts readOffsetFor), in the placed track's rate, so at the
    // window start the listener hears that sample, not the track's zero.
    // Children drawn from the window start would sit `slip` early, and a
    // cut made where they sound would land that far off.
    const childOrigin =
      placed === undefined
        ? startSample
        : startSample -
          Math.round(((entry.source_offset - entry.slip) * sessionRate) / (placed.data.rate ?? sessionRate));

    return {
      entry: index,
      file: owner.path,
      sha256: sha256Text(owner.raw),
      // A generator entry (record, supercollider, generative, notes) is
      // named as the graph names it, by its generator name: the track's
      // own name, or `<track>-<id>` when it has an id, so two in one track
      // differ.
      name: placedName ?? entry.audio ?? entry.receive ??
        (mintsGenerator(entry) ? generatorName(entry, owner.data.name) : `input ${index + 1}`),
      start: startSample,
      duration,
      depth,
      gain_db: entry.gain_db,
      pan: entry.pan,
      mute: entry.mute,
      canSolo: placedName !== undefined,
      trackFile: placed?.path ?? null,
      trackSha256: placed ? sha256Text(placed.raw) : null,
      // A track renders at its own rate, or the song's (graph.ts
      // trackRate), and its filters are designed at that rate.
      trackRate: placed ? (placed.data.rate ?? song.song?.data.rate ?? sessionRate) : null,
      inserts: placed
        ? placed.data.inserts.map(
            (ins, i): UiInsert => ({
              entry: i,
              effect: 'effect' in ins ? String(ins.effect) : 'plugin',
              // The whole parsed insert, defaults applied — the knobs
              // render from real values, not from re-derived ones.
              params: { ...ins },
            }),
          )
        : null,
      children: recurse
        ? placements(placed!.data.inputs).map(([child, i]) =>
            laneFor(placed!, child, i, childOrigin, depth + 1, new Set([...seen, placedName!])),
          )
        : null,
      clips: [{ start: startSample, duration, exact: w.duration !== undefined, name: placedName ?? entry.audio ?? 'input' }],
      peaks:
        placedName === undefined || sourcePath === undefined
          ? undefined
          : peaksFor(
              sourcePath,
              peakBuckets,
              Math.max(0, readOffset),
              source ? Math.max(0, readOffset) + Math.round(duration / toSession) : undefined,
            ),
    };
  };

  const lanes = placements(main?.data.inputs ?? []).map(([entry, i]) =>
    laneFor(main!, entry, i, 0, 0, new Set(['main'])),
  );

  return {
    rate: sessionRate,
    length: lengthSamples,
    marks: barMarks(songTempo, songMeter, lengthSamples),
    lanes,
  };
}
