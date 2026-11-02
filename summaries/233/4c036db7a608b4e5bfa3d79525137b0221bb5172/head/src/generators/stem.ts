import type { HostedTrackContext, PluginInsertSpec } from '../audio/plugins.js';
import { toPluginSpec, toPluginWire } from '../audio/plugins.js';
import { renderInsertChain } from '../audio/render-daemon.js';
import { readWavHeader } from '../audio/wav.js';
// trackRef spells a placed track in `sources` (labels.ts). Nothing about
// the spelling reaches an action key — `sources` is wiring, so the
// spelling is free and only the resulting order matters, which is why
// the buildable sort below is spelling-blind: order is the one channel
// a spelling change could reach the key through.
import { convertRefName, genRef, genRefName, recordRef, tapRefName, trackRef, trackRefName } from '../labels.js';
import type { EffectInsert, InputEntry, Track } from '../schema/index.js';
import { isHostedInsert } from '../schema/index.js';
import type { NotesFile, ResolvedNotes } from '../schema/notes.js';
import { placementAnchor, resolveNotes, type NotesTime } from '../time/notes.js';
import type { TempoMap } from '../time/tempo.js';
import type { Generator } from './types.js';

// stem: the implicit generator behind //songs/<song>/track:<name>
// (mix-assembly.md §3) — a mix file defines a mix, a track file implies
// a stem. The spec is synthesized from the track file, never declared:
// entry windows are projected through the tempo map
// to samples *before* hashing, so the action key sees the resolved placement
// plan. A tempo edit therefore rebuilds exactly the tracks whose musical
// entries moved; reordering entries in YAML or renaming an asset changes
// nothing. Stems render pre-fader (levels are edge parameters)
// and start at timeline sample 0 so the mix can sum by alignment alone.

// What a generator entry's node is named (nested-tracks.md §18 step 2):
// the owning track's name, or <track>-<id> when the entry carries an id
// — which is why a track holding two generator entries needs ids on
// them, and check demands exactly that.
export type SpecInsert = EffectInsert | PluginInsertSpec;

export function generatorName(entry: InputEntry, owner: string): string {
  return entry.id !== undefined ? `${owner}-${entry.id}` : owner;
}

// The entries that mint a gen node, and so take a generator name: a
// render, a request, a record entry, and a part, which renders through
// the track's instrument.
export function mintsGenerator(entry: InputEntry): boolean {
  return (
    entry.supercollider !== undefined ||
    entry.generative !== undefined ||
    entry.record !== undefined ||
    entry.notes !== undefined
  );
}

// The wiring ref an entry contributes to `sources`: kind-in-field in the
// file (nested-tracks.md §18) flattens to one string here — `audio:`
// names pass through (bare, or the //shared/asset: label), a `track:`
// gets its prefix, and a generator entry contributes the node minted
// for it, `gen:<name>` — which is why the owner's name comes in: a
// generator has no name of its own. Exactly the strings the two lists
// produced before they merged, which is what keeps every existing
// action key: refs are wiring, and the resolved plan is what hashes.
export function entryRef(entry: InputEntry, owner: string): string {
  if (entry.track !== undefined) return trackRef(entry.track);
  if (entry.supercollider !== undefined || entry.generative !== undefined || entry.notes !== undefined) {
    return genRef(generatorName(entry, owner));
  }
  if (entry.record !== undefined) return recordRef(generatorName(entry, owner));
  return entry.audio!;
}

// How an entry is named in a diagnostic: its id when it has one, else
// what it plays — entries carry ids for automation, not for errors, so
// a message must not require one.
export function entryLabel(entry: InputEntry): string {
  if (entry.id !== undefined) return entry.id;
  if (entry.supercollider !== undefined) return 'supercollider';
  if (entry.generative !== undefined) return 'generative';
  if (entry.record !== undefined) return 'record';
  return entry.track ?? entry.audio ?? entry.notes ?? '?';
}

