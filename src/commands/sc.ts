import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';
import { z } from 'zod';
import { AudiodClient } from '../audiod/client.js';
import { liveInputName } from '../audiod/live-inputs.js';
import { PPQ } from '../constants.js';
import { runScProgram, runSclang, scScript } from '../generators/supercollider.js';
import { KeysHelper } from '../keys/helper.js';
import { resolveKeysTargets, type ArmedInstrument } from '../keys/targets.js';
import { findProjectRoot, loadProject } from '../model/project.js';
import { KnobFiles, loadKnobSources } from '../sc/voice/knob-files.js';
import { VoiceHost } from '../sc/voice/host.js';
import { routeVoices, type Routing } from '../sc/voice/routing.js';
import { formatNotesFile, type TimedNotes } from '../schema/notes.js';
import { armedName, instrumentState, instrumentText } from './keys.js';

// `field sc render`: a program straight to a WAV, uncached, for
// iteration. A supercollider: entry is the cached form.
export async function scRender(
  program: string,
  options: { seed: number; duration: number; channels: number; output?: string },
): Promise<string> {
  const root = findProjectRoot(process.cwd());
  const sampleRate = (root !== undefined ? loadProject(root).manifest?.data.sample_rate : undefined) ?? 48000;
  const output = resolve(options.output ?? `${basename(program, extname(program))}.wav`);
  await runScProgram(resolve(program), output, {
    seed: options.seed,
    duration: options.duration,
    channels: options.channels,
    sampleRate,
  });
  if (!existsSync(output)) throw new Error('sc program exited without writing FIELD_OUTPUT');
  return `rendered ${output} (seed ${options.seed}, ${options.duration}s @ ${sampleRate} Hz)`;
}

export interface ScVoiceOptions {
  // The MIDI sources every voice plays from, by name; none means every
  // source but the Field Seq ones (sequencer.md §2.6).
  source: string[];
  device?: string;
}

// What a test hands `field sc voice` in place of the process's own.
export interface ScVoiceContext {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  // Settles when it should quit; otherwise Ctrl-C, SIGTERM, or SIGHUP.
  until?: Promise<void>;
  print?: (line: string) => void;
}

// `field sc voice` (sequencer.md §2.6): the targets' voices, as field keys
// plays them, from the MIDI sources named, with no keyboard. Each track's
// voice goes into the daemon as `voice:<song>/<track>`. It runs until it
// is told to quit, then closes its voices and inputs.
export async function scVoice(targets: string[], options: ScVoiceOptions, context: ScVoiceContext = {}): Promise<void> {
  const cwd = context.cwd ?? process.cwd();
  const env = context.env ?? process.env;
  const print = context.print ?? ((line: string) => process.stdout.write(`${line}\n`));
  const voices = resolveKeysTargets(targets, cwd, 'field sc voice');
  const root = findProjectRoot(cwd);
  // Every knob file is checked before anything starts.
  const knobFiles = new KnobFiles(loadKnobSources(voices, [], root));

  let quitting = false;
  let stop!: (error?: Error) => void;
  const stopped = new Promise<Error | undefined>((resolveStopped) => {
    stop = (error) => {
      quitting = true;
      resolveStopped(error);
    };
  });
  const onSignal = (): void => stop();
  if (context.until !== undefined) void context.until.then(onSignal);
  else for (const signal of SIGNALS) process.on(signal, onSignal);

  let routing: Routing | undefined;
  try {
    const device = options.device !== undefined ? { device: options.device } : {};
    const routed = root !== undefined ? await routeVoices(voices, root, { kind: 'voice', env, ...device }) : undefined;
    routing = routed !== undefined && 'programs' in routed ? routed : undefined;
    // Quit while the daemon answered: nothing has started yet.
    if (quitting) return;
    for (const voice of voices) print(voiceLine(voice, routing !== undefined, options.source));
    const state = instrumentState(voices, routing !== undefined, routed !== undefined && 'reason' in routed ? routed.reason : undefined)!;
    // A routed voice is heard on the daemon's device, so it is made there.
    const output = routing !== undefined ? routing.device : (options.device ?? (await systemOutput(root)));
    const programs = routing?.programs ?? [...new Set(voices.map((v) => v.program))];
    const host = await VoiceHost.start({
      instruments: programs,
      knobs: knobFiles.copies,
      ...(options.source.length > 0 ? { sources: programs.map(() => options.source) } : {}),
      ...(output !== undefined ? { device: output } : {}),
      ...(routing !== undefined ? { rings: routing.rings, fieldOut: routing.fieldOut } : {}),
      env,
      onStatus: (status) => {
        if (status.state === 'voice') return;
        if (status.state === 'reloaded') state.reload = { loaded: true };
        else if (status.state === 'reload-failed') state.reload = { failed: status.reason };
        else state.status = status;
        print(instrumentText(state));
      },
      onExit: (reason) => stop(new Error(`the voice host stopped: ${reason}`)),
    });
    host.ready.catch((err: Error) => stop(new Error(`the voice host did not start: ${err.message}`)));
    // A route scsynth never ran, because FieldOut did not load in it,
    // leaves its ring empty, and the voice is then nowhere.
    if (routed !== undefined && 'programs' in routed) {
      void host.ready
        .then(() => routed.flowing())
        .then((flowing) => {
          if (flowing || quitting) return;
          state.silent = 'FieldOut did not load in scsynth, so nothing reaches the daemon';
          print(instrumentText(state));
        })
        .catch(() => {});
    }
    const stopWatchingPrograms = host.reloadOnSave();
    const stopWatchingKnobs = knobFiles.watch((path, result, reload) => {
      if ('error' in result) print(`knobs not reloaded: ${knobFiles.errors.get(path)}`);
      if (reload) void host.reload();
    });
    const error = await stopped;
    stopWatchingPrograms();
    stopWatchingKnobs();
    // A host still booting closes too: quitting never waits for it.
    await host.close();
    if (error !== undefined) throw error;
  } finally {
    for (const signal of SIGNALS) process.removeListener(signal, onSignal);
    await routing?.close();
    knobFiles.remove();
  }
}

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

