// Compile the graph into a live session (realtime.md §3, chunk 2).
//
// The graph's track nodes already carry each track's full StemSpec —
// resolved clips at the track's rate, sources as ordered refs matching
// node.deps — so the compiler transforms those specs instead of
// re-planning. Sources classify three ways by their dep label: a
// `track:` ref becomes a `track` window (the child's live output ring
// read at a delay — a post-tap cable arrival is mechanically the same
// thing and compiles to the same shape); a `tap:` ref becomes a
// `receive` window reading the sender's pre-chain ring; everything else
// is a `file` window naming the built or committed path, which is why
// the compiler builds every non-track dependency first.
//
// Latency is compiler arithmetic, never engine arithmetic (playback.md
// §3.6's division of labour): the limiter's live horizon is one attack
// ramp (60 dB — session.ts records the choice), eq and reverb are
// zero, a materialized cross-rate edge is delay-free (realtime.md
// decision 7's amendment: the wrapper's emission is timeline-aligned),
// and each summing input carries comp_delay = maxSibling − own so
// unequal paths arrive aligned. The engine only applies offsets.
//
// Durations resolve analytically, bottom-up: a file window from its WAV
// header (execute()'s own rule, frames − read_offset), a track window
// from the child's computed live length — content end plus each
// reverb's predelay and tail, truncated to the declared extent on the
// song's output. A window whose start − read_offset is negative would
// need future child samples; live taps only ever delay, so that is a
// compile error.
//
// The cache is the freeze (realtime.md decision 4, chunk 4): before
// compiling, every non-output, non-pre-tapped track asks the build
// cache — explain(), which executes nothing — whether its stem action
// is cached. A cached track compiles to one file window over its stem;
// the rest evaluate live and are reported as `dirty`, so the watch loop
// can rebuild their stems behind the play and freeze them on the next
// compile — a swap that is inaudible because live and offline are
// bit-identical (decision 3). CPU scales with what is being edited,
// not with the session.

import { join } from 'node:path';
import { wavFrameCount } from '../audio/wav.js';
import { SESSION_VERSION, insertGrowth, insertLatency, type Session, type SessionInsert, type SessionTrack } from '../audiod/session.js';
import { formatLabel } from '../labels.js';
import { formatDiagnostic, loadProject, projectPath } from '../model/project.js';
import { leaveOutNotes } from '../model/live-notes.js';
import { applySolo } from '../model/solo.js';
import type { SpecInsert } from '../generators/stem.js';
import { toPluginWire } from '../audio/plugins.js';
import { build, explain, type Explanation } from './build.js';
import { buildGraph, type Graph, type GraphNode } from './graph.js';

interface TrackShape {
  name: string;
  rate: number;
  spec: StemLike;
  deps: string[]; // formatted labels, aligned with spec.sources
}

// The slice of StemSpec the compiler reads; kept structural so this
// module does not import the generator internals.
interface StemLike {
  sources: string[];
  clips: {
    input: number;
    start: number;
    duration?: number;
    read_offset: number;
    gain_db: number;
    pan?: number;
    fade_in: number;
    fade_out: number;
  }[];
  inserts?: SpecInsert[];
  length_samples?: number;
  loop?: boolean;
}

function liveInsert(insert: SpecInsert, root: string): SessionInsert {
  // A hosted arm goes live in its wire spelling (plugin-hosting.md
  // chunk 2): the keyed spec plus the machine-local half, the same
  // enrichment the offline execute performs — one shape, both paths.
  if (insert.effect === 'plugin') return toPluginWire(insert, root);
  if (insert.effect === 'limit') return { ...insert, horizon_db: 60 };
  return insert as SessionInsert;
}

// The chain's totals, summed from each insert's own declared
// arithmetic (session.ts insertLatency/insertGrowth — the per-effect
// formulas live beside the wire schema, not here).
function chainLatency(chain: SessionInsert[], rate: number): number {
  return chain.reduce((sum, insert) => sum + insertLatency(insert, rate), 0);
}