export interface PlacedClip {
  input: number; // index into spec.sources
  start: number; // stem sample where the clip window begins
  // Window length in samples. Absent means "as long as the input is" —
  // the placement plays its whole source and truncates nothing
  // (nested-tracks.md §1.6: a container never truncates, a placement may,
  // and an omitted duration is the placement declining to).
  //
  // **Either kind may omit it**, and nothing downstream may assume
  // otherwise. Until 2026-08-08 only a placed track could, on the
  // argument that a clip's source is committed content whose length
  // validate can read — true of an asset, false of a buildable sound,
  // whose length is a render as unknowable at plan time as a track's
  // (project-core.md §3.2, amended; nested-tracks.md §15). A reverb
  // insert growing a stem past its last clip end is the same fact from
  // the track side.
  //
  // execute() resolves it from the rendered input, after the input is
  // built and before the daemon sees a plan, and does not care which kind
  // it came from. Staying out of the action key is correct rather than
  // convenient: the input's content hash is already an input, so "the
  // whole of it" re-keys when its length moves.
  duration?: number;
  // Sample of the asset playing at the window start (source_offset − slip,
  // project-core.md §3.2). May be negative or run past the asset's end:
  // out-of-range reads are silence — slipping never errors.
  read_offset: number;
  gain_db: number;
  // Balance for this placement, -1 left … 1 right: `balanceGains`
  // attenuates the opposite channel and never boosts, so this is not a
  // constant-power pan — hard over silences one channel, which is 3 dB of
  // total power for a centred source.
  // **Omitted when centred**, which is not a micro-optimisation: `clips`
  // reaches the action key, so serializing `pan: 0` on every clip would
  // re-key every stem in every project for a field none of them set. Same
  // rule `inserts` follows (nested-tracks.md §1.13).
  pan?: number;
  fade_in: number; // samples, linear, from the window start
  fade_out: number; // samples, linear, to the window end
}

// What the daemon renders: every window resolved to a length. The two
// types are deliberately distinct — `duration?` is a fact about a *plan*,
// and letting it reach the wire would make the daemon's job conditional
// on something the control plane is supposed to have already decided.
export type RenderedClip = Omit<PlacedClip, 'duration'> & { duration: number };

// A cable arriving at this track (nested-tracks.md §19), as the planner
// consumes it: the wiring ref the graph chose for the tap point
// (`track:<sender>` for post, `tap:<sender>` for pre), the edge's level,
// and the derived arrivals in this track's samples. Each arrival becomes
// an ordinary clip playing the sender's whole render — which is the §19
// action-key claim made literal: the receive re-keys on sender content
// (the input hash), gain and arrivals (the clips), and tap (which ref is
// wired). The shape mirrors model/cables.ts CableArrival structurally
// rather than importing it — cables.ts imports this module's planners,
// and a type is not worth a cycle.
export interface CableIn {
  ref: string;
  gainDb: number;
  arrivals: { at: number; count: number }[];
}

// Every track has a stem, including an empty one — it renders as
// silence, which is what it contains. `field song create` writes an
// empty `main`, and a label the bare song name resolves to has to exist
// from that moment rather than from the first entry. (`type: midi` — the
// one kind that rendered nothing — retired with the one-list format,
// nested-tracks.md §18.)

export interface StemSpec {
  name: string;
  type: 'stem';
  // Wiring: clips index into this source list, matching the graph's dep
  // order. Committed-content sources (assets, shared pins, chosen
  // generate sounds — anything whose hash is known before building) sort
  // by content hash, so renames cannot reach the key; buildable sounds
  // sort by name — their content hashes don't exist until they build,
  // and a sound rename is a real relabel.
  sources: string[];
  clips: PlacedClip[];
  // Inserts bake into the stem (effects.md §5): parameters here mean an
  // insert edit re-renders it. Omitted entirely when the track has none,
  // so insert-less stems keep their pre-inserts action keys. Built-in
  // arms are the authored YAML verbatim; hosted arms are the keyed
  // spelling (plugin-hosting.md decision 8) — identity not display
  // name, full state hash not short ref, resolved transport included.
  inserts?: SpecInsert[];
  // The song's declared extent, present only on the track that is the
  // song's output (labels.ts SONG_OUTPUT_NAME). The mix carried these
  // until a track could be a song's output; the fields, the meaning and
  // the daemon's rule about them are the mix's, unchanged. Omitted
  // otherwise, so every other stem keeps its key.
  length_samples?: number;
  loop?: boolean;
}

