import { basename } from 'node:path';
import { KeysHelper, SOURCE_NAME } from '../keys/helper.js';
import { keyboardLines } from '../keys/keyboard.js';
import { loadKeymap, resolveKeymapSource, watchKeymap, type KeymapSource } from '../keys/keymap.js';
import { formatKnobValue, knobValueWidth } from '../keys/knobs.js';
import { charactersToPositions, PressedKeys, unplayablePositions, type KeyboardLayout } from '../keys/position.js';
import { publishControllers, unpublishControllers } from '../keys/published.js';
import { printKeymap, signed } from '../keys/print.js';
import { KeysSession, TICK_MS, type MidiMessage } from '../keys/session.js';
import { decodeTerminal, ENABLE, isQuit, probeKittyProtocol, RESTORE, type Tty } from '../keys/terminal.js';
import { resolveKeysTargets, type ArmedInstrument } from '../keys/targets.js';
import { findProjectRoot } from '../model/project.js';
import { VoiceHost, type VoiceHostStatus } from '../sc/voice/host.js';
import { KnobFiles, loadKnobSources, type KnobSource } from '../sc/voice/knob-files.js';
import { routeVoices, type Routing, type Unrouted } from '../sc/voice/routing.js';
import type { Knob } from '../schema/knobs.js';
import type { Keymap } from '../schema/keymap.js';

export const UNSUPPORTED_TERMINAL =
  'field keys needs a terminal that reports key releases through the kitty keyboard protocol: ' +
  'Ghostty, iTerm2 3.5 or later, kitty, or WezTerm. This terminal did not answer the protocol probe.';

export interface KeysOptions {
  keymap?: string;
  print?: boolean;
  device?: string;
  knobs?: string[];
}

export async function keysCommand(targets: string[], options: KeysOptions): Promise<void> {
  const source = resolveKeymapSource(options.keymap);
  const keymap = loadKeymap(source.path);
  if (options.print === true) {
    process.stdout.write(printKeymap(keymap));
    return;
  }
  const armed = resolveKeysTargets(targets);
  const root = findProjectRoot(process.cwd());
  // Every knob file is checked before anything starts, as the keymap is.
  const knobs = loadKnobSources(armed, options.knobs ?? [], root);
  const { stdin, stdout } = process;
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error('field keys reads the keyboard, so it needs a terminal on stdin and stdout');
  }
  let abandoned = false;
  await withKittyKeyboard({ stdin, stdout }, async (rest) => {
    abandoned = (await play({ stdin, stdout }, { source, keymap, armed, knobs, device: options.device, root }, rest)) === 'abandoned';
  });
  // Quit before routing landed: the daemon may still be answering, and
  // waiting for it would hold the prompt. Any input it opens late closes
  // with this process's connection.
  if (abandoned) process.exit(0);
}

// Raw mode and the protocol flags are the terminal's state, not ours, so
// every way out gives them back: a return, a throw, and a crash.
async function withKittyKeyboard(tty: Tty, run: (rest: string) => Promise<void>): Promise<void> {
  let enabled = false;
  const restore = (): void => {
    if (enabled) tty.stdout.write(RESTORE);
    enabled = false;
    if (tty.stdin.isRaw) tty.stdin.setRawMode(false);
    tty.stdin.pause();
  };
  process.once('exit', restore);
  try {
    tty.stdin.setRawMode(true);
    tty.stdin.resume();
    const probe = await probeKittyProtocol(tty);
    if (!probe.supported) throw new Error(UNSUPPORTED_TERMINAL);
    tty.stdout.write(ENABLE);
    enabled = true;
    await run(probe.rest);
  } finally {
    restore();
    process.removeListener('exit', restore);
  }
}

interface PlayOptions {
  source: KeymapSource;
  keymap: Keymap;
  armed: ArmedInstrument[];
  knobs: KnobSource[];
  device: string | undefined;
  root: string | undefined;
}

export type InstrumentState = {
  name: string; // what is armed, as the line names it
  dry: string[]; // tracks whose effects the voices do not pass through yet
  // Why the voices do not pass through them (live-supercollider.md
  // chunk 3), when routing them was not possible.
  dryReason?: string;
  // Why nothing is heard at all: routed, but scsynth never ran the route.
  silent?: string;
  status: Extract<VoiceHostStatus, { state: 'live' | 'restarting' }> | { state: 'starting' };
  // What the last save of the program did (keyboard-instrument.md §14).
  reload?: { loaded: true } | { failed: string };
};

