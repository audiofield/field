import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  knobFileFor,
  knobFileName,
  knobList,
  knobsCopy,
  loadKnobs,
  resolveKnobsPath,
  watchKnobs,
  type KnobsReload,
  type ShownKnob,
} from '../../keys/knobs.js';
import type { Knob } from '../../schema/knobs.js';
import type { Voice } from './routing.js';

// A knob file a session reads (instrument-knobs.md §2.2): a voice's, which
// the voice maps through, or one `field keys --knobs` names, for whatever
// else listens to Field Keys.
export interface KnobSource {
  name: string; // what the knob line puts before its knobs' names
  path: string;
  program?: string; // the instrument whose voice reads it
  knobs: Knob[];
}

// A session's knob files, and the copies its voices read: each voice
// reads the copy of its knob file that passed the schema, never the file
// itself, so a save that fails cannot reach it (instrument-knobs.md §2.4).
// The copies live in a directory of their own for the session.
export class KnobFiles {
  // Each program with a knob file, and the copy its voice reads.
  readonly copies = new Map<string, string>();
  // Why the last save of each file did not load, by path.
  readonly errors = new Map<string, string>();
  private dir: string | undefined;

  constructor(private readonly sources: KnobSource[]) {
    sources.forEach((source) => this.write(source));
  }

  paths(): string[] {
    return [...new Set(this.sources.map((s) => s.path))];
  }

  list(): ShownKnob[] {
    return knobList(this.sources);
  }

  // A save that passes takes the file's new knobs and rewrites the copy
  // of each voice that reads it; one that fails changes nothing but its
  // error. Answers whether a voice reads the file, and so must reload.
  saved(path: string, result: KnobsReload): boolean {
    if ('error' in result) {
      this.errors.set(path, `${basename(path)}: ${result.error.problems[0]}`);
      return false;
    }
    this.errors.delete(path);
    const changed = this.sources.filter((s) => s.path === path);
    for (const source of changed) {
      source.knobs = result.knobs;
      this.write(source);
    }
    return changed.some((s) => s.program !== undefined);
  }

  // Takes each save of every file through `saved`, then tells `onSave`
  // which file it was, what the save did, and whether a voice must
  // reload.
  watch(onSave: (path: string, result: KnobsReload, reload: boolean) => void): () => void {
    const stops = this.paths().map((path) => watchKnobs(path, (result) => onSave(path, result, this.saved(path, result))));
    return () => stops.forEach((stop) => stop());
  }

  remove(): void {
    if (this.dir !== undefined) rmSync(this.dir, { recursive: true, force: true });
  }

  private write({ program, path, knobs }: KnobSource): void {
    if (program === undefined) return;
    this.dir ??= mkdtempSync(join(tmpdir(), 'field-knobs-'));
    const copy = this.copies.get(program) ?? join(this.dir, `${this.copies.size}-${basename(path)}`);
    writeFileSync(copy, knobsCopy(knobs));
    this.copies.set(program, copy);
  }
}

// The knob file beside each voice's program, where it has one, then each
// file `specs` names.
export function loadKnobSources(voices: readonly Voice[], specs: string[], root: string | undefined): KnobSource[] {
  const sources: KnobSource[] = [];
  for (const { program, track } of voices) {
    const path = knobFileFor(program);
    if (!existsSync(path)) continue;
    sources.push({ name: track?.split('/').pop() ?? basename(program, '.scd'), path, program, knobs: loadKnobs(path) });
  }
  for (const spec of specs) {
    const path = resolveKnobsPath(spec, root);
    sources.push({ name: knobFileName(path), path, knobs: loadKnobs(path) });
  }
  return sources;
}