// An entry's window on the stem timeline, in samples — one projection
// for every kind, because the window never depended on what produced the
// audio. Musical entries project both edges through the tempo map (the
// window end is at + duration in ticks, so a window spanning a ramp gets
// its true sample length); absolute entries are already samples.
export function placedWindow(
  entry: InputEntry,
  tempoMap: TempoMap,
): { start: number; duration?: number } {
  // An omitted duration stays omitted all the way to execute(), which
  // resolves it from the rendered input — the source's length is not
  // knowable while planning, whichever kind renders it.
  if (entry.anchor === 'absolute') {
    return entry.duration === undefined
      ? { start: entry.at }
      : { start: entry.at, duration: entry.duration };
  }
  const start = tempoMap.ticksToSamples(entry.at);
  if (entry.duration === undefined) return { start };
  return { start, duration: tempoMap.ticksToSamples(entry.at + entry.duration) - start };
}

// The window a loop tiles, in samples. Every repetition has a concrete
// window: a loop tiles a window, so a looping entry declares a duration
// even though an ordinary one need not (schema/track.ts). `check`
// refuses the combination by name; this is the guard for anything that
// reaches the planner another way.
function loopWindow(entry: InputEntry, tempoMap: TempoMap): { start: number; end: number } {
  const { start, duration } = placedWindow(entry, tempoMap);
  if (duration === undefined) {
    throw new Error(
      `input "${entryLabel(entry)}" loops but declares no duration — a loop tiles a window`,
    );
  }
  return { start, end: start + duration };
}

function anchorSample(entry: InputEntry, at: number, tempoMap: TempoMap): number {
  return entry.anchor === 'absolute' ? at : tempoMap.ticksToSamples(at);
}

// Where each repetition of a loop with `every` starts, in the entry's
// anchor units (clip-looping.md decision 3): ticks on a musical entry,
// so the repetitions stay on the grid straight through tempo ramps, and
// samples on an absolute one.
export function loopStarts(entry: InputEntry, every: number, tempoMap: TempoMap): number[] {
  const { end } = loopWindow(entry, tempoMap);
  const starts: number[] = [];
  for (let at = entry.at; anchorSample(entry, at, tempoMap) < end; at += every) starts.push(at);
  return starts;
}

// What a placed part renders (sequencer.md §9). Each repetition of its
// loop resolves where the repetition starts, as the part placed there by
// hand would, so a tempo or meter change reaches the repetitions after
// it. Repetitions that resolve alike play one render. The first render
// takes the entry's generator name, and each other one that name and
// the number of the first repetition that plays it, `<name>-<n>`.
// `repetitions` names the render each repetition plays, in order.
export function partRenders(
  file: NotesFile,
  entry: InputEntry,
  name: string,
  time: NotesTime,
): { renders: { name: string; events: ResolvedNotes }[]; repetitions: string[] } {
  const starts =
    entry.loop?.enabled && entry.loop.every !== undefined ? loopStarts(entry, entry.loop.every, time.tempo) : [entry.at];
  const renders: { name: string; events: ResolvedNotes }[] = [];
  const renderByEvents = new Map<string, string>();
  const repetitions = starts.map((at, k) => {
    let events: ResolvedNotes;
    try {
      events = resolveNotes(file, placementAnchor({ anchor: entry.anchor, at }, time.tempo), time);
    } catch (err) {
      throw k === 0 ? err : new Error(`at repetition ${k + 1} of its loop: ${(err as Error).message}`);
    }
    const key = JSON.stringify(events);
    let render = renderByEvents.get(key);
    if (render === undefined) {
      render = k === 0 ? name : `${name}-${k + 1}`;
      renderByEvents.set(key, render);
      renders.push({ name: render, events });
    }
    return render;
  });
  return { renders, repetitions };
}