async function play(tty: Tty, options: PlayOptions, carried: string): Promise<'abandoned' | undefined> {
  // Armed tracks play through their effects when the daemon can take
  // their voices (live-supercollider.md chunk 3): each track then gets a
  // voice of its own, writing into its own input. Otherwise each program
  // plays once, straight to the device, and the line says why.
  // Ctrl-C quits while the daemon is still answering: the key handler
  // that would see it does not exist yet, and a daemon starting cold can
  // take seconds.
  let pending = carried;
  let onQuit: ((chunk: Buffer) => void) | undefined;
  const quit = new Promise<'quit'>((resolve) => {
    onQuit = (chunk) => {
      const { events, rest } = decodeTerminal(pending + chunk.toString('utf8'));
      pending = rest;
      if (events.some(isQuit)) resolve('quit');
    };
    tty.stdin.on('data', onQuit);
  });
  const routing0 =
    options.root !== undefined
      ? routeVoices(options.armed, options.root, { kind: 'keys', ...(options.device !== undefined ? { device: options.device } : {}) })
      : Promise.resolve(undefined);
  const first = await Promise.race([routing0, quit]);
  tty.stdin.removeListener('data', onQuit!);
  if (first === 'quit') return 'abandoned';
  const routed = first;
  const routing = routed !== undefined && 'programs' in routed ? routed : undefined;
  const knobFiles = new KnobFiles(options.knobs);
  try {
    await playRouted(tty, options, pending, routed, routing, knobFiles);
  } finally {
    // However the session ends, a throw included, its inputs close and its
    // knob copies go; a process killed outright has the daemon close the
    // inputs with its connection.
    await routing?.close();
    knobFiles.remove();
  }
}