// One voice, the sources it plays from, and where it goes.
function voiceLine(voice: ArmedInstrument, routed: boolean, sources: string[]): string {
  const from = sources.length > 0 ? sources.join(', ') : 'every MIDI source but the Field Seq ones';
  const [song, track] = voice.track?.split('/') ?? [];
  const to = routed && song !== undefined && track !== undefined ? liveInputName('voice', song, track) : 'the device';
  return `voice  ${armedName(voice)} · from ${from} → ${to}`;
}

// The system output, as the daemon lists it or, with no daemon to answer,
// as `field-audiod --keys` reports it. scsynth given no device opens the
// default input as well, and waits on the microphone permission
// (keyboard-instrument.md §10.1), so a voice that plays straight to the
// device names its output.
async function systemOutput(root: string | undefined): Promise<string | undefined> {
  return (root !== undefined ? await daemonOutput(root) : undefined) ?? (await helperOutput());
}

async function daemonOutput(root: string): Promise<string | undefined> {
  try {
    const client = await AudiodClient.connect(root);
    try {
      return (await client.devices()).devices.find((d) => d.default)?.name;
    } finally {
      client.close();
    }
  } catch {
    return undefined;
  }
}

// The helper publishes a MIDI source while it runs, so it closes before
// the host lists the sources. Where it cannot run, as on Windows, the host
// starts with no device.
async function helperOutput(): Promise<string | undefined> {
  try {
    const helper = await KeysHelper.start('Field Voice');
    await helper.close();
    return helper.defaultOutput;
  } catch {
    return undefined;
  }
}

// What sc/notes-render.scd writes: each note as the pattern spelled it.
const patternNotes = z.object({
  notes: z.array(z.tuple([z.number(), z.number(), z.number(), z.number(), z.number()])),
});

// `field sc notes` (sequencer.md §2.8): the pattern a program answers
// under FIELD_MODE=notes, played under the seed for `beats` quarter notes
// with no server, as a part in ticks. Its first line names the command,
// so the same command writes the same bytes.
export async function scNotes(program: string, options: { seed: number; beats: number }): Promise<string> {
  const path = resolve(program);
  if (!existsSync(path)) throw new Error(`field sc notes ${program}: no program at ${path}`);
  const dir = mkdtempSync(join(tmpdir(), 'field-sc-notes-'));
  try {
    const output = join(dir, 'notes.json');
    await runSclang(
      scScript('notes-render.scd'),
      {
        ...process.env,
        FIELD_MODE: 'notes',
        FIELD_PROGRAM: path,
        FIELD_SEED: String(options.seed),
        FIELD_BEATS: String(options.beats),
        FIELD_OUTPUT: output,
      },
      120_000,
      program,
    );
    if (!existsSync(output)) throw new Error(`sclang exited without writing the notes of ${program}`);
    const { notes } = patternNotes.parse(JSON.parse(readFileSync(output, 'utf8')));
    const command = `field sc notes ${shellWord(program)} --seed ${options.seed} --beats ${options.beats}`;
    return `# ${command}\n${formatNotesFile(partFrom(notes, options.beats, program))}`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// A pattern counts in quarter notes and its `chan` from 0. A note's
// velocity is its `amp` times 127, as the voice host plays a velocity at
// `amp` velocity / 127, so a part plays back at the pattern's level.
function partFrom(rows: z.infer<typeof patternNotes>['notes'], beats: number, program: string): TimedNotes {
  const ticks = (beat: number): number => Math.round(beat * PPQ);
  const notes = rows.map(([beat, sustain, midinote, amp, chan]) => {
    const note = Math.round(midinote);
    const channel = Math.round(chan) + 1;
    if (note < 0 || note > 127) throw new Error(`${program}: the pattern plays note ${note} at beat ${beat}, outside MIDI's 0 to 127`);
    if (channel < 1 || channel > 16) throw new Error(`${program}: the pattern plays on chan ${chan} at beat ${beat}, outside MIDI's 0 to 15`);
    const at = ticks(beat);
    const velocity = Math.min(127, Math.max(1, Math.round(amp * 127)));
    return { at, length: Math.max(0, ticks(beat + sustain) - at), note, velocity, ...(channel !== 1 ? { channel } : {}) };
  });
  notes.sort((a, b) => a.at - b.at || a.note - b.note || (a.channel ?? 1) - (b.channel ?? 1));
  return { length: ticks(beats), notes, controls: [], bends: [] };
}

// A word as a shell reads it back: quoted only when it has to be.
function shellWord(word: string): string {
  return /^[\w./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}
