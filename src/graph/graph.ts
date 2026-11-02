import { join } from 'node:path';
import { readWavHeader, wavFrameCount } from '../audio/wav.js';
import {
  convertRef,
  convertRefName,
  formatLabel,
  genRef,
  genRefName,
  matchesPattern,
  sharedAssetName,
  SHARED_ASSETS_PKG,
  SONG_OUTPUT_NAME,
  tapRef,
  tapRefName,
  trackRef,
  trackRefName,
  type Label,
  type LabelPattern,
} from '../labels.js';
import { chosenTake, committedFileResolver, type LoadedProject, type LoadedSong } from '../model/project.js';
import type { Cable } from '../model/cables.js';
import { generatorFor, type GeneratorSpec } from '../generators/index.js';
import type { ResampleSpec } from '../generators/resample.js';
import { entryRef, generatorName, partRenders, placedWindow, planTrack } from '../generators/stem.js';
import {
  indexStateBlobs,
  transportSegments,
  type HostedTrackContext,
  type StateBlob,
} from '../audio/plugins.js';
import { resolveNotes, takeAnchor } from '../time/notes.js';
import { MeterMap, TempoMap } from '../time/tempo.js';
import type { VoiceRenderSpec } from '../generators/voice-render.js';
import type { Asset, InputEntry, Track } from '../schema/index.js';
import { isHostedInsert, isMidiTakeRow } from '../schema/index.js';
import { DEFAULT_SAMPLE_RATE } from '../constants.js';

// The dependency graph, derived from the project model by convention
// (project-core.md §3.4). Node kinds: source assets (song and shared
// ledgers), generator entries' renders (gen:), chosen takes
// (generation), resample edges (convert:), pre-insert taps (tap:,
// nested-tracks.md §19 decision 6), and implicit track stems — every
// track is buildable as //songs/<song>/track:<name>
// (mix-assembly.md §3). "Node" and "rule" are deliberately the engine's
// words (project-layout.md §4): the format speaks tracks and entries,
// and this module realizes them.

export interface AssetNode {
  kind: 'asset';
  label: Label;
  // Project-relative scope root the asset's file resolves against:
  // songs/<song>, or shared (project-layout.md §1.6).
  scopeDir: string;
  asset: Asset;
}

export interface GeneratorNode {
  kind: 'rule';
  label: Label;
  songDir: string;
  // A spec synthesized from the model (stem, resample, supercollider).
  spec: GeneratorSpec;
  deps: Label[];
  // The rate this node renders at (multi-rate.md decision 3): the owning
  // track's effective rate for stems and entry generators, the target
  // rate for a resample edge. It reaches the action key and the run
  // context, which is what makes a `rate:` edit re-render exactly the
  // tracks it moved.
  sampleRate: number;
}

// A deliberate request's committed audio (project-layout.md §1.4):
// content-addressed like an asset. The gen node's label
// (//songs/<song>/gen:<name>) resolves to its *chosen* variant — that
// node is what clips and rules consume — while every variant is
// additionally auditionable as :<name>-<n>. `field choose` repoints
// which variant the label means; nothing is ever re-run.
export interface GenerationNode {
  kind: 'generation';
  label: Label;
  songDir: string;
  file: string; // song-dir-relative (audio/<name>/<n>.wav)
  sha256: string;
  // Present on the node the request's own label resolves to — which take
  // `field choose` picked, of how many exist — and absent on the
  // per-variant audition nodes, which are one take each rather than the
  // choosing. `explain` is the reader: "which variant are we using" must
  // have a better answer than raw YAML or a filename's digit (#115).
  choice?: { chosen: number; takes: number };
}

export type GraphNode = AssetNode | GeneratorNode | GenerationNode;

// A track's own maps, at its rate.
export interface TrackTime {
  tempo: TempoMap;
  meter: MeterMap;
}

export interface Graph {
  nodes: Map<string, GraphNode>; // keyed by formatted label
  // Generative requests whose entry exists but whose takes do not
  // (bloom-in-tree.md §3). They mint no node: there is nothing to build,
  // because nothing may run them mechanically, and nothing committed to
  // point at either. So resolution fails — correctly — and this is what
  // makes it fail saying which command fills them rather than claiming
  // the label does not exist, which is the one thing that is not true.
  ungenerated: Map<string, UngeneratedSound>; // keyed by formatted label
}

