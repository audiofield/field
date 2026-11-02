import type { InputEntry, Track } from '../schema/index.js';
import type { TempoMap } from '../time/tempo.js';
import { expandLoop, placedWindow } from '../generators/stem.js';
import { fmtDb } from './levels.js';
import type { LoadedFile } from './project.js';

// The cable model (nested-tracks.md §19): a label links exactly one
// `sends:` entry to exactly one `- receive:` entry, and everything a
// cable means is derived from where its two ends sit in the containment
// graph. This module owns that derivation — the 1:1 and dangling checks,
// the zero-displacement rule on the receive's path, the combined-graph
// cycle check, and the arrival walk — so `check` and the build graph
// cannot answer "when does this signal arrive" differently.
//
// Arrivals are derived, not invented (§19 decision 5), and "the common
// ancestor" is really every join on the receiver's way up: a return
// carrying its own dry copy of the sender hears it at zero *and* again
// through the mix above (#125 review), so the walk climbs from the
// receiver collecting, at each track, the sender placements in that
// track's subtree — excluding the subtree it just climbed out of, whose
// senders every instance already heard from inside: an instance hears
// itself, not its siblings, which is the placed-ancestor coherence §19
// states. Displacement on an up edge is legal exactly when nothing
// joins above it (the circuit shifts as one, decision 4's rule seen
// from the other side), and where the receiver has several parents
// their views must agree, because arrivals bake into a render that
// exists once however often the track is placed (§13). Both walks are
// memoized per track, so the cost is the graph's size, not the number
// of paths through it.

// One landing of the sender's signal on the receiver's timeline, in
// receiver-rate samples. `count` is how many identical placements land
// there together: two placements of the sender at one position sum to
// twice the amplitude, which one clip at +20·log₁₀(count) dB renders
// exactly — and holding the count instead of repeating the arrival is
// what keeps a mix full of shared containments (every level of sharing
// multiplies the soundings) from expanding into millions of rows.
export interface CableArrival {
  at: number;
  count: number;
}

export interface Cable {
  label: string;
  sender: string; // track name
  receiver: string;
  gainDb: number;
  tap: 'pre' | 'post';
  // Ascending by `at`. Distinct offsets are real multiplicity — a
  // sender placed at bars 5 and 13 arrives twice and sums twice.
  arrivals: CableArrival[];
}

// A track's clock, as validate resolved it: its effective rate and its
// tempo map at that rate. `tempo` is undefined where the map failed to
// parse — every walk through such a track is skipped, because its error
// is already reported and deriving against a guessed map would invent
// numbers on top of it.
export interface TrackClock {
  rate: number;
  tempo: TempoMap | undefined;
}

type Push = (file: string, message: string, severity?: 'warning') => void;

interface Edge {
  parent: string;
  child: string;
  entry: InputEntry;
  index: number; // position in the parent's inputs, for diagnostics
  file: string; // the parent's file — where the placement lives
}

// Musical time that never resolved (a broken meter map, a diagnosed
// entry) is still an array here; the types say number because validate
// promises to have resolved everything, and this is the pass that runs
// while that promise is still being kept.
const unresolved = (v: unknown): boolean => Array.isArray(v);

// How an entry is named in a diagnostic — one function, imported by
// validate too, so every message points at the same spelling.
export function entryName(entry: InputEntry, index: number): string {
  if (entry.id !== undefined) return `input "${entry.id}"`;
  const target =
    entry.track ??
    entry.audio ??
    entry.notes ??
    (entry.supercollider
      ? 'supercollider'
      : entry.generative
        ? 'generative'
        : entry.record
          ? 'record'
          : '?');
  return `input ${index + 1} ("${target}")`;
}