// A placed track's window, projected the same way — the child's origin
// Loop expansion (clip-looping.md §1.6): a looped entry becomes the same
// resolved per-repetition windows equivalent hand-written entries would
// produce — the renderer and the action-key format don't know loops exist.
// Returns windows without input wiring; planTrack fills that in. Exported
// for validate, which runs the same expansion to diagnose exhausted
// sources and fades that outgrow their slots before any graph exists —
// the throw below is a backstop the gate makes unreachable.
export function expandLoop(
  entry: InputEntry,
  loop: NonNullable<InputEntry['loop']>,
  tempoMap: TempoMap,
  sourceFrames: number | undefined,
  // The effective read offset, when the caller has already projected it
  // into the rate the clip reads (a converted source — planTrack's
  // readOffsetFor). Defaulted from the entry itself for every same-rate
  // caller, validate included, which is all of them until a conversion
  // is in play.
  readOffset: number = entry.source_offset - entry.slip,
): Omit<RenderedClip, 'input'>[] {
  const { start, end: windowEnd } = loopWindow(entry, tempoMap);

  // Repetition boundaries on the stem timeline, in samples.
  const bounds: number[] = [];
  if (loop.every !== undefined) {
    bounds.push(...loopStarts(entry, loop.every, tempoMap).map((at) => anchorSample(entry, at, tempoMap)));
  } else {
    // Tile at the source's own length. A buildable's length is unknown at
    // plan time (validate already demands `every` there); an asset whose
    // content is exhausted by the read offset has nothing to tile.
    const interval = (sourceFrames ?? 0) - readOffset;
    if (interval <= 0) {
      throw new Error(
        `input "${entryLabel(entry)}": loop without 'every' needs source content after its read offset`,
      );
    }
    for (let at = start; at < windowEnd; at += interval) bounds.push(at);
  }

  return bounds.map((slotStart, k) => {
    const last = k === bounds.length - 1;
    const slotEnd = last ? windowEnd : bounds[k + 1]!;
    // truncate cuts each repetition at its slot; overlay lets it ring to
    // the window's edge — reads past the source's end are silence, so the
    // voice ends where its content does, and overlapping voices sum like
    // any overlapping windows.
    const repDuration = loop.mode === 'overlay' ? windowEnd - slotStart : slotEnd - slotStart;
    return {
      start: slotStart,
      duration: repDuration,
      read_offset: readOffset,
      gain_db: entry.gain_db,
      // Same omit-when-centred rule as the direct path (PlacedClip.pan):
      // loops only became pannable when placement fields went uniform,
      // and a repetition carries whatever the hand-tiled equivalent would.
      ...(entry.pan !== 0 ? { pan: entry.pan } : {}),
      // Whole-entry fades keep their meaning (first head, window tail);
      // seams get the loop's click-guard. Overlay voices all end at the
      // window edge, so the window fade covers whatever is cut there.
      fade_in: k === 0 ? entry.fade_in : loop.fade,
      fade_out:
        loop.mode === 'overlay' ? entry.fade_out : last ? entry.fade_out : loop.fade,
    };
  });
}