async function playRouted(
  tty: Tty,
  options: PlayOptions,
  carried: string,
  routed: Routing | Unrouted | undefined,
  routing: Routing | undefined,
  knobFiles: KnobFiles,
): Promise<void> {
  const { source, armed } = options;
  const programs = routing?.programs ?? [...new Set(armed.map((a) => a.program))];
  const session = new KeysSession(options.keymap, knobFiles.list());
  let layout: KeyboardLayout | undefined;
  let layoutPositions: ReadonlyMap<string, string> | undefined;
  let reloadError: string | undefined;
  const instrument = instrumentState(armed, routing !== undefined, routed !== undefined && 'reason' in routed ? routed.reason : undefined);

  // The instrument, the keyboard drawing, and the knobs sit above the
  // status line, which changes with every key (keyboard-instrument.md
  // §2.4). They are drawn once, then redrawn in place from the first line
  // that changes.
  const knobLine = new KnobLine();
  let above: string[] = [];
  const draw = (): void => {
    // A terminal that reports no size reports 0 columns.
    const width = Math.max(20, (tty.stdout.columns || 80) - 1);
    const lines = [
      ...(instrument !== undefined ? [instrumentText(instrument).slice(0, width)] : []),
      ...(keyboardLines(session.keymap, session.heldPositions(), width) ?? []),
      ...(session.bindsKnobs() ? [knobLine.text(session, width)] : []),
    ];
    const knobError = knobFiles.errors.values().next().value;
    tty.stdout.write(`${redrawAbove(above, lines)}\r\x1b[K${statusText(session, layout, reloadError, width, knobError)}`);
    above = lines;
  };

  let stop!: (error?: Error) => void;
  const stopped = new Promise<Error | undefined>((resolve) => {
    stop = resolve;
  });

  // Before the helper starts, because its first keyboard layout report
  // draws the status line.
  if (source.kind === 'file') tty.stdout.write(`Saving ${source.path} reloads it.\n`);

  const helper = await KeysHelper.start(SOURCE_NAME, {
    onKeyboard: (reported) => {
      layout = reported;
      layoutPositions = charactersToPositions(reported);
      draw();
    },
    onExit: (reason) => stop(new Error(`the MIDI helper stopped: ${reason}`)),
  });
  // Each control change also goes into .field/keys.json, which `field
  // record` starts a take from (instrument-knobs.md §2.8).
  const { root } = options;
  const send = (messages: MidiMessage[]): void => {
    messages.forEach((m) => helper.send(m));
    if (root !== undefined && messages.some(([status]) => (status! & 0xf0) === 0xb0)) {
      const problem = publishControllers(root, session.sentControllers());
      if (problem !== undefined) session.message = problem;
    }
  };

  // A held turn key and a glide move a knob on a timer of their own, which
  // runs only while a turn key is held or a glide moves
  // (instrument-knobs.md §2.6 and §2.7).
  let ticker: NodeJS.Timeout | undefined;
  const tickWhileMoving = (): void => {
    if (session.ticking() && ticker === undefined) {
      ticker = setInterval(() => {
        send(session.tick(performance.now()));
        tickWhileMoving();
        draw();
      }, TICK_MS);
    } else if (!session.ticking() && ticker !== undefined) {
      clearInterval(ticker);
      ticker = undefined;
    }
  };

  // The host starts after the helper, so `Field Keys` exists when sclang
  // connects its MIDI inputs; the keyboard plays while it boots.
  // A routed voice is heard on the daemon's device, so it is made there.
  const device = routing !== undefined ? routing.device : (options.device ?? helper.defaultOutput);
  const host =
    programs.length > 0
      ? await VoiceHost.start({
          instruments: programs,
          knobs: knobFiles.copies,
          ...(device !== undefined ? { device } : {}),
          ...(routing !== undefined ? { rings: routing.rings, fieldOut: routing.fieldOut } : {}),
          onStatus: (status) => {
            if (status.state === 'voice') return;
            if (status.state === 'reloaded') instrument!.reload = { loaded: true };
            else if (status.state === 'reload-failed') instrument!.reload = { failed: status.reason };
            else instrument!.status = status;
            draw();
          },
          onExit: (reason) => stop(new Error(`the voice host stopped: ${reason}`)),
        })
      : undefined;
  host?.ready.catch((err: Error) => stop(new Error(`the voice host did not start: ${err.message}`)));
  // A route scsynth never ran, because FieldOut did not load in it, leaves
  // its ring empty: the voice is then nowhere, and the line says so.
  if (host !== undefined && routing !== undefined) {
    void host.ready
      .then(() => routing.flowing())
      .then((flowing) => {
        if (flowing || instrument === undefined) return;
        // The voices play into a bus nothing reads: not dry, silent.
        instrument.silent = 'FieldOut did not load in scsynth, so nothing reaches the daemon';
        draw();
      })
      .catch(() => {});
  }

  // Saving a program loads it again, as saving a keymap does
  // (keyboard-instrument.md §14).
  const stopWatchingPrograms = host?.reloadOnSave();
  // A knob file saved: the knobs change and a voice that maps through it
  // reloads, or, when the save fails, only the status line changes.
  const stopWatchingKnobs = knobFiles.watch((_path, result, reload) => {
    if ('knobs' in result) session.setKnobs(knobFiles.list());
    if (reload) void host?.reload();
    draw();
  });
  const stopWatching =
    source.kind === 'file'
      ? watchKeymap(source.path, (result) => {
          if ('error' in result) {
            reloadError = result.error.problems[0];
          } else {
            reloadError = undefined;
            send(session.setKeymap(result.keymap));
            session.message ??= `reloaded ${result.keymap.name}`;
          }
          draw();
        })
      : undefined;

  const pressed = new PressedKeys();
  let pending = carried;
  const onData = (chunk: Buffer): void => {
    const { events, rest } = decodeTerminal(pending + chunk.toString('utf8'));
    pending = rest;
    for (const event of events) {
      if (isQuit(event)) return stop();
      if (event.kind === 'focus' && !event.focused) {
        send(session.releaseAll());
        pressed.clear();
      }
      if (event.kind === 'key') {
        const position = pressed.resolve(event, layoutPositions);
        if (position !== undefined) send(session.handleKey(position, event.type, event.mods));
      }
    }
    tickWhileMoving();
    draw();
  };
  const onSignal = (): void => stop();

  draw();
  tty.stdin.on('data', onData);
  for (const signal of ['SIGTERM', 'SIGHUP', 'SIGINT'] as const) process.on(signal, onSignal);

  const error = await stopped;

  tty.stdin.removeListener('data', onData);
  for (const signal of ['SIGTERM', 'SIGHUP', 'SIGINT'] as const) process.removeListener(signal, onSignal);
  stopWatching?.();
  stopWatchingPrograms?.();
  stopWatchingKnobs();
  send(session.quit());
  tickWhileMoving();
  // A host still booting closes too: quitting never waits for it. The
  // inputs close after it, in play, once nothing writes them.
  await host?.close();
  await helper.close();
  if (root !== undefined) unpublishControllers(root);
  tty.stdout.write('\n');
  if (error !== undefined) throw error;
}