// The wrapper's output-length rule (resample.cpp's flush), mirrored the
// way chainLatency and chainGrowth mirror their dsp counterparts:
// n > 0 ? max(1, round(n·to/from)) : 0 in reduced-ratio integer
// arithmetic — zero in, zero out, and the floor at one only for a
// non-empty source ("never round a non-empty source away", #57).
export function convertedLength(frames: number, from: number, to: number): number {
  if (from === to) return Math.max(0, frames);
  if (frames <= 0) return 0;
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const g = gcd(to, from);
  const phases = to / g;
  const stride = from / g;
  return Math.max(1, Math.floor((frames * phases + Math.floor(stride / 2)) / stride));
}

function chainGrowth(chain: SessionInsert[], rate: number): number {
  return chain.reduce((sum, insert) => sum + insertGrowth(insert, rate), 0);
}

export interface CompiledSession {
  session: Session;
  // Freeze candidates that missed the cache this compile — reachable
  // tracks evaluating live that one stem build away from being served
  // as cached files. Never the output track (always live: its windows
  // are the ramp surface, and a looping wrap is a performance where the
  // artifact is a fold) and never a pre-tap sender (a stem is
  // post-chain; the cable needs the pre ring), so a watch loop that
  // rebuilds exactly this list converges instead of chasing tracks
  // that can never freeze.
  dirty: string[];
}

// A live input to attach (live-supercollider.md §2): the window named
// `input` goes on `track`, and the daemon feeds it. A `seq:` input also
// leaves out the track's notes renders (model/live-notes.ts).
export interface SessionInput {
  track: string;
  input: string;
}