// A recipe waiting to be filled. Carries its label as well as its key so
// patterns can be matched against it, not only exact labels — the two
// spellings fail in different functions and both have to say this.
export interface UngeneratedSound {
  label: Label;
  song: string;
  name: string;
}

// The fill instruction is shaped to be copied: a blank line, a
// #-comment (itself paste-safe in a shell) carrying the seed note, and
// the bare command — --seed stays out of it, because omitted, generate
// draws a seed and records it per take, so the line is complete as
// written. The exact shape is Justin's spec, verbatim.
function fillCommand(pending: UngeneratedSound): string {
  return `field generate ${pending.song}/${pending.name}`;
}
function fillInstructions(pending: UngeneratedSound[]): string {
  const plural = pending.length === 1 ? 'this command' : 'these commands';
  return (
    `\n\n# Use ${plural} to generate. Specify a seed with --seed <n>\n` +
    pending.map(fillCommand).join('\n')
  );
}

// Requires a project with no diagnostics: the graph trusts what validate
// accepted (unique names, known references, valid tempo maps).
export function buildGraph(project: LoadedProject): Graph {
  const projectRate = project.manifest?.data.sample_rate ?? DEFAULT_SAMPLE_RATE;
  // The blob pool listing, made at most once per build and only when a
  // chain actually holds a hosted insert.
  let stateBlobCache: StateBlob[] | undefined;
  const nodes = new Map<string, GraphNode>();
  const ungenerated = new Map<string, UngeneratedSound>();
  const addRule = (
    label: Label,
    songDir: string,
    spec: GeneratorSpec,
    refLabel: (ref: string) => Label,
    sampleRate: number,
  ) => {
    // Each rule declares its ordered sources; the classifier maps each
    // ref — a name in the song's one namespace or a //shared/asset:
    // label — onto the node it means. Other inputs (like sc programs)
    // participate by content hash without being nodes.
    const impl = generatorFor(spec);
    const deps: Label[] = impl.sources(spec).map(refLabel);
    nodes.set(formatLabel(label), { kind: 'rule', label, songDir, spec, deps, sampleRate });
  };

  const sharedByName = new Map<string, Asset>();
  if (project.shared) {
    for (const asset of project.shared.data.assets) {
      const label: Label = { pkg: SHARED_ASSETS_PKG, name: asset.name };
      nodes.set(formatLabel(label), { kind: 'asset', label, scopeDir: 'shared', asset });
      sharedByName.set(asset.name, asset);
    }
  }

  for (const song of project.songs) {
    const pkgBase = song.dir;
    // The song's rate (multi-rate.md decision 3, amended 2026-08-10):
    // what its output renders at and what every track without a `rate:`
    // inherits.
    const songRate = song.song?.data.rate ?? projectRate;
    // Keyed by ref string — bare names in the song's namespace, full
    // //shared/asset: labels for shared pins — matching what entries
    // carry. Chosen generate variants are committed content, so they
    // join the map; a ref absent here is something that renders.
    const sha256BySource = new Map<string, string>();
    const assetByName = new Map<string, Asset>();
    for (const [name, asset] of sharedByName) {
      sha256BySource.set(`//${SHARED_ASSETS_PKG}:${name}`, asset.sha256);
    }
    if (song.assets) {
      for (const asset of song.assets.data.assets) {
        const label: Label = { pkg: `${pkgBase}/asset`, name: asset.name };
        nodes.set(formatLabel(label), { kind: 'asset', label, scopeDir: song.dir, asset });
        sha256BySource.set(asset.name, asset.sha256);
        assetByName.set(asset.name, asset);
      }
    }
    // Where a committed source's bytes live, for loop tiling and for
    // materializing generation inputs — the same resolver validate uses,
    // so the tiling validated there cannot be planned differently here.
    const fileBySource = committedFileResolver(project, song);
    const refLabel = (ref: string): Label => {
      const shared = sharedAssetName(ref);
      if (shared !== undefined) return { pkg: SHARED_ASSETS_PKG, name: shared };
      // A placed track (nested-tracks.md §1.3) — a ref that is not a
      // name in the song's namespace, hence one that carries its
      // package with it. A generator entry's node is the same shape.
      const placed = trackRefName(ref);
      if (placed !== undefined) return { pkg: `${pkgBase}/track`, name: placed };
      const gen = genRefName(ref);
      if (gen !== undefined) return { pkg: `${pkgBase}/gen`, name: gen };
      const conv = convertRefName(ref);
      if (conv !== undefined) return { pkg: `${pkgBase}/convert`, name: conv };
      const tap = tapRefName(ref);
      if (tap !== undefined) return { pkg: `${pkgBase}/tap`, name: tap };
      // A bare ref is committed bytes (§18: the kind lives in the field
      // name, and `audio:` is the bare-slug kind) — validate has already
      // diagnosed one the ledger does not hold.
      return { pkg: `${pkgBase}/asset`, name: ref };
    };
    // Generator entries mint their own nodes (nested-tracks.md §18
    // step 2, option A — uniformly, whether the entry is a leaf's sole
    // content or windowed among siblings): //songs/<song>/gen:<name>,
    // named by the owning track, or <track>-<id> when the entry carries
    // an id. A supercollider entry becomes a rule: the spec is the
    // supercollider sound schema's shape with the entry's fields, so a
    // sound folded into a track keeps its action key verbatim — name and
    // type never reach a key (build.ts ruleParameters), and the
    // parameters are identical by construction. A generative entry is
    // deliberate and contributes committed-content nodes exactly as a
    // generative sound does, in the gen: package: its label resolves to
    // the chosen take, every take is auditionable by number, and a
    // request with no takes joins `ungenerated` so resolution fails
    // naming the command that fills it.
    // A track's effective rate (multi-rate.md decision 3): its own, or
    // the song's — never the placing parent's, because a track renders
    // once.
    const trackRate = (track: { rate?: number | undefined }): number =>
      track.rate ?? songRate;
    // Entry generators render at their owner's rate — the render is the
    // track's own content, so producing it at the project rate only to
    // convert it back at the edge would be a conversion nobody asked for.
    const scEntryRate = new Map<string, number>();
    const repetitionRefs = new Map<string, string[]>();
    // A track's own maps at its rate (nested-tracks.md §13), which its
    // notes resolve through. Validate refused a song without `time:`.
    const timeOf = (track: Track): TrackTime => ({
      tempo: new TempoMap(track.time?.tempo ?? song.time!.tempo, trackRate(track)),
      meter: new MeterMap(track.time?.meter ?? song.time!.meter),
    });
    // Notes render through the track's instrument at the track's rate
    // (sequencer.md §2.3), keyed on the events they resolve to.
    const addVoiceRender = (
      name: string,
      track: Track,
      notes: Pick<VoiceRenderSpec, 'take' | 'part' | 'events'>,
    ): void => {
      scEntryRate.set(name, trackRate(track));
      addRule(
        { pkg: `${pkgBase}/gen`, name },
        song.dir,
        { name, type: 'voice-render', instrument: track.instrument!, ...notes },
        refLabel,
        trackRate(track),
      );
    };
    for (const file of song.tracks) {
      for (const entry of file.data.inputs) {
        if (entry.supercollider !== undefined) {
          const name = generatorName(entry, file.data.name);
          scEntryRate.set(name, trackRate(file.data));
          addRule(
            { pkg: `${pkgBase}/gen`, name },
            song.dir,
            { name, type: 'supercollider', ...entry.supercollider },
            refLabel,
            trackRate(file.data),
          );
        } else if (entry.generative !== undefined) {
          const name = generatorName(entry, file.data.name);
          const takes = song.genTakes.get(name)?.data;
          const variants = takes?.variants ?? [];
          if (variants.length === 0) {
            const label: Label = { pkg: `${pkgBase}/gen`, name };
            ungenerated.set(formatLabel(label), { label, song: song.name, name });
          }
          variants.forEach((variant, i) => {
            const label: Label = { pkg: `${pkgBase}/gen`, name: `${name}-${i + 1}` };
            nodes.set(formatLabel(label), {
              kind: 'generation',
              label,
              songDir: song.dir,
              file: variant.file,
              sha256: variant.sha256,
            });
          });
          if (takes?.chosen !== undefined) {
            const variant = variants[takes.chosen - 1]!;
            const label: Label = { pkg: `${pkgBase}/gen`, name };
            nodes.set(formatLabel(label), {
              kind: 'generation',
              label,
              songDir: song.dir,
              file: variant.file,
              sha256: variant.sha256,
              choice: { chosen: takes.chosen, takes: variants.length },
            });
            sha256BySource.set(genRef(name), variant.sha256);
          }
        } else if (entry.notes !== undefined) {
          // A part, from where the entry places it and from where each
          // repetition of its loop starts; planTrack places each
          // repetition's render in its slot of the entry's window.
          const part = song.parts.get(entry.notes)!;
          const name = generatorName(entry, file.data.name);
          const { renders, repetitions } = partRenders(part.data, entry, name, timeOf(file.data));
          for (const render of renders) {
            addVoiceRender(render.name, file.data, { part: part.path, events: render.events });
          }
          repetitionRefs.set(genRef(name), repetitions.map(genRef));
        } else if (entry.record !== undefined && file.data.instrument !== undefined) {
          // A chosen MIDI take, from where it starts after its entry when
          // it is in ticks (sequencer.md §2.4); withTakes places the
          // render there, or, for a take in samples, where it was played.
          const name = generatorName(entry, file.data.name);
          const take = chosenTake(song.recordTakes.get(name)?.data);
          const notes = take !== undefined ? song.takeNotes.get(take.asset) : undefined;
          if (take !== undefined && isMidiTakeRow(take) && notes !== undefined) {
            const time = timeOf(file.data);
            const anchor = notes.data.sample_rate === undefined ? takeAnchor(entry, take, time.tempo) : 0;
            addVoiceRender(name, file.data, { take: take.asset, events: resolveNotes(notes.data, anchor, time) });
          }
        }
      }
    }
    // What rate a source arrives at, so a placement can convert at the
    // edge when it differs from the consuming track's (multi-rate.md
    // decision 4). Committed content answers from the ledger's recorded
    // fact where the import wrote one, else from its own header — the
    // same 44-byte seek-read the loop planner already pays; a placed
    // track answers from the model; an entry generator from its owner;
    // an effect sound with its source's rate, because effects process at
    // the file's own rate. Undefined means unknowable here (an
    // ungenerated recipe, an unreadable file): no conversion is minted,
    // and the stem rule's own header check is the backstop.
    const headerRate = (base: string, file: string): number | undefined => {
      try {
        return readWavHeader(join(project.root, base, file)).sampleRate;
      } catch {
        return undefined;
      }
    };
    const committedRate = (ref: string): number | undefined => {
      const committed = fileBySource(ref);
      return committed === undefined ? undefined : headerRate(committed.base, committed.file);
    };
    const trackByName = new Map(song.tracks.map((f) => [f.data.name, f.data]));
    const rateMemo = new Map<string, number | undefined>();
    const sourceRate = (ref: string): number | undefined => {
      if (rateMemo.has(ref)) return rateMemo.get(ref);
      let rate: number | undefined;
      const shared = sharedAssetName(ref);
      // A tap is the sender's stem before its inserts, so it arrives at
      // the sender's rate exactly as the stem itself does.
      const placed = trackRefName(ref) ?? tapRefName(ref);
      const gen = genRefName(ref);
      const asset = assetByName.get(ref);
      if (shared !== undefined) {
        const pinned = sharedByName.get(shared);
        if (pinned !== undefined) rate = pinned.sample_rate ?? headerRate('shared', pinned.file);
      } else if (placed !== undefined) {
        const child = trackByName.get(placed);
        if (child !== undefined) rate = trackRate(child);
      } else if (gen !== undefined) {
        rate = scEntryRate.get(gen) ?? committedRate(ref);
      } else if (asset !== undefined) {
        rate = asset.sample_rate ?? headerRate(song.dir, asset.file);
      }
      rateMemo.set(ref, rate);
      return rate;
    };
    const renderable = song.tracks.map((t) => t.data);
    if (song.time) {
      // Captured once: the narrowing does not survive into planFor.
      const songTempoEvents = song.time.tempo;
      const songMeterEvents = song.time.meter;
      const tempoMap = new TempoMap(songTempoEvents, songRate);
      // Loops without `every` tile at the source's length, so the plan
      // needs frame counts — but only for the sources such loops touch.
      const framesBySource = new Map<string, number>();
      for (const track of renderable) {
        for (const entry of track.inputs) {
          if (entry.loop?.enabled && entry.loop.every === undefined) {
            const ref = entryRef(entry, track.name);
            const committed = fileBySource(ref);
            if (committed !== undefined && !framesBySource.has(ref)) {
              framesBySource.set(
                ref,
                wavFrameCount(join(project.root, committed.base, committed.file)),
              );
            }
          }
        }
      }
      // A declared song length projects to samples here, where the tempo
      // map lives; whatever renders the song renders exactly that long.
      const lengthSamples =
        song.song?.data.length !== undefined
          ? tempoMap.ticksToSamples(song.song.data.length)
          : undefined;
      // The song's output track carries the song's extent. Which track
      // that is, is the same
      // convention a bare song name resolves through, read from the same
      // constant rather than spelled twice (nested-tracks.md §1.2). One
      // function because two node kinds need it: the stem, and a pre
      // tap of the output track — the extent is content, not an insert,
      // so the tap keeps it (Codex on #126).
      const extentFor = (track: Track): { lengthSamples?: number | undefined; loop?: boolean | undefined } =>
        track.name === SONG_OUTPUT_NAME
          ? { lengthSamples, loop: song.song?.data.loop }
          : {};
      const cablesByReceiver = new Map<string, Cable[]>();
      for (const cable of song.cables) {
        cablesByReceiver.set(cable.receiver, [
          ...(cablesByReceiver.get(cable.receiver) ?? []),
          cable,
        ]);
      }
      // One planner for stems and pre-insert taps: a `tap: pre` cable
      // consumes the sender's stem minus its inserts (nested-tracks.md
      // §19 decision 6), and everything else about planning the sender —
      // edge conversions, its own arriving cables, its local time — has
      // to mean exactly what it means in the stem, or the tap would be a
      // second copy of the law.
      const planFor = (
        track: Track,
        withInserts: boolean,
        extent: { lengthSamples?: number | undefined; loop?: boolean | undefined },
      ) => {
        // Muted placements leave the plan here, before anything walks
        // inputs — so the stem spec, its action key, the dep edges, and
        // the live session (which reads these same specs) all agree the
        // placement is absent, and a mute toggle re-keys the stem the
        // way any spec edit does. One cut because planFor is where every
        // consumer's view of the track is minted.
        track = { ...track, inputs: track.inputs.filter((e) => !e.mute) };
        const rate = trackRate(track);
        // A track plans in its own time (nested-tracks.md §13). The two
        // timelines never have to be reconciled as maps: this stem's
        // positions resolve to samples here, its parent's `at` resolves to
        // samples under the parent's map, and the daemon sums by sample
        // offset — so a 7/8 child inside a 4/4 parent is an addition, not
        // a conversion. Across a rate boundary the addition holds, each
        // side computed in its own rate (§13 as amended by multi-rate).
        //
        // The song's map when the track declares none — at the track's
        // rate, because ticks project to samples differently at 96 kHz
        // than at 48; a track at the song rate keeps the song's own
        // map, so nothing that exists now changes key.
        const local = track.time?.tempo
          ? new TempoMap(track.time.tempo, rate)
          : rate === songRate
            ? tempoMap
            : new TempoMap(songTempoEvents, rate);
        // Record entries become windows over their chosen take before
        // anything reads the inputs (recording.md §3): the take pins in
        // the ledger, so downstream it is an `audio:` placement like any
        // other, at the position it was sung. An entry with no chosen
        // take contributes nothing — silence (§4).
        const planned = withTakes(track, song, local, rate, sourceRate);
        // Rates convert at the placement (multi-rate.md decision 4): a
        // source arriving at another rate gets a resample node between it
        // and this stem, named for the source and the rate it becomes —
        // track: and gen: refs keep their kind in the name, so a track
        // and a sound legally sharing a name cannot mint one node for two
        // sources. One node per (source, rate) however many placements
        // consume it; the action cache extends that across songs. The
        // guard is for a name crafted to collide anyway (a sound
        // literally named "track-foo"), which validate does not chase.
        const convertBySource = new Map<string, { ref: string; scale: number }>();
        const ensureConvert = (raw: string): void => {
          if (convertBySource.has(raw)) return;
          const src = sourceRate(raw);
          if (src === undefined || src === rate) return;
          const shared = sharedAssetName(raw);
          const base = shared !== undefined ? `shared-${shared}` : raw.replace(':', '-');
          const name = `${base}-${rate}`;
          const label: Label = { pkg: `${pkgBase}/convert`, name };
          const existing = nodes.get(formatLabel(label));
          if (existing !== undefined) {
            if (existing.kind !== 'rule' || (existing.spec as ResampleSpec).source !== raw) {
              throw new Error(
                `convert node ${formatLabel(label)} is claimed by two different sources — rename one`,
              );
            }
          } else {
            addRule(label, song.dir, { name, type: 'resample', source: raw, sample_rate: rate }, refLabel, rate);
          }
          // The scale rides along so the plan can keep `source_offset`
          // meaning what it says: samples *of the source*, which the
          // converted file stores rate/src as many of.
          convertBySource.set(raw, { ref: convertRef(name), scale: rate / src });
        };
        for (const entry of planned.inputs) {
          if (entry.receive !== undefined) continue; // a cable is not a source here
          const raw = entryRef(entry, planned.name);
          for (const ref of repetitionRefs.get(raw) ?? [raw]) ensureConvert(ref);
        }
        // The cables arriving here become plan inputs: the sender's stem
        // for a post tap, the tap node for pre — converted at the edge
        // like any source when the sender renders at another rate.
        // A cable with no arrivals — every sender placement muted — is
        // silent, so it is no input at all, and the receiver stops
        // depending on the sender.
        const cableIns = (cablesByReceiver.get(track.name) ?? []).filter((cable) => cable.arrivals.length > 0).map((cable) => {
          const raw = cable.tap === 'pre' ? tapRef(cable.sender) : trackRef(cable.sender);
          ensureConvert(raw);
          return { ref: raw, gainDb: cable.gainDb, arrivals: cable.arrivals };
        });
        // Hosted inserts carry the track's resolved transport into their
        // keyed spec (plugin-hosting.md decision 13) and resolve state
        // refs against the blob pool. Computed only when a chain
        // actually holds one, so no existing spec gains a field.
        const hosted: HostedTrackContext | undefined =
          withInserts && track.inserts.some(isHostedInsert)
            ? {
                transport: transportSegments(
                  track.time?.tempo ?? songTempoEvents,
                  track.time?.meter ?? songMeterEvents,
                  local,
                ),
                stateBlobs: (stateBlobCache ??= indexStateBlobs(project.root)),
              }
            : undefined;
        return planTrack(
          withInserts ? planned : { ...planned, inserts: [] },
          local,
          sha256BySource,
          framesBySource,
          extent,
          convertBySource,
          cableIns,
          hosted,
          repetitionRefs,
        );
      };
      for (const track of renderable) {
        // Every track gets a node, an empty one rendering as the silence
        // it contains — which is what lets a song answer to its own name
        // from the moment `field song create` writes its output track.
        addRule(
          { pkg: `${pkgBase}/track`, name: track.name },
          song.dir,
          planFor(track, true, extentFor(track)),
          refLabel,
          trackRate(track),
        );
      }
      // Pre-insert taps, one per sender some cable taps pre — shared by
      // every such cable, and absent entirely when nothing taps pre, so
      // no existing graph grows a node. The extent rides along: it is
      // content, so a pre tap of the output track truncates and folds
      // exactly as the stem does, differing only by the inserts.
      const preSenders = new Set(
        song.cables.filter((c) => c.tap === 'pre').map((c) => c.sender),
      );
      for (const name of preSenders) {
        const track = trackByName.get(name)!;
        addRule(
          { pkg: `${pkgBase}/tap`, name },
          song.dir,
          planFor(track, false, extentFor(track)),
          refLabel,
          trackRate(track),
        );
      }
    }
  }
  return { nodes, ungenerated };
}