// What the instrument's line starts from: the armed tracks and
// instruments by name, and the tracks whose effects are not heard, which
// is none when the voices pass through them.
export function instrumentState(armed: ArmedInstrument[], heard = false, dryReason?: string): InstrumentState | undefined {
  if (armed.length === 0) return undefined;
  const dry = heard ? [] : [...new Set(armed.flatMap((a) => a.unheardEffects))];
  return {
    name: armed.map(armedName).join(' + '),
    dry,
    ...(!heard && dryReason !== undefined ? { dryReason } : {}),
    status: { state: 'starting' },
  };
}

// A save that did not load leads with why, so a narrow terminal keeps the
// error rather than the device; the voice that loaded last still plays.
export function instrumentText({ name, dry, dryReason, silent, status, reload }: InstrumentState): string {
  if (reload !== undefined && 'failed' in reload) return `${name} kept its last voice: ${reload.failed}`;
  if (silent !== undefined) return `${name} is silent: ${silent}`;
  const state =
    status.state === 'live'
      ? `${name} live at ${status.sampleRate} Hz on ${status.device}`
      : status.state === 'restarting'
        ? `${name} restarting for a new sample rate`
        : `${name} starting`;
  // The voice plays straight to the device, so a track's inserts are not
  // heard (arming.md §2.1); routing them was not possible, and the reason
  // says why (live-supercollider.md chunk 3).
  const why = dryReason !== undefined ? ` (${dryReason})` : '';
  const unheard =
    dry.length > 0 ? ` · dry: the effects on ${dry.join(', ')} are not heard${why}` : dryReason !== undefined ? ` · dry${why}` : '';
  return `${state}${reload === undefined ? '' : ' · reloaded'}${unheard}`;
}

// A track names itself and its instrument; an instrument given by program
// names only itself.
export function armedName(armed: ArmedInstrument): string {
  const program = basename(armed.program, '.scd');
  return armed.track === undefined ? program : `${armed.track.split('/').pop()} (${program})`;
}

// The sounding notes come last, so playing changes only the end of the
// line and nothing after the notes moves as you play. A line wider than
// the terminal gives up the text before the notes, and the notes only
// when they alone are wider than it.
export function statusText(
  session: KeysSession,
  layout: KeyboardLayout | undefined,
  reloadError: string | undefined,
  width: number,
  knobError?: string,
): string {
  const parts = [SOURCE_NAME, session.keymap.name, `transpose ${signed(session.transpose)}`, `velocity ${session.velocity}`];
  const bends = session.bends();
  if (bends.length > 0 || session.bend !== 0) parts.push(`bend ${bendText(session.bend, bends)}`);
  // The knob line shows the wheel as the knob mod, when there is one.
  if (!session.bindsKnobs() && (session.setsMod() || session.mod !== 0)) parts.push(`mod ${session.mod}`);
  const unplayable = unplayablePositions(layout, session.keymap);
  if (unplayable.length > 0) parts.push(`${unplayable.join(', ')} cannot play on ${layout!.name}`);
  if (reloadError !== undefined) parts.push(`keymap not reloaded: ${reloadError}`);
  if (knobError !== undefined) parts.push(`knobs not reloaded: ${knobError}`);
  if (session.message !== undefined) parts.push(session.message);
  const sounding = session.soundingNotes();
  const notes = sounding.length > 0 ? sounding.join(' ') : '–';
  const head = parts.join(' · ');
  const separator = ' · ';
  if (head.length + separator.length + notes.length <= width) return `${head}${separator}${notes}`;
  const room = width - separator.length - notes.length - 1; // 1 for the ellipsis
  return room > 0 ? `${head.slice(0, room)}…${separator}${notes}` : notes.slice(0, width);
}