export function checkCables(
  tracks: LoadedFile<Track>[],
  clocks: Map<string, TrackClock>,
  push: Push,
): Cable[] {
  interface SendEnd {
    track: string;
    file: string;
    gainDb: number;
    tap: 'pre' | 'post';
  }
  interface ReceiveEnd {
    track: string;
    file: string;
  }
  const sendsByLabel = new Map<string, SendEnd[]>();
  const receivesByLabel = new Map<string, ReceiveEnd[]>();
  const parentEdges = new Map<string, Edge[]>();
  const childEdges = new Map<string, Edge[]>();
  const trackNames = new Set(tracks.map((t) => t.data.name));

  for (const file of tracks) {
    const name = file.data.name;
    for (const [label, send] of Object.entries(file.data.sends)) {
      const list = sendsByLabel.get(label) ?? [];
      list.push({ track: name, file: file.path, gainDb: send.gain_db, tap: send.tap });
      sendsByLabel.set(label, list);
    }
    file.data.inputs.forEach((entry, index) => {
      if (entry.receive !== undefined) {
        const list = receivesByLabel.get(entry.receive) ?? [];
        list.push({ track: name, file: file.path });
        receivesByLabel.set(entry.receive, list);
      } else if (
        entry.track !== undefined &&
        entry.track !== name &&
        trackNames.has(entry.track)
      ) {
        const edge: Edge = { parent: name, child: entry.track, entry, index, file: file.path };
        parentEdges.set(entry.track, [...(parentEdges.get(entry.track) ?? []), edge]);
        childEdges.set(name, [...(childEdges.get(name) ?? []), edge]);
      }
    });
  }

  // One cable: one send, one receive (§19 decision 3). Duplicates error
  // on the later claimant naming the first, the way generator names do;
  // a label with one end warns — wiring incrementally is normal, so half
  // a cable reports without stopping the mix.
  for (const [label, ends] of sendsByLabel) {
    for (const end of ends.slice(1)) {
      push(
        end.file,
        `send "${label}" is also declared in ${ends[0]!.file} — one cable links one send ` +
          `to one receive (nested-tracks.md §19)`,
      );
    }
    if (!receivesByLabel.has(label)) {
      push(
        ends[0]!.file,
        `send "${label}" has no receive — it carries nothing until a track declares ` +
          `\`- receive: ${label}\``,
        'warning',
      );
    }
  }
  for (const [label, ends] of receivesByLabel) {
    for (const end of ends.slice(1)) {
      // Unlike sends — a map whose duplicate keys YAML itself rejects —
      // the receive side can duplicate within one file, and a message
      // pointing the reader at the file they are already in names
      // nothing (#125 review).
      push(
        end.file,
        end.file === ends[0]!.file
          ? `receive "${label}" is declared twice in this file — one cable links one send ` +
              `to one receive (nested-tracks.md §19)`
          : `receive "${label}" is also declared in ${ends[0]!.file} — one cable links one ` +
              `send to one receive (nested-tracks.md §19)`,
      );
    }
    if (!sendsByLabel.has(label)) {
      push(
        ends[0]!.file,
        `receive "${label}" has no send — it carries nothing until a track declares the ` +
          `label under sends:`,
        'warning',
      );
    }
  }

  // Containment descendants, self included, cycle-safe (a containment
  // cycle is validate's own diagnostic; this walk just must not hang on
  // one).
  const descendantsMemo = new Map<string, Set<string>>();
  const descendants = (name: string): Set<string> => {
    const seen = descendantsMemo.get(name);
    if (seen) return seen;
    const out = new Set<string>([name]);
    descendantsMemo.set(name, out); // pre-set so a cycle terminates
    for (const edge of childEdges.get(name) ?? []) {
      for (const d of descendants(edge.child)) out.add(d);
    }
    return out;
  };

  // A placement's displacement of its child's local zero, in the
  // parent's samples — one number per instance, because a looped
  // placement places its child once per repetition. Undefined means the
  // clock is unusable here (a broken map, unresolved musical time): the
  // cable's derivation is skipped, its cause already reported.
  const instanceDisplacements = (edge: Edge): number[] | undefined => {
    const parent = clocks.get(edge.parent);
    const child = clocks.get(edge.child);
    if (parent?.tempo === undefined || child === undefined) return undefined;
    const entry = edge.entry;
    if ([entry.at, entry.duration, entry.loop?.every].some(unresolved)) return undefined;
    // `source_offset` and `slip` address the source's samples; the
    // parent's clip reads the edge-converted file, so the offset scales
    // by the rate ratio exactly as planTrack's readOffsetFor does.
    const scale = parent.rate / child.rate;
    const readOffset = Math.round((entry.source_offset - entry.slip) * scale);
    if (entry.loop?.enabled) {
      if (entry.loop.every === undefined) return undefined; // check demands `every` on track loops
      try {
        return expandLoop(entry, entry.loop, parent.tempo, undefined, readOffset).map(
          (rep) => rep.start - rep.read_offset,
        );
      } catch {
        return undefined; // its own diagnostic already names the entry
      }
    }
    return [placedWindow(entry, parent.tempo).start - readOffset];
  };

  // The fields that displace a placement — §19 decision 4's four
  // spellings of the time base. `duration` and fades window and shape
  // without moving anything, so they stay legal on a receive's path.
  const displacingFields = (entry: InputEntry): string[] => {
    const fields: string[] = [];
    if (entry.at !== 0) fields.push('at');
    if (entry.slip !== 0) fields.push('slip');
    if (entry.source_offset !== 0) fields.push('source_offset');
    if (entry.loop?.enabled) fields.push('loop');
    return fields;
  };

  // Complete cables, before cycle and arrival checks. Labels with a
  // duplicated end stop here: which two ends they join is exactly what
  // the error says nobody decided.
  const complete: { label: string; send: SendEnd; receive: ReceiveEnd }[] = [];
  for (const [label, sends] of sendsByLabel) {
    const receives = receivesByLabel.get(label);
    if (sends.length === 1 && receives?.length === 1) {
      complete.push({ label, send: sends[0]!, receive: receives[0]! });
    }
  }

  // Cycles are checked on the combined graph (§19 decision 8):
  // containment edges plus cable edges, both read as "depends on". The
  // locally decidable case — the receive inside the sender's own
  // subtree — gets §1.7's own message rather than a generic cycle
  // report; anything else that loops is a chain of cables and
  // placements, named hop by hop.
  const cableDeps = new Map<string, string[]>();
  for (const { send, receive } of complete) {
    cableDeps.set(receive.track, [...(cableDeps.get(receive.track) ?? []), send.track]);
  }
  const cyclic = new Set<string>();
  for (const { label, send, receive } of complete) {
    // Sending to your own receive is the first thing someone tries when
    // they misread the label as a destination, so it gets its own
    // sentence rather than `"x" is inside "x"` (#125 review).
    if (send.track === receive.track) {
      push(
        send.file,
        `"${send.track}" both sends and receives "${label}" — the label names a cable ` +
          `between two tracks, not a destination, and a send cannot reach into itself ` +
          `(nested-tracks.md §19)`,
      );
      cyclic.add(label);
      continue;
    }
    if (descendants(send.track).has(receive.track)) {
      push(
        send.file,
        `a send cannot reach into itself — "${receive.track}" is inside "${send.track}", ` +
          `so its output already flows up through the track sending to it ` +
          `(nested-tracks.md §1.7)`,
      );
      cyclic.add(label);
      continue;
    }
    // Does the sender depend, through any mix of containment and
    // cables, on the receiver? Then this cable closes a loop.
    const path = findPath(send.track, receive.track, childEdges, cableDeps);
    if (path !== undefined) {
      push(
        receive.file,
        `send cycle: ${[receive.track, ...path].join(' → ')} ` +
          `(the cable "${label}" closes the loop)`,
      );
      cyclic.add(label);
    }
  }

  // Skips a cable whose derivation cannot be trusted — a containment
  // cycle on the walk, a broken clock, unresolved musical time. Each of
  // those already carries its own diagnostic, so the cable adds none.
  class SkipCable extends Error {}

  // Arrival multisets are offset → count maps: identical offsets
  // collapse, which is what keeps shared containment (each level of
  // sharing multiplies the soundings) from expanding a set the mix
  // itself holds compactly. Offsets stay unrounded until the end so
  // rate-ratio arithmetic dedupes exactly.
  type Arrivals = Map<number, number>;
  const add = (into: Arrivals, at: number, count: number): void => {
    into.set(at, (into.get(at) ?? 0) + count);
  };
  const finish = (raw: Arrivals): CableArrival[] => {
    const rounded: Arrivals = new Map();
    for (const [at, count] of raw) add(rounded, Math.round(at), count);
    return [...rounded]
      .map(([at, count]) => ({ at, count }))
      .sort((a, b) => a.at - b.at);
  };
  const spell = (raw: Arrivals): string =>
    `[${finish(raw)
      .map((a) => `${a.at}${a.count > 1 ? `×${a.count}` : ''}`)
      .join(', ')}]`;

  const cables: Cable[] = [];
  const displacedDiagnosed = new Set<string>();
  // Only a song with a muted placement needs the audible pass.
  const muted = [...childEdges.values()].some((edges) => edges.some((e) => e.entry.mute));
  for (const { label, send, receive } of complete) {
    if (cyclic.has(label)) continue;
    const receiverRate = clocks.get(receive.track)?.rate;
    if (receiverRate === undefined) continue;

    // Set for the second, audible pass below: muted placements are
    // skipped, and diagnostics are left to the first pass.
    let audibleOnly = false;

    // Sender placements inside `x`'s subtree, as arrivals in x's clock
    // (receiver-rate samples — the clocks align wherever the answer is
    // legal to use). Memoized per track: each subtree is one fact
    // however many paths reach it.
    const downMemo = new Map<string, Arrivals>();
    const downStack = new Set<string>();
    const compose = (into: Arrivals, edge: Edge, sub: Arrivals): void => {
      const instances = instanceDisplacements(edge);
      const parentRate = clocks.get(edge.parent)?.rate;
      if (instances === undefined || parentRate === undefined) throw new SkipCable();
      const factor = receiverRate / parentRate;
      for (const d of instances) {
        for (const [at, count] of sub) add(into, d * factor + at, count);
      }
    };
    const down = (x: string): Arrivals => {
      if (x === send.track) return new Map([[0, 1]]);
      const seen = downMemo.get(x);
      if (seen !== undefined) return seen;
      if (downStack.has(x)) throw new SkipCable();
      downStack.add(x);
      const out: Arrivals = new Map();
      for (const edge of childEdges.get(x) ?? []) {
        if (audibleOnly && edge.entry.mute) continue;
        const sub = down(edge.child);
        if (sub.size === 0) continue;
        compose(out, edge, sub);
      }
      downStack.delete(x);
      downMemo.set(x, out);
      return out;
    };

    // The sender placements that join at `x` when the walk arrived from
    // the child track `via`: every subtree under x except via's — those
    // are other instances of the containment the receiver sits in, and
    // an instance hears itself, not its siblings (the placed-ancestor
    // coherence, §19 decision 5).
    const joins = (x: string, via: string | undefined): Arrivals => {
      const out: Arrivals = new Map();
      for (const edge of childEdges.get(x) ?? []) {
        if (via !== undefined && edge.child === via) continue;
        if (audibleOnly && edge.entry.mute) continue;
        const sub = down(edge.child);
        if (sub.size === 0) continue;
        compose(out, edge, sub);
      }
      return out;
    };

    // Everything audible from `x` looking up, having climbed out of
    // `via`: x's own joins plus whatever joins higher. A displaced up
    // edge is legal exactly when nothing joins above it — then it
    // shifts the whole circuit below as one (§19: the ancestor itself
    // may be placed) — and where x has several undisplaced parents,
    // their views must agree, because they all play the same render.
    let anyError = false;
    let divergenceReported = false;
    const upMemo = new Map<string, Arrivals>();
    const upStack = new Set<string>();
    const arrive = (x: string, via: string | undefined): Arrivals => {
      const key = `${x}|${via ?? ''}`;
      const seen = upMemo.get(key);
      if (seen !== undefined) return seen;
      if (upStack.has(key)) throw new SkipCable();
      upStack.add(key);
      const result = joins(x, via);
      let above: Arrivals | undefined;
      let aboveVia: string | undefined;
      for (const edge of parentEdges.get(x) ?? []) {
        if ([edge.entry.at, edge.entry.duration, edge.entry.loop?.every].some(unresolved)) {
          throw new SkipCable();
        }
        const up = arrive(edge.parent, x);
        const fields = displacingFields(edge.entry);
        if (fields.length > 0 && up.size > 0) {
          const dkey = `${label}|${edge.file}|${edge.index}`;
          if (!audibleOnly && !displacedDiagnosed.has(dkey)) {
            displacedDiagnosed.add(dkey);
            push(
              edge.file,
              `${entryName(edge.entry, edge.index)} carries ${fields.join(', ')} on the ` +
                `path from "${receive.track}" up to "${edge.parent}" — a receive is legal ` +
                `only where that path is a single unshifted pass (nested-tracks.md §19)`,
            );
          }
          anyError = true;
          continue;
        }
        // A displaced edge with nothing joining above shifts whatever
        // sits below it as one — legal — but "shifts as one" is a
        // claim about this parent only, so its empty contribution
        // still answers the agreement question below: a sibling
        // parent that does hear the sender is a divergence that
        // displacing this edge must not hide (minjudd on #125).
        if (above === undefined) {
          above = up;
          aboveVia = edge.parent;
        } else if (spell(up) !== spell(above)) {
          if (!audibleOnly && !divergenceReported) {
            divergenceReported = true;
            push(
              receive.file,
              `receive "${label}" hears different arrivals through its containment paths — ` +
                `via ${aboveVia} → ${x} it hears ${spell(above)} but via ${edge.parent} → ` +
                `${x} ${spell(up)} (receiver-rate samples); a track renders once however ` +
                `often it is placed (§13), so every path must agree (nested-tracks.md §19)`,
            );
          }
          anyError = true;
        }
      }
      if (above !== undefined) for (const [at, count] of above) add(result, at, count);
      upStack.delete(key);
      upMemo.set(key, result);
      return result;
    };

    let raw: Arrivals;
    try {
      raw = arrive(receive.track, undefined);
    } catch (err) {
      if (err instanceof SkipCable) continue;
      throw err;
    }
    if (anyError) continue;
    // The pass above answers the structure: whether the cable joins at
    // all, and every diagnostic, with muted placements counted so a mute
    // never hides or invents an error. What sounds is a second pass
    // without them: a muted placement is absent from the mix (graph.ts
    // planFor), so its sends are absent too. A cable whose every sender
    // placement is muted is joined but silent, not dangling.
    let audible: Arrivals = raw;
    if (raw.size > 0 && muted) {
      audibleOnly = true;
      downMemo.clear();
      upMemo.clear();
      try {
        audible = arrive(receive.track, undefined);
      } catch (err) {
        if (!(err instanceof SkipCable)) throw err;
        audible = new Map();
      }
    }
    if (raw.size === 0) {
      push(
        receive.file,
        `cable "${label}" joins "${send.track}" to "${receive.track}" but no track contains ` +
          `both, so the signal never arrives — place the receiving track where the sender ` +
          `is reachable (nested-tracks.md §19)`,
      );
      continue;
    }
    cables.push({
      label,
      sender: send.track,
      receiver: receive.track,
      gainDb: send.gainDb,
      tap: send.tap,
      arrivals: finish(audible),
    });
  }
  return cables;
}