export function planTrack(
  track: Track,
  tempoMap: TempoMap,
  // Content hashes for committed sources, keyed by the exact ref string
  // clips carry (bare name or //shared/asset: label); a ref absent here
  // is a buildable sound. Wiring order is content-hash order for the
  // committed ones (name tiebreak for determinism), so renaming cannot
  // permute the input list or the clip indices — names never reach the
  // action key at all (#9 review) — and name order for buildable sounds.
  sha256BySource: Map<string, string>,
  framesBySource: Map<string, number> = new Map(),
  // Set only for a song's output track; see StemSpec.
  extent: { lengthSamples?: number | undefined; loop?: boolean | undefined } = {},
  // Sources arriving at another rate, rewired through the resample node
  // the graph minted at this edge (multi-rate.md decision 4): raw entry
  // ref → the convert: ref plus the rate ratio. The stem consumes the
  // conversion, so its wiring and its input hash both follow the bytes
  // it actually sums — and the read offset scales by the same ratio,
  // because `source_offset` and `slip` address the *source's* samples
  // (project-core.md §3.2) while the clip reads the converted file: one
  // second into a 44.1 kHz asset is sample 44100 of the original and
  // sample 48000 of what this stem consumes (#112 review, Bugbot).
  convertBySource: Map<string, { ref: string; scale: number }> = new Map(),
  // The cables arriving here, refs pre-conversion like every entry's —
  // the graph mints the same edge conversion for a sender at another
  // rate that it mints for any source.
  cables: CableIn[] = [],
  // Present exactly when the chain holds a hosted insert — computed per
  // track by the graph, so built-in-only chains' specs (and therefore
  // their action keys) never learn plugins exist.
  hosted?: HostedTrackContext,
  // The render each repetition of a placed part plays, by the entry's
  // ref (partRenders).
  repetitionRefs: Map<string, string[]> = new Map(),
): StemSpec {
  const converted = (raw: string): string => convertBySource.get(raw)?.ref ?? raw;
  const refFor = (e: InputEntry): string => converted(entryRef(e, track.name));
  const repetitionRef = (e: InputEntry, k: number): string => {
    const raw = entryRef(e, track.name);
    return converted(repetitionRefs.get(raw)?.[k] ?? raw);
  };
  const refsOf = (e: InputEntry): string[] => {
    const raw = entryRef(e, track.name);
    return (repetitionRefs.get(raw) ?? [raw]).map(converted);
  };
  const readOffsetFor = (e: InputEntry): number => {
    const scale = convertBySource.get(entryRef(e, track.name))?.scale ?? 1;
    return Math.round((e.source_offset - e.slip) * scale);
  };
  // Receives are not placements (nested-tracks.md §19): their signal
  // arrives through `cables`, at derived arrivals, rather than through
  // the entry itself.
  const placeable = track.inputs.filter((e) => e.receive === undefined);
  const cableRefFor = (c: CableIn): string => convertBySource.get(c.ref)?.ref ?? c.ref;
  // One list in the file (nested-tracks.md §18), one source list here.
  // A placed track is never in sha256BySource — its bytes do not exist
  // until it renders — so it sorts with the buildable sounds, by name,
  // for the same reason they do. A converted source is buildable however
  // committed its origin: the stem's input is the conversion's output,
  // whose bytes do not exist until it runs.
  const refs = [...new Set([...placeable.flatMap(refsOf), ...cables.map(cableRefFor)])];
  const committed = refs
    .filter((r) => sha256BySource.has(r))
    .sort((a, b) => {
      const ha = sha256BySource.get(a)!;
      const hb = sha256BySource.get(b)!;
      return ha < hb ? -1 : ha > hb ? 1 : a < b ? -1 : 1;
    });
  // By the name under the spelling, not the raw string: a sound folding
  // into a track (nested-tracks.md §1.12) keeps its slot among buildable
  // siblings, so the fold cannot permute clip indices or the dep-hash
  // order and re-key a parent whose children are byte-identical. The raw
  // ref breaks the rare tie — a sound and a track legally sharing a name
  // — where the two really are different sources and the order only has
  // to be deterministic.
  const buildableName = (r: string): string =>
    trackRefName(r) ?? genRefName(r) ?? convertRefName(r) ?? tapRefName(r) ?? r;
  const buildable = refs
    .filter((r) => !sha256BySource.has(r))
    .sort((a, b) => {
      const na = buildableName(a);
      const nb = buildableName(b);
      return na < nb ? -1 : na > nb ? 1 : a < b ? -1 : 1;
    });
  const sources = [...committed, ...buildable];
  const inputIndex = new Map(sources.map((ref, i): [string, number] => [ref, i]));
  const placed = placeable.flatMap((entry): PlacedClip[] => {
    const input = inputIndex.get(refFor(entry))!;
    const loop = entry.loop?.enabled ? entry.loop : undefined;
    if (loop) {
      const frames = framesBySource.get(refFor(entry));
      return expandLoop(entry, loop, tempoMap, frames, readOffsetFor(entry)).map((rep, k) => ({
        input: inputIndex.get(repetitionRef(entry, k))!,
        ...rep,
      }));
    }
    const { start, duration } = placedWindow(entry, tempoMap);
    return [
      {
        input,
        start,
        ...(duration !== undefined ? { duration } : {}),
        read_offset: readOffsetFor(entry),
        gain_db: entry.gain_db,
        ...(entry.pan !== 0 ? { pan: entry.pan } : {}),
        fade_in: entry.fade_in,
        fade_out: entry.fade_out,
      },
    ];
  });
  // Each arrival plays the sender's whole render at the cable's level —
  // no window, so a reverb tail rings as long as it rendered. A negative
  // arrival (the sender's zero preceding the receiver's) folds into the
  // read offset: content before the receiver's sample 0 has nowhere to
  // sound, and the rest starts partway through the source. A counted
  // arrival — N identical placements landing together — is one clip at
  // +20·log₁₀(N) dB, which sums to exactly what N copies would.
  for (const cable of cables) {
    const input = inputIndex.get(cableRefFor(cable))!;
    for (const arrival of cable.arrivals) {
      placed.push({
        input,
        start: Math.max(0, arrival.at),
        read_offset: arrival.at < 0 ? -arrival.at : 0,
        gain_db: cable.gainDb + (arrival.count > 1 ? 20 * Math.log10(arrival.count) : 0),
        fade_in: 0,
        fade_out: 0,
      });
    }
  }
  // Canonical order: summing is commutative, so the action key must not
  // depend on YAML entry order. An absent duration sorts as -1: no real
  // window is shorter, and the comparator's job is to be total and
  // stable, not meaningful.
  placed.sort(
    (a, b) =>
      a.start - b.start ||
      a.input - b.input ||
      a.read_offset - b.read_offset ||
      (a.duration ?? -1) - (b.duration ?? -1) ||
      a.gain_db - b.gain_db ||
      (a.pan ?? 0) - (b.pan ?? 0) ||
      a.fade_in - b.fade_in ||
      a.fade_out - b.fade_out,
  );
  const specInserts: SpecInsert[] = track.inserts.map((insert) => {
    if (!isHostedInsert(insert)) return insert;
    if (hosted === undefined) {
      throw new Error(
        `track "${track.name}" holds a hosted insert but the graph supplied no ` +
          `transport context — a caller skipped the hosted path`,
      );
    }
    return toPluginSpec(insert, track.name, hosted);
  });
  return {
    name: track.name,
    type: 'stem',
    sources,
    clips: placed,
    ...(specInserts.length > 0 ? { inserts: specInserts } : {}),
    ...(extent.lengthSamples !== undefined ? { length_samples: extent.lengthSamples } : {}),
    // `loop` only travels with a length to fold onto — the daemon refuses
    // the pair otherwise, and planMix has always paired them this way.
    ...(extent.loop === true && extent.lengthSamples !== undefined ? { loop: true } : {}),
  };
}