// A pitch-bend message carries the bend in steps of 1/8192, about 0.0001,
// so four decimal places show it as finely as it is sent.
const BEND_PLACES = 4;

// Every bend prints with its sign and with the decimal places the finest
// bend in the keymap needs, so bending a held chord does not move the
// notes after it.
function bendText(bend: number, bends: number[]): string {
  const places = Math.max(...[bend, ...bends].map(decimalPlaces));
  return `${bend < 0 ? '-' : '+'}${Math.abs(bend).toFixed(places)}`;
}

function decimalPlaces(x: number): number {
  let places = 0;
  while (places < BEND_PLACES && Number(x.toFixed(places)) !== x) places++;
  return places;
}

// The escapes that redraw the lines above the status line when they
// change, from the first that differs, leaving the cursor at the start of
// the status line's row. Fewer lines than before clears what is left
// below them.
export function redrawAbove(drawn: string[], lines: string[]): string {
  let from = 0;
  while (from < drawn.length && from < lines.length && drawn[from] === lines[from]) from++;
  if (from === drawn.length && from === lines.length) return '';
  const up = drawn.length - from;
  const rewrite = lines
    .slice(from)
    .map((line) => `\r\x1b[K${line}\n`)
    .join('');
  return `${up > 0 ? `\x1b[${up}A` : ''}${rewrite}${lines.length < drawn.length ? '\x1b[J' : ''}`;
}

const REVERSE = '\x1b[7m';
const REVERSE_OFF = '\x1b[27m';
const KNOB_GAP = '  ';
const MORE_LEFT = '‹ ';
const MORE_RIGHT = ' ›';

// The knob line (instrument-knobs.md §2.5): every knob's name and value,
// each value padded to the widest it prints, so turning a knob moves
// nothing after it, and the chosen knob in reverse video, which takes no
// columns. A line too wide for the terminal shows a window of whole knobs
// that holds the chosen one and moves only when the choice leaves it.
export class KnobLine {
  private first = 0;
  private readonly widths = new WeakMap<Knob, number>();

  text(session: KeysSession, width: number): string {
    const chosen = session.chosen;
    const cells = session.knobs.map(({ label, knob }, i) => {
      let valueWidth = this.widths.get(knob);
      if (valueWidth === undefined) this.widths.set(knob, (valueWidth = knobValueWidth(knob)));
      // An entry takes the value's place, in the units it is typed in,
      // and widens the knob only once it outgrows the value.
      const entry = i === chosen ? session.entry : undefined;
      const value =
        entry !== undefined
          ? `${entry.text}_${knob.units !== undefined ? ` ${knob.units}` : ''}`
          : formatKnobValue(knob, session.knobValue(knob));
      return `${label} ${value.padStart(valueWidth)}`;
    });
    const span = (from: number, to: number): number =>
      cells.slice(from, to + 1).reduce((sum, cell) => sum + cell.length, 0) +
      KNOB_GAP.length * (to - from) +
      (from > 0 ? MORE_LEFT.length : 0) +
      (to < cells.length - 1 ? MORE_RIGHT.length : 0);
    let first = Math.min(this.first, chosen);
    if (span(first, chosen) > width) {
      first = chosen;
      while (first > 0 && span(first - 1, chosen) <= width) first--;
    }
    let last = chosen;
    while (last + 1 < cells.length && span(first, last + 1) <= width) last++;
    this.first = first;
    const left = first > 0 ? MORE_LEFT : '';
    const right = last < cells.length - 1 ? MORE_RIGHT : '';
    const room = Math.max(0, width - left.length - right.length);
    const shown = cells.slice(first, last + 1).map((cell, i) => {
      const fitted = cell.slice(0, room);
      return first + i === chosen ? `${REVERSE}${fitted}${REVERSE_OFF}` : fitted;
    });
    return `${left}${shown.join(KNOB_GAP)}${right}`;
  }
}
