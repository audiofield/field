import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { sha256File } from '../hash.js';
import { knobFileFor, knobsCopy, KnobsError, loadKnobs } from '../keys/knobs.js';
import { renderEvents, type ResolvedNotes } from '../schema/notes.js';
import { instrumentProgram, runScProgram, scScript } from './supercollider.js';
import type { Generator, ValidateContext } from './types.js';

// voice-render: notes rendered offline through their track's instrument
// (keyboard-instrument.md §12.3, sequencer.md §2.3). The graph mints one
// for each `notes:` entry and for each record entry whose chosen take is
// MIDI. sc/voice-render.scd loads the instrument's voice and drives it
// with sc/voicer.scd, the voicing the live host plays with, so a take
// renders as it sounded while it was played. An instrument with a knob
// file maps its controllers through it (instrument-knobs.md §2.4), so the
// file decides the sound too: it is checked here, hashed as an input, and
// handed to the voice as the copy that passed.
//
// The render is keyed on `events`, the notes resolved for the placement
// from its start (src/time/notes.ts), so a tempo edit renders it again
// and two placements that resolve alike are one render. The notes file
// is an input by its hash too, so `field explain` names it and a take
// copied into a part has the take's key: a take is a source, and the
// build refuses one whose pinned bytes changed; a part is hashed in
// place.
export interface VoiceRenderSpec {
  name: string;
  type: 'voice-render';
  take?: string; // a MIDI take's name in the song's ledger
  part?: string; // or a part's project-relative path
  instrument: string; // resolves as field keys resolves an instrument
  events: ResolvedNotes;
}

// Rendered past the notes' end, so the last notes' release is heard. A
// fixed tail rather than one per instrument: the voice contract carries no
// release time.
export const RELEASE_TAIL_SECONDS = 4;

const HARNESS = ['voice-render.scd', 'voice-load.scd', 'voicer.scd'];

// The supercollider rule's path checks, on the program the instrument
// names: normalized, inside the project, and a regular file; and the
// knob file's schema, the check field keys runs, when it has one.
export function validateInstrument(instrument: string, ctx: Pick<ValidateContext, 'root' | 'push' | 'resolveFile'>): void {
  const program = instrumentProgram(instrument);
  if (program !== posix.normalize(program) || program.includes('\\')) {
    ctx.push(`instrument path not in normalized form: ${instrument}`);
    return;
  }
  const resolved = ctx.resolveFile('', program); // project-relative
  if (resolved.problem) {
    ctx.push(`instrument ${resolved.problem}`);
    return;
  }
  const knobs = knobFileFor(program);
  if (!existsSync(join(ctx.root, knobs))) return;
  try {
    loadKnobs(join(ctx.root, knobs));
  } catch (err) {
    if (!(err instanceof KnobsError)) throw err;
    for (const problem of err.problems) ctx.push(`${knobs}: ${problem}`);
  }
}

export const voiceRenderGenerator: Generator<VoiceRenderSpec> = {
  version: 3, // 3: keyed on the resolved events
  wiringFields: ['take', 'part'],

  sources(spec) {
    return spec.take !== undefined ? [spec.take] : [];
  },

  validate(spec, ctx) {
    validateInstrument(spec.instrument, ctx);
  },

  // The part, the instrument, its knob file, and Field's own harness all
  // decide the sound, so editing any of them renders the notes again. The
  // part comes first, where a take's hash sits among the inputs.
  async extraInputs(root, spec) {
    const program = instrumentProgram(spec.instrument);
    const knobs = knobFileFor(program);
    return [
      ...(spec.part !== undefined ? [{ label: spec.part, sha256: await sha256File(join(root, spec.part)) }] : []),
      { label: program, sha256: await sha256File(join(root, program)) },
      ...(existsSync(join(root, knobs)) ? [{ label: knobs, sha256: await sha256File(join(root, knobs)) }] : []),
      ...(await Promise.all(HARNESS.map(async (name) => ({ label: `sc/${name}`, sha256: await sha256File(scScript(name)) })))),
    ];
  },

  async execute(spec, _inputPaths, outputPath, ctx) {
    const eventsPath = `${outputPath}.events.json`;
    writeFileSync(eventsPath, JSON.stringify({ events: renderEvents(spec.events) }));
    const knobFile = join(ctx.root, knobFileFor(instrumentProgram(spec.instrument)));
    const knobsPath = existsSync(knobFile) ? `${outputPath}.knobs.yaml` : undefined;
    try {
      if (knobsPath !== undefined) writeFileSync(knobsPath, knobsCopy(loadKnobs(knobFile)));
      await runScProgram(scScript('voice-render.scd'), outputPath, {
        seed: 0,
        duration: spec.events.length / spec.events.sample_rate + RELEASE_TAIL_SECONDS,
        channels: 2,
        sampleRate: ctx.sampleRate,
        env: {
          FIELD_MODE: 'voice',
          FIELD_INSTRUMENT: join(ctx.root, instrumentProgram(spec.instrument)),
          FIELD_EVENTS: eventsPath,
          ...(knobsPath !== undefined ? { FIELD_KNOBS: knobsPath } : {}),
        },
      });
    } finally {
      rmSync(eventsPath, { force: true });
      if (knobsPath !== undefined) rmSync(knobsPath, { force: true });
    }
    if (!existsSync(outputPath)) {
      throw new Error(`rendering ${spec.take ?? spec.part} through ${spec.instrument} wrote no audio`);
    }
  },

  // The render reads the instrument and its knob file while it runs, and
  // the notes not at all: they are in the spec, as keyed.
  async verifyAfterRun(root, spec, extraInputs) {
    const program = instrumentProgram(spec.instrument);
    const after = await sha256File(join(root, program));
    if (after !== extraInputs.find((input) => input.label === program)?.sha256) {
      throw new Error(`refusing to cache: ${spec.instrument} changed during the render — re-run the build`);
    }
    const knobs = knobFileFor(program);
    const knobsAfter = existsSync(join(root, knobs)) ? await sha256File(join(root, knobs)) : undefined;
    if (knobsAfter !== extraInputs.find((input) => input.label === knobs)?.sha256) {
      throw new Error(`refusing to cache: ${knobs} changed during the render — re-run the build`);
    }
  },
};