export const stemGenerator: Generator<StemSpec> = {
  version: 1,
  wiringFields: ['sources'],

  sources(spec) {
    // Clip sources: a clip on a buildable sound pulls its whole
    // definition into the stem's subgraph (mix-assembly.md §5).
    return spec.sources;
  },

  validate() {
    // Synthesized specs are never declared in YAML; clip references and
    // fade fit are validated on the track file itself (model/project.ts).
  },

  async execute(spec, inputPaths, outputPath, ctx) {
    // Rates and channel counts are checked here, from headers alone, and
    // the daemon does the summing (render-pipeline.md chunk 3). The split
    // is deliberate: these two messages are user-facing diagnostics, and
    // diagnostics belong in the control plane with all the others rather
    // than duplicated into C++ where they would drift.
    const frames = spec.sources.map((name, i) => {
      const header = readWavHeader(inputPaths[i]!);
      if (header.sampleRate !== ctx.sampleRate) {
        // The graph converts mismatched sources at the edge (multi-rate.md
        // decision 4), so reaching this means it could not see the rate
        // this file actually has — a header the planner failed to read, or
        // a file that changed under it.
        throw new Error(
          `input "${name}" is ${header.sampleRate} Hz but "${spec.name}" renders at ` +
            `${ctx.sampleRate} Hz — the edge converts automatically when the source's rate ` +
            `is readable at plan time, so this one was not; field check`,
        );
      }
      if (header.channels > 2) {
        throw new Error(`input "${name}" has ${header.channels} channels; mono or stereo only`);
      }
      return header.frames;
    });

    // Where a plan-time length was unknowable, the rendered input answers
    // it: the build walks dependencies first, so a placed track's stem is
    // already on disk here. This is the only place the two lengths can be
    // reconciled — earlier the child does not exist, later the daemon has
    // no notion of "as long as the input is".
    const clips = spec.clips.map((clip): RenderedClip => ({
      ...clip,
      duration: clip.duration ?? Math.max(0, frames[clip.input]! - clip.read_offset),
    }));

    // Hosted arms gain their machine-local half here — display name and
    // path hint from the inventory, the blob's absolute path from the
    // pool — after the action key was computed from the spec alone.
    const wireInserts = spec.inserts?.map((insert) =>
      insert.effect === 'plugin' ? toPluginWire(insert, ctx.root) : insert,
    );

    await renderInsertChain(
      {
        op: 'stem',
        output: outputPath,
        sample_rate: ctx.sampleRate,
        inputs: inputPaths,
        clips,
        ...(wireInserts !== undefined ? { inserts: wireInserts } : {}),
        ...(spec.length_samples !== undefined ? { length_samples: spec.length_samples } : {}),
        ...(spec.loop !== undefined ? { loop: spec.loop } : {}),
      },
      { ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}) },
    );
  }
};