// A track with each `record:` entry replaced by the window its chosen
// take fills (recording.md §3–§4), or dropped when nothing is chosen.
// The take's row places it on this track's timeline: its first sample
// sits at `started_at_samples`, the capture ran `latency` samples
// behind, so the sound goes at their difference — added to the entry's
// own window start, which is where the take's timeline zero was. A take
// that started before the window (a negative placement) reads into its
// source by that much instead, in the source's own samples, because
// `source_offset` addresses the source (project-core.md §3.2) and the
// edge conversion scales it. A MIDI take in ticks (sequencer.md §2.4)
// sounds `started_at_ticks` after the tick the entry's window starts
// on instead, where its render begins: its notes already have the
// latency off, and its sample row is a record. The result is an absolute `audio:` entry, so nothing after
// this point knows recording exists.
export function withTakes(
  track: Track,
  song: LoadedSong,
  local: TempoMap,
  trackRate: number,
  sourceRate: (ref: string) => number | undefined,
): Track {
  if (!track.inputs.some((e) => e.record !== undefined)) return track;
  const inputs = track.inputs.flatMap((entry): InputEntry[] => {
    if (entry.record === undefined) return [entry];
    const name = generatorName(entry, track.name);
    const take = chosenTake(song.recordTakes.get(name)?.data);
    if (take === undefined) return [];
    const window = placedWindow(entry, local);
    const notes = song.takeNotes.get(take.asset);
    const at =
      isMidiTakeRow(take) && notes !== undefined && notes.data.sample_rate === undefined
        ? local.ticksToSamples(takeAnchor(entry, take, local))
        : window.start + take.started_at_samples - take.latency;
    // A MIDI take sounds through its render, the gen node the graph minted
    // for the entry (keyboard-instrument.md §12.3); an audio take is its
    // own bytes.
    const source = isMidiTakeRow(take) ? genRef(name) : take.asset;
    const takeRate = sourceRate(source) ?? trackRate;
    const readInto = at < 0 ? Math.round((-at * takeRate) / trackRate) : 0;
    const { record: _record, ...placement } = entry;
    return [
      {
        ...placement,
        audio: source,
        anchor: 'absolute',
        at: Math.max(0, at),
        ...(window.duration !== undefined ? { duration: window.duration } : { duration: undefined }),
        source_offset: entry.source_offset + readInto,
      },
    ];
  });
  return { ...track, inputs };
}