// One line per cable end, for `field explain` — a cable appears when
// either end's level is questioned (nested-tracks.md §19 chunk 4),
// because the edge's gain is part of the answer neither track file
// shows in full.
export function formatCable(cable: Cable, from: string): string {
  const level = `${fmtDb(cable.gainDb)} dB (tap ${cable.tap})`;
  // A joined cable with no arrivals has every sender placement muted:
  // checkCables only keeps a cable that joins, and the audible pass drops
  // muted placements. Said in words, because "0 arrivals" reads as a bug.
  const silent = cable.arrivals.length === 0;
  if (cable.sender === from) {
    return `send "${cable.label}" → track:${cable.receiver}, ${level}${silent ? ', silent: every placement of this track is muted' : ''}`;
  }
  // A count above one marks identical placements landing together —
  // rendered as one clip at +20·log₁₀(count) dB.
  const spellArrival = (a: CableArrival): string => `${a.at}${a.count > 1 ? `×${a.count}` : ''}`;
  const arrivals = silent
    ? `silent: every placement of track:${cable.sender} that reaches here is muted`
    : cable.arrivals.length === 1
      ? `arrives at sample ${spellArrival(cable.arrivals[0]!)}`
      : `${cable.arrivals.length} arrivals at samples ${cable.arrivals.map(spellArrival).join(', ')}`;
  return `receive "${cable.label}" ← track:${cable.sender}, ${level}, ${arrivals}`;
}

// A dependency path from `from` to `to` over containment and cable
// edges, as the tracks visited after `from` — or undefined when none
// exists. Used to name a send cycle hop by hop.
function findPath(
  from: string,
  to: string,
  childEdges: Map<string, Edge[]>,
  cableDeps: Map<string, string[]>,
): string[] | undefined {
  const seen = new Set<string>([from]);
  const walk = (n: string, path: string[]): string[] | undefined => {
    if (n === to) return path;
    const next = [
      ...(childEdges.get(n) ?? []).map((e) => e.child),
      ...(cableDeps.get(n) ?? []),
    ];
    for (const dep of next) {
      if (seen.has(dep)) continue;
      seen.add(dep);
      const found = walk(dep, [...path, dep]);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return walk(from, [from]);
}