export async function compileSession(
  root: string,
  songName: string,
  options: { loop?: boolean; solo?: string; inputs?: SessionInput[] } = {},
): Promise<CompiledSession> {
  const project = loadProject(root);
  const errors = project.diagnostics.filter((d) => d.severity !== 'warning');
  // The diagnostics ride the message, exactly as loadValid's gate spells
  // them: `field play` is where a red project most often surfaces, and
  // "project has errors" with the errors withheld sends a person off to
  // run a second command for what this one already knew.
  if (errors.length > 0) {
    const lines = project.diagnostics.map(formatDiagnostic).join('\n');
    throw new Error(`project has errors (field check):\n${lines}`);
  }
  const song = project.songs.find((s) => s.name === songName);
  if (!song) throw new Error(`no such song "${songName}"`);
  // Solo is session-only (model/solo.ts): the loaded copy is filtered
  // before the graph is built, the files never change, and the un-soloed
  // session comes back by compiling without the option. Validation ran
  // above on the real project, so a red project refuses identically
  // soloed or not.
  if (options.solo !== undefined) applySolo(song, options.solo);
  // An input named `seq:<song>/<track>` (audiod/live-inputs.ts) says the
  // track's notes play live through it.
  const liveNotes = (options.inputs ?? []).filter(({ input }) => input.startsWith('seq:')).map(({ track }) => track);
  leaveOutNotes(song, new Set(liveNotes));
  const graph: Graph = buildGraph(project);

  // The song's track nodes, keyed by name; their deps aligned to sources.
  const shapes = new Map<string, TrackShape>();
  const stemNodes = new Map<string, GraphNode>();
  for (const track of song.tracks) {
    const key = `//${song.dir}/track:${track.data.name}`;
    const node = graph.nodes.get(key);
    if (node === undefined || node.kind !== 'rule') throw new Error(`no stem node for ${key}`);
    stemNodes.set(track.data.name, node);
    shapes.set(track.data.name, {
      name: track.data.name,
      rate: node.sampleRate,
      spec: node.spec as unknown as StemLike,
      deps: node.deps.map((d) => formatLabel(d)),
    });
  }
  if (!shapes.has('main')) throw new Error(`song "${songName}" has no track named "main"`);

  // Live inputs (live-supercollider.md §2): each input's track and
  // every track above it on the way to main stay live — never frozen
  // into a stem, which has no chain left — so the engine can run a
  // second instance of each chain for the input (§9). The path must
  // reach main, or nobody hears the input, and must stay at one rate,
  // because the overlay has no converter yet.
  const liveInputs = options.inputs ?? [];
  const convertSource = (dep: string): string | undefined => {
    if (!/\/convert:/.test(dep)) return undefined;
    const node = graph.nodes.get(dep);
    if (node === undefined || node.kind !== 'rule') return undefined;
    const source = (node.spec as { source?: string }).source;
    return source === undefined ? undefined : /^(?:track|tap):(.+)$/.exec(source)?.[1];
  };
  const readers = new Map<string, { name: string; convert: boolean }[]>();
  for (const shape of shapes.values()) {
    for (const dep of shape.deps) {
      const direct = /\/(?:track|tap):(.+)$/.exec(dep)?.[1];
      const converted = direct === undefined ? convertSource(dep) : undefined;
      const child = direct ?? converted;
      if (child === undefined || !shapes.has(child)) continue;
      readers.set(child, [...(readers.get(child) ?? []), { name: shape.name, convert: converted !== undefined }]);
    }
  }
  const liveBound = new Set<string>();
  const inputNames = new Set<string>();
  for (const { track, input } of liveInputs) {
    if (!shapes.has(track)) throw new Error(`input "${input}" names "${track}", which is not a track in song "${songName}"`);
    if (inputNames.has(input)) throw new Error(`input "${input}" is named twice`);
    inputNames.add(input);
    const reach = new Set<string>();
    const queue = [track];
    while (queue.length > 0) {
      const name = queue.pop()!;
      if (reach.has(name)) continue;
      reach.add(name);
      for (const reader of readers.get(name) ?? []) {
        if (reader.convert) {
          throw new Error(
            `the input on "${track}" crosses from "${name}" into "${reader.name}" at another rate; ` +
              `an input's path needs one rate`,
          );
        }
        queue.push(reader.name);
      }
    }
    if (!reach.has('main')) throw new Error(`"${track}" is not under main, so input "${input}" would not be heard`);
    for (const name of reach) liveBound.add(name);
  }

  // The freeze (realtime.md decision 4): a track whose stem action is
  // already cached is served as that stem — one file window, no chain,
  // no children — because live and offline are sample-identical, so the
  // cached artifact is what live evaluation would have produced anyway.
  // explain() answers "is this cached" without executing anything; a
  // miss means the track evaluates live and lands in `dirty` for the
  // watch loop to rebuild behind the play. Two kinds of track never
  // freeze: the output (see CompiledSession), and any pre-tap sender —
  // conservatively, a sender tapped anywhere in the song, even if the
  // receiver itself froze.
  const memo = new Map<string, Explanation>();

  // Cross-rate edges arrive as convert: deps (multi-rate.md decision 4:
  // a parent consumes the minted conversion, never the foreign-rate
  // child directly). Each one classifies exactly like a track does
  // under the freeze: cached, it is a file window over the converted
  // artifact; uncached with a live source — this song's track: or
  // tap: — the child evaluates live at its own rate and the engine
  // converts at the edge (cross-rate-live.md decision 1), which is
  // what replaces building the conversion synchronously inside this
  // compile, the re-render-and-swap cliff decision 7 rejected.
  // Uncached with a file source (a cross-rate asset placed directly)
  // still builds here: converting a file is a build, dirty only when
  // the file changed.
  const liveConvert = new Map<string, { kind: 'track' | 'tap'; name: string }>();
  for (const shape of shapes.values()) {
    for (const dep of shape.deps) {
      if (!/\/convert:/.test(dep) || liveConvert.has(dep)) continue;
      const node = graph.nodes.get(dep);
      if (node === undefined || node.kind !== 'rule') continue;
      const source = (node.spec as { source?: string }).source;
      const ref = source === undefined ? null : /^(track|tap):(.+)$/.exec(source);
      if (!ref || !shapes.has(ref[2]!)) continue;
      const explanation = await explain(project, graph, node, memo);
      if (explanation.cached !== true || explanation.outputs === undefined) {
        liveConvert.set(dep, { kind: ref[1] as 'track' | 'tap', name: ref[2]! });
      }
    }
  }

  const preTapped = new Set<string>();
  for (const shape of shapes.values()) {
    for (const dep of shape.deps) {
      const tap = /\/tap:(.+)$/.exec(dep);
      if (tap) preTapped.add(tap[1]!);
      // A live-evaluated tap conversion reads the sender's pre ring
      // like a direct tap does; a cached one reads a file and forces
      // nothing live.
      const conv = liveConvert.get(dep);
      if (conv?.kind === 'tap') preTapped.add(conv.name);
    }
  }
  const frozen = new Set<string>();
  const candidates = new Set<string>();
  for (const name of shapes.keys()) {
    if (name === 'main' || preTapped.has(name) || liveBound.has(name)) continue;
    candidates.add(name);
    // Hosted chains freeze by the same rule as built-ins now
    // (plugin-hosting.md chunk 2 lifted chunk 1's unconditional
    // freeze): cached serves the stem, dirty evaluates live — the
    // engine instantiates the plugin at load and the swap back to
    // frozen rides the warmup bound rather than byte-identity, which
    // is the whole difference the plan records for hosted arms.
    const explanation = await explain(project, graph, stemNodes.get(name)!, memo);
    if (explanation.cached === true && explanation.outputs !== undefined) frozen.add(name);
  }

  // Reach from the output: recursion stops at a frozen track (its
  // subtree is inside the stem), and tracks nothing reaches drop from
  // the session entirely — the engine would otherwise pre-render audio
  // nobody mixes. `dirty` is the reachable candidates that missed.
  const liveReach = new Set<string>();
  const frozenUsed = new Set<string>();
  const visit = (name: string): void => {
    if (frozen.has(name)) {
      frozenUsed.add(name);
      return;
    }
    if (liveReach.has(name) || !shapes.has(name)) return;
    liveReach.add(name);
    for (const dep of shapes.get(name)!.deps) {
      const ref = /\/(track|tap):(.+)$/.exec(dep);
      if (ref) visit(ref[2]!);
      const conv = liveConvert.get(dep);
      if (conv) visit(conv.name);
    }
  };
  visit('main');
  // Dirty speaks convert labels for cross-rate children (cross-rate-
  // live.md decision 5): the background freeze builds the conversion,
  // which builds the child's stem beneath it, and the next compile
  // serves the file window — the same convergence one node deeper.
  const dirty = [
    ...[...liveReach]
      .filter((n) => candidates.has(n) && !frozen.has(n))
      .map((n) => `//${song.dir}/track:${n}`),
    ...new Set(
      [...liveReach].flatMap((n) =>
        shapes.get(n)!.deps.filter((d) => liveConvert.has(d)),
      ),
    ),
  ];

  // Build every file the engine will read: the non-track dependencies
  // (sources, gen artifacts, converts) of each live reachable track —
  // minus the conversions evaluating live, which are exactly what this
  // compile must not wait on — plus the frozen stems themselves. For
  // built-in chains those are guaranteed cache hits (explain just said
  // so) and only materialize; a dirty hosted chain renders here for
  // real, which is the deliberate wait described above.
  const isLive = (label: string) => /\/(track|tap):/.test(label) || liveConvert.has(label);
  const toBuild = [
    ...new Set([
      ...[...liveReach].flatMap((n) => shapes.get(n)!.deps.filter((d) => !isLive(d))),
      ...[...frozenUsed].map((n) => `//${song.dir}/track:${n}`),
    ]),
  ];
  const fileByLabel = new Map<string, { path: string; sha256: string }>();
  if (toBuild.length > 0) {
    // Built from this compile's own project and graph, not by label from
    // a fresh load: under a solo the graph is the soloed one, and a track
    // frozen because its soloed spec is cached must be served that stem.
    // Reloading would answer with the un-soloed track's stem instead.
    const nodes = toBuild.map((label) => {
      const node = graph.nodes.get(label);
      if (node === undefined) throw new Error(`no node for ${label}`);
      return node;
    });
    for (const outcome of await build(project, graph, nodes)) {
      if (outcome.outputPath !== undefined)
        fileByLabel.set(outcome.label, {
          // Slash-separated like every path in the session JSON: the
          // daemon resolves them against its cwd, and Windows accepts
          // the forward slashes there too.
          path: projectPath(root, outcome.outputPath),
          sha256: outcome.sha256,
        });
    }
  }

  // Bottom-up: live lengths (pre = content end, post = pre + chain
  // growth, the output truncated to its declared extent) and latencies.
  const preLength = new Map<string, number>();
  const postLength = new Map<string, number>();
  const latency = new Map<string, number>();
  const compiled = new Map<string, SessionTrack>();

  const compile = (name: string, stack: string[]): void => {
    if (compiled.has(name)) return;
    if (stack.includes(name)) throw new Error(`placement cycle at "${name}"`); // validate's backstop
    const shape = shapes.get(name);
    if (!shape) throw new Error(`no such track "${name}"`);
    if (frozen.has(name)) {
      // The cached form: the whole subtree as one file window reading
      // the stem, chain empty (the stem is post-chain), latency zero
      // (a stem is final, timeline-aligned from sample 0). The engine
      // needs nothing special — this is ordinary session vocabulary,
      // which is what makes the freeze swap a plain session swap.
      const built = fileByLabel.get(`//${song.dir}/track:${name}`);
      if (built === undefined) throw new Error(`unbuilt frozen stem for "${name}"`);
      const frames = wavFrameCount(join(root, built.path));
      preLength.set(name, frames);
      postLength.set(name, frames);
      latency.set(name, 0);
      compiled.set(name, {
        name,
        rate: shape.rate,
        chain: [],
        inputs: [
          {
            file: built.path,
            sha256: built.sha256,
            start: 0,
            duration: frames,
            read_offset: 0,
            gain_db: 0,
            fade_in: 0,
            fade_out: 0,
          },
        ],
        latency: 0,
      });
      return;
    }
    const chain = (shape.spec.inserts ?? []).map((insert) => liveInsert(insert, root));

    // Resolve every window; recurse into children first.
    let contentEnd = 0;
    let maxInputLatency = 0;
    const inputs: SessionTrack['inputs'] = [];
    const pending: { index: number; ownLatency: number }[] = [];
    for (const clip of shape.spec.clips) {
      const dep = shape.deps[clip.input]!;
      const base = {
        start: clip.start,
        read_offset: clip.read_offset,
        gain_db: clip.gain_db,
        ...(clip.pan !== undefined ? { pan: clip.pan } : {}),
        fade_in: clip.fade_in,
        fade_out: clip.fade_out,
      };
      const direct = /\/(track|tap):(.+)$/.exec(dep);
      const edge = direct
        ? { kind: direct[1] as 'track' | 'tap', name: direct[2]! }
        : liveConvert.get(dep);
      if (edge) {
        // One path for both spellings: a direct ref is always
        // same-rate (the graph routes every cross-rate edge through a
        // convert node), and a live-evaluated conversion is the same
        // window with the child at its own rate — the arithmetic here
        // runs in this track's rate against the *converted* child
        // length, because the clip was planned against the convert
        // node's output, and convertedLength is the identity when the
        // rates agree. The engine sees the rates differ and converts
        // the materialized buffer through the shared kernel
        // (cross-rate-live.md decision 1); a materialized edge is
        // delay-free (realtime.md decision 7's amendment), so the only
        // latency is the child's own, scaled onto this track's clock.
        const child = edge.name;
        compile(child, [...stack, name]);
        if (clip.start - clip.read_offset < 0) {
          throw new Error(
            `"${name}" places "${child}" needing samples before its start ` +
              `(start ${clip.start} < read_offset ${clip.read_offset}) — live taps only delay`,
          );
        }
        const childShape = shapes.get(child)!;
        const isTap = edge.kind === 'tap';
        const childLength = convertedLength(
          isTap ? preLength.get(child)! : postLength.get(child)!,
          childShape.rate,
          shape.rate,
        );
        const duration = clip.duration ?? Math.max(0, childLength - clip.read_offset);
        const ownLatency = isTap
          ? 0
          : Math.round((latency.get(child)! * shape.rate) / childShape.rate);
        maxInputLatency = Math.max(maxInputLatency, ownLatency);
        contentEnd = Math.max(contentEnd, clip.start + duration);
        pending.push({ index: inputs.length, ownLatency });
        inputs.push(
          isTap
            ? { receive: child, tap: 'pre', ...base, duration, comp_delay: 0 }
            : { track: child, ...base, duration, comp_delay: 0 },
        );
      } else {
        const built = fileByLabel.get(dep);
        if (built === undefined) throw new Error(`unbuilt source ${dep} for "${name}"`);
        const frames = wavFrameCount(join(root, built.path));
        const duration = clip.duration ?? Math.max(0, frames - clip.read_offset);
        contentEnd = Math.max(contentEnd, clip.start + duration);
        inputs.push({ file: built.path, sha256: built.sha256, ...base, duration });
      }
    }

    // The inputs on this track: no place on the timeline, so no length
    // and no latency here; the engine's overlay carries them (§9).
    for (const { input } of liveInputs.filter((i) => i.track === name)) inputs.push({ input, gain_db: 0 });

    // comp_delay stays zero (Codex caught the double-compensation): the
    // engine's buffers are timeline-aligned — a chain's stream lag is
    // availability, not shift, because emitted sample i pairs with input
    // sample i — so subtracting latency again would slide content. The
    // field exists for the day a source's future does not (recording),
    // and the latency arithmetic above still feeds the track's reported
    // latency.
    void pending;

    const pre = contentEnd;
    let post = pre + chainGrowth(chain, shape.rate);
    if (shape.spec.length_samples !== undefined) post = shape.spec.length_samples;
    preLength.set(name, pre);
    postLength.set(name, post);
    latency.set(name, maxInputLatency + chainLatency(chain, shape.rate));

    compiled.set(name, {
      name,
      rate: shape.rate,
      chain,
      inputs,
      latency: latency.get(name)!,
    });
  };

  compile('main', []);

  const output = shapes.get('main')!;
  // The session is always bounded: the declared extent when the song
  // has one, the output's natural length — content end plus chain
  // growth, exactly where the artifact ends — when it does not
  // (Codex's finding: an unbounded session played silence forever
  // after the content ran out). The authored `loop:` never reaches
  // the transport — it is a render-shape declaration, the fold
  // (clip-looping.md: "one seamless pass of the infinite
  // performance") — and player repetition is `field play --loop`,
  // which wraps at the same extent the length picks.
  const extent = output.spec.length_samples ?? postLength.get('main')!;
  const session: Session = {
    version: SESSION_VERSION,
    song: songName,
    ...(options.solo !== undefined ? { solo: options.solo } : {}),
    rate: output.rate,
    ...(extent > 0 ? { length_samples: extent } : {}),
    ...(options.loop === true ? { loop: true } : {}),
    output: 'main',
    tracks: [...compiled.values()],
  };
  return { session, dirty };
}