// The canonical spelling of a pattern, for error messages: with
// songs-relative shorthand, what the user typed is not always what was
// looked up.
function formatPattern(pattern: LabelPattern): string {
  if (pattern.kind === 'label') return formatLabel(pattern.label);
  if (pattern.kind === 'package-all') return `//${pattern.pkg}:all`;
  return pattern.pkg === '' ? '//...' : `//${pattern.pkg}/...`;
}

// Packages are singular so they read like what they address ("the keys
// track"), and the plural is what fingers type. A bare "no such label"
// is a bad way to learn that, so a pattern that would have matched
// under the plural says so.
//
// The suggestion keeps the shape it was given: a tree pattern is
// answered with a tree pattern, `:all` with `:all`, a label with that
// same label. Correcting the package but not the shape would hand back
// something that also does not work (#41 review).
// `targets` is the exception that is not a plural at all: it is the
// package that became `sounds` in the layout migration (#31), one PR
// before packages went singular. It had no hint of any kind, so the
// spelling every doc and finger from that era produces was a flat dead
// end — worse than the plural it sits beside here.
// `why` carries its own punctuation: the two lead-ins do not share a
// shape, and gluing a colon on in the template gave `targets:` two.
const PACKAGE_HINTS: Record<string, { to: string; why: string }> = {
  tracks: { to: 'track', why: 'packages are singular:' },
  assets: { to: 'asset', why: 'packages are singular:' },
};

