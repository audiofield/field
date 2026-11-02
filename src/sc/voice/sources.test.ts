import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sclangCommand, scScript } from '../../generators/supercollider.js';

// sc/voice-sources.scd through real sclang (sequencer.md §2.6): which
// voices hear each MIDI source. The sources are made up here, endpoints
// as MIDIClient.sources lists them, so the test publishes no MIDI.

const sclang = (() => {
  try {
    return sclangCommand();
  } catch {
    return undefined;
  }
})();

// The machine's sources in these tests: Field Keys, a track's Field Seq
// source, and a controller whose port is named apart from its device.
const ENDPOINTS = [
  ['Field Keys', 'Field Keys', 11],
  ['Field Seq creek/keys', 'Field Seq creek/keys', 22],
  ['Arturia KeyStep 37', 'KeyStep 37', 33],
] as const;

// Which voices hear each source, by uid, and the problem, for the voices
// as FIELD_INSTRUMENTS spells them.
function hearing(voices: object[], endpoints: readonly (readonly [string, string, number])[] = ENDPOINTS): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'field-voice-sources-'));
  try {
    const script = join(dir, 'sources-probe.scd');
    writeFileSync(
      script,
      [
        '(',
        `var playsFrom = thisProcess.interpreter.executeFile(${JSON.stringify(scScript('voice-sources.scd'))});`,
        `var endpoints = [${endpoints.map(([device, name, uid]) => `MIDIEndPoint(${JSON.stringify(device)}, ${JSON.stringify(name)}, ${uid})`).join(', ')}];`,
        `var voices = ${JSON.stringify(JSON.stringify(voices))}.parseJSON;`,
        'var hearing, problem;',
        '# hearing, problem = playsFrom.(voices, endpoints);',
        'endpoints.do { |e| ("hears " ++ e.uid ++ " " ++ (hearing[e.uid] ? []).join(",")).postln };',
        '("problem " ++ problem).postln;',
        '0.exit;',
        ')',
        '',
      ].join('\n'),
    );
    const run = spawnSync(sclang!, [script], { encoding: 'utf8', timeout: 60_000 });
    return run.stdout.split('\n').filter((line) => /^(hears|problem) /.test(line));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(sclang === undefined)('the sources each voice plays from, through real sclang', () => {
  it('plays a voice with no sources named, as field keys gives, from every source but the Field Seq ones', { timeout: 60_000 }, () => {
    expect(hearing([{ program: '/p/juno.scd' }, { program: '/p/pad.scd' }])).toEqual([
      'hears 11 0,1',
      'hears 22 ',
      'hears 33 0,1',
      'problem nil',
    ]);
  });

  it('plays a voice with sources named from those alone, by name or by device', { timeout: 60_000 }, () => {
    expect(
      hearing([
        { program: '/p/juno.scd', sources: ['Field Keys'] },
        { program: '/p/pad.scd', sources: ['Field Seq creek/keys'] },
        { program: '/p/bass.scd', sources: ['Arturia KeyStep 37'] },
        { program: '/p/organ.scd' },
      ]),
    ).toEqual(['hears 11 0,3', 'hears 22 1', 'hears 33 2,3', 'problem nil']);
  });

  it('names a source a voice names that is not there, and the sources that are', { timeout: 60_000 }, () => {
    expect(hearing([{ program: '/p/juno.scd', sources: ['Minilogue XD'] }]).at(-1)).toBe(
      'problem no MIDI source named Minilogue XD; the sources are Field Keys, Field Seq creek/keys, KeyStep 37',
    );
    expect(hearing([{ program: '/p/juno.scd', sources: ['Field Keys'] }], [])).toEqual([
      'problem no MIDI source named Field Keys; the sources are none',
    ]);
  });
});