// The edit classifier (realtime.md decision 5): two compiled sessions,
// one verdict. Sessions identical except window gains become ramps — the
// mixer surface, landing next block with no interruption; anything else
// is structural and swaps the whole session, which the daemon does at a
// block boundary while the old one keeps playing through the compile.
export type SessionEdit =
  | { kind: 'same' }
  | { kind: 'ramps'; ramps: { track: string; input: number; gain_db: number }[] }
  | { kind: 'swap' };

export function diffSessions(prev: Session, next: Session): SessionEdit {
  // Only the output track's window gains can ramp: every other track
  // pre-renders at load with its gains baked into the buffers, so a
  // ramp there would report success and change nothing (live.cpp says
  // as much where it lands ramps), and a chain setting that happens to
  // be spelled gain_db — an eq band — is an edited chain, decision 5's
  // structural case. So the mask is by position, not by name: exactly
  // the gains the ramp verb reaches go blank, and any other gain_db
  // stays visible to the comparison and falls through to swap.
  // (Decision 5 lists pan beside gain; rampRequestSchema carries no pan
  // yet, so a pan edit swaps — the safe direction — until the verb
  // grows one.)
  const shapeOf = (s: Session): string =>
    JSON.stringify({
      ...s,
      tracks: s.tracks.map((t) =>
        t.name === s.output
          ? { ...t, inputs: t.inputs.map((i) => ({ ...i, gain_db: 0 })) }
          : t,
      ),
    });
  if (shapeOf(prev) !== shapeOf(next)) return { kind: 'swap' };

  // Same shape guarantees the same output track with the same inputs on
  // both sides; only its gains can differ here.
  const before = prev.tracks.find((t) => t.name === prev.output)!;
  const after = next.tracks.find((t) => t.name === next.output)!;
  const ramps: { track: string; input: number; gain_db: number }[] = [];
  for (let i = 0; i < after.inputs.length; i++) {
    if (before.inputs[i]!.gain_db !== after.inputs[i]!.gain_db) {
      ramps.push({ track: after.name, input: i, gain_db: after.inputs[i]!.gain_db });
    }
  }
  return ramps.length > 0 ? { kind: 'ramps', ramps } : { kind: 'same' };
}