function singularHint(graph: Graph, pattern: LabelPattern): string {
  const pkg = pattern.kind === 'label' ? pattern.label.pkg : pattern.pkg;
  let why = '';
  const singular = pkg.replace(/[^/]+$/, (last) => {
    const hint = PACKAGE_HINTS[last];
    if (hint === undefined) return last;
    why = hint.why;
    return hint.to;
  });
  if (singular === pkg) return '';
  // Only when that package really exists here: no guessing at a package
  // this project does not have.
  if (![...graph.nodes.values()].some((n) => n.label.pkg === singular)) return '';
  const corrected: LabelPattern =
    pattern.kind === 'label'
      ? { kind: 'label', label: { ...pattern.label, pkg: singular } }
      : { ...pattern, pkg: singular };
  return ` (${why} try ${formatPattern(corrected)})`;
}

export function resolveLabel(graph: Graph, label: Label): GraphNode {
  const formatted = formatLabel(label);
  const node = graph.nodes.get(formatted);
  if (!node) {
    // The recipe is right there on disk, so "no such label" would be
    // false in the way that costs the most time: it sends you looking for
    // a typo in a name that is spelled correctly. Reached both by asking
    // for the sound directly and by building anything that depends on it,
    // because every resolution comes through here.
    const pending = graph.ungenerated.get(formatted);
    if (pending !== undefined) {
      throw new Error(`${formatted} has no takes yet${fillInstructions([pending])}`);
    }
    const hint = singularHint(graph, { kind: 'label', label });
    throw new Error(`no such label: ${formatted}${hint}`);
  }
  return node;
}

export function expandPattern(graph: Graph, pattern: LabelPattern): GraphNode[] {
  const matched = [...graph.nodes.values()].filter((n) => matchesPattern(n.label, pattern));
  if (matched.length === 0) {
    // Naming a label on the command line comes through here rather than
    // through resolveLabel, so this is the spelling a person actually
    // types and it has to give the same answer: a pattern that matches
    // only takeless sounds matched something real, and "matched no
    // labels" would send them hunting for a typo. All of them, not the
    // first — a pattern is a request for the set.
    const pending = [...graph.ungenerated.values()].filter((u) =>
      matchesPattern(u.label, pattern),
    );
    if (pending.length === 1) {
      throw new Error(
        `${formatLabel(pending[0]!.label)} has no takes yet${fillInstructions([pending[0]!])}`,
      );
    }
    if (pending.length > 1) {
      throw new Error(
        `${formatPattern(pattern)} matched ${pending.length} generative requests with no ` +
          `takes yet${fillInstructions(pending)}`,
      );
    }
    throw new Error(
      `pattern matched no labels: ${formatPattern(pattern)}${singularHint(graph, pattern)}`,
    );
  }
  return matched;
}

// Every takeless request reachable from any of the starts, reported as
// one instruction block. One walk over the whole request, because any
// finer scope re-creates the peel it exists to end: failing on the
// first pending dependency meant generate, wait, be told the next
// (found exercising the folded format), and a per-target aggregate
// alone moved the same loop up to the build queue (Codex on #119).
// Other resolution failures still throw where they stand, because they
// are errors rather than work a walk can enumerate.
export function assertGenerated(graph: Graph, starts: GraphNode[]): void {
  const seen = new Set<string>();
  const pending = new Map<string, UngeneratedSound>();
  const visit = (node: GraphNode) => {
    const key = formatLabel(node.label);
    if (seen.has(key)) return;
    seen.add(key);
    if (node.kind !== 'rule') return;
    for (const dep of node.deps) {
      const formatted = formatLabel(dep);
      const takeless = graph.ungenerated.get(formatted);
      if (takeless !== undefined) {
        pending.set(formatted, takeless);
        continue;
      }
      visit(resolveLabel(graph, dep));
    }
  };
  for (const start of starts) visit(start);
  if (pending.size === 0) return;
  // Sorted on the formatted label, which the map is keyed by and so is
  // unique by construction — a *name* comparator meets two equal keys
  // the moment starts span songs (two songs, each a takeless `bridge`)
  // and never returns 0, collapsing the order back to walk order, the
  // very thing the sort exists to normalize (minjudd on #119).
  const sorted = [...pending.values()].sort((a, b) =>
    formatLabel(a.label) < formatLabel(b.label) ? -1 : 1,
  );
  const fact =
    pending.size === 1
      ? `${formatLabel(sorted[0]!.label)} has no takes yet`
      : `${pending.size} generative requests have no takes yet`;
  throw new Error(`${fact}${fillInstructions(sorted)}`);
}

// Transitive dependencies of a node, dependencies first, node last.
export function deps(graph: Graph, start: GraphNode): GraphNode[] {
  assertGenerated(graph, [start]);
  const out: GraphNode[] = [];
  const seen = new Set<string>();
  const visit = (node: GraphNode) => {
    const key = formatLabel(node.label);
    if (seen.has(key)) return;
    seen.add(key);
    if (node.kind === 'rule') {
      for (const dep of node.deps) visit(resolveLabel(graph, dep));
    }
    out.push(node);
  };
  visit(start);
  return out;
}
