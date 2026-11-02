import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { builtinKeymapDir, loadKeymap, parseKeymap } from '../keys/keymap.js';
import { knobList, loadKnobs } from '../keys/knobs.js';
import { KeysSession } from '../keys/session.js';
import { BUILD_DAEMON } from '../remedies.js';
import { instrumentState, instrumentText, KnobLine, redrawAbove, statusText } from './keys.js';

// field keys' status line: the sounding notes come last, so playing
// changes only the end of the line, and a narrow terminal shortens what
// comes before them instead of the notes.

function musical(): KeysSession {
  return new KeysSession(loadKeymap(join(builtinKeymapDir(), 'musical.yaml')));
}

const shelf = join(import.meta.dirname, '..', '..', 'examples', 'bloom', 'shared', 'instruments');
const juno = loadKnobs(join(shelf, 'juno.knobs.yaml'));

// What a line shows, without the escapes that put a knob in reverse video.
const plain = (line: string): string => line.replace(/\x1b\[\d+m/g, '');

function tap(session: KeysSession, position: string, times = 1): void {
  for (let i = 0; i < times; i++) {
    session.press(position);
    session.release(position);
  }
}

describe('the status line', () => {
  it('ends with the sounding notes, after anything else it has to say', () => {
    const session = musical();
    expect(statusText(session, undefined, undefined, 200)).toBe('Field Keys · musical · transpose 0 · velocity 100 · bend +0 · –');
    session.press('KeyA');
    session.press('KeyD');
    expect(statusText(session, undefined, 'KeyA is both a note and a control', 300, 'juno.knobs.yaml: knobs.1.cc: res: cc 1 is the modulation wheel')).toBe(
      'Field Keys · musical · transpose 0 · velocity 100 · bend +0 · keymap not reloaded: KeyA is both a note and a control · ' +
        'knobs not reloaded: juno.knobs.yaml: knobs.1.cc: res: cc 1 is the modulation wheel · C4 E4',
    );
  });

  it('shows the modulation wheel where the keymap can set it and has no knob line to show it', () => {
    const session = new KeysSession(parseKeymap('name: wheel\nnotes: { KeyA: 0 }\ncontrols: { Digit6: { cc: 1, value: 76 } }\n', 'w.yaml'));
    session.press('Digit6');
    session.release('Digit6');
    expect(statusText(session, undefined, undefined, 200)).toBe('Field Keys · wheel · transpose 0 · velocity 100 · mod 76 · –');
    const tracker = new KeysSession(loadKeymap(join(builtinKeymapDir(), 'tracker.yaml')));
    expect(statusText(tracker, undefined, undefined, 200)).not.toMatch(/bend|mod/);
    const turned = musical();
    turned.press('ArrowUp');
    expect(statusText(turned, undefined, undefined, 200)).not.toMatch(/mod/);
  });

  it('shows the pitch bend while a bend key is held, at the same width', () => {
    const session = musical();
    session.press('KeyA');
    const rest = statusText(session, undefined, undefined, 200);
    session.press('Comma');
    const bent = statusText(session, undefined, undefined, 200);
    expect(bent).toBe('Field Keys · musical · transpose 0 · velocity 100 · bend -1 · C4');
    expect(bent).toHaveLength(rest.length);
    session.release('Comma');
    expect(statusText(session, undefined, undefined, 200)).toBe(rest);
  });

  it('prints every bend with the decimal places of the finest bend in the keymap', () => {
    const session = new KeysSession(
      parseKeymap('name: t\nnotes: { KeyA: 0 }\ncontrols: { Digit1: { bend: -1 }, Digit2: { bend: 0.25 } }\n', 't.yaml'),
    );
    session.press('KeyA');
    expect(statusText(session, undefined, undefined, 200)).toBe('Field Keys · t · transpose 0 · velocity 100 · bend +0.00 · C4');
    session.press('Digit2');
    expect(statusText(session, undefined, undefined, 200)).toBe('Field Keys · t · transpose 0 · velocity 100 · bend +0.25 · C4');
    session.release('Digit2');
    session.press('Digit1');
    expect(statusText(session, undefined, undefined, 200)).toBe('Field Keys · t · transpose 0 · velocity 100 · bend -1.00 · C4');
    const third = new KeysSession(parseKeymap('name: t\nnotes: { KeyA: 0 }\ncontrols: { Digit1: { bend: 0.333333 } }\n', 't.yaml'));
    third.press('Digit1');
    expect(statusText(third, undefined, undefined, 200)).toBe('Field Keys · t · transpose 0 · velocity 100 · bend +0.3333 · –');
  });

  it('shortens the text before the notes to fit, never the notes', () => {
    const session = musical();
    session.press('KeyA');
    session.press('KeyD');
    const line = statusText(session, undefined, undefined, 26);
    expect(line).toBe('Field Keys · musi… · C4 E4');
    expect(line).toHaveLength(26);
  });
});

describe('the instrument line', () => {
  const live = { state: 'live' as const, device: 'MacBook Pro Speakers', sampleRate: 48000 };
  // The reason routeVoices gives without FieldOut: field keys runs in a
  // song project, so it names the command that builds it from there.
  const notBuilt = `FieldOut is not built: run ${BUILD_DAEMON}`;

  it('names each armed track and its instrument, and an instrument given by program alone', () => {
    const state = instrumentState([
      { program: '/p/shared/instruments/juno.scd', track: 'creek/keys', unheardEffects: [] },
      { program: '/p/shared/instruments/bass.scd', track: 'creek/bass', unheardEffects: [] },
      { program: '/p/shared/instruments/pad.scd', unheardEffects: [] },
    ])!;
    expect(instrumentText({ ...state, status: live })).toBe(
      'keys (juno) + bass (bass) + pad live at 48000 Hz on MacBook Pro Speakers',
    );
  });

  it('ends with the effects not heard, each once, and why when routing them was not possible', () => {
    const armed = [
      { program: '/p/juno.scd', track: 'creek/keys', unheardEffects: ['keys-bus'] },
      { program: '/p/bass.scd', track: 'creek/bass', unheardEffects: ['keys-bus', 'band'] },
    ];
    const state = instrumentState(armed)!;
    expect(instrumentText({ ...state, status: live })).toBe(
      'keys (juno) + bass (bass) live at 48000 Hz on MacBook Pro Speakers · dry: the effects on keys-bus, band are not heard',
    );
    expect(instrumentText({ ...instrumentState(armed, false, notBuilt)!, status: live })).toBe(
      `keys (juno) + bass (bass) live at 48000 Hz on MacBook Pro Speakers · dry: the effects on keys-bus, band are not heard (${notBuilt})`,
    );
    // A route that failed says why even with no effects to name.
    expect(
      instrumentText({
        ...instrumentState([{ program: '/p/bass.scd', track: 'creek/bass', unheardEffects: [] }], false, notBuilt)!,
        status: live,
      }),
    ).toBe(`bass (bass) live at 48000 Hz on MacBook Pro Speakers · dry (${notBuilt})`);
    // Routed, but scsynth never ran the route: nothing is heard at all.
    expect(instrumentText({ ...instrumentState(armed, true)!, silent: 'FieldOut did not load', status: live })).toBe(
      'keys (juno) + bass (bass) is silent: FieldOut did not load',
    );
    // Routed through the daemon, the voices pass through every effect.
    expect(instrumentText({ ...instrumentState(armed, true, 'unused')!, status: live })).toBe(
      'keys (juno) + bass (bass) live at 48000 Hz on MacBook Pro Speakers',
    );
    expect(instrumentText({ ...state, status: live, reload: { failed: 'juno.scd does not compile' } })).toBe(
      'keys (juno) + bass (bass) kept its last voice: juno.scd does not compile',
    );
  });
});

describe('the knob line', () => {
  const withJuno = (): KeysSession => new KeysSession(loadKeymap(join(builtinKeymapDir(), 'musical.yaml')), knobList([{ name: 'juno', knobs: juno }]));

  it('shows every knob at its default, with the chosen one in reverse video', () => {
    const line = new KnobLine().text(withJuno(), 200);
    expect(line).toBe('\x1b[7mmod   0\x1b[27m  cutoff 2.00 kHz  res 0.300  attack  800 ms  release  1.50 s');
  });

  it('keeps its length through a turn, and moves the reverse video with the choice', () => {
    const session = withJuno();
    const knobLine = new KnobLine();
    const rest = plain(knobLine.text(session, 200));
    tap(session, 'ArrowRight');
    tap(session, 'ArrowDown', 100);
    const turned = knobLine.text(session, 200);
    expect(turned).toBe('mod   0  \x1b[7mcutoff  50.0 Hz\x1b[27m  res 0.300  attack  800 ms  release  1.50 s');
    expect(plain(turned)).toHaveLength(rest.length);
    tap(session, 'ArrowUp');
    expect(plain(knobLine.text(session, 200))).toBe('mod   0  cutoff  52.3 Hz  res 0.300  attack  800 ms  release  1.50 s');
  });

  it('names each knob after its source when knobs come from several', () => {
    const session = new KeysSession(
      loadKeymap(join(builtinKeymapDir(), 'musical.yaml')),
      knobList([
        { name: 'keys', knobs: juno.slice(0, 1) },
        { name: 'bass', knobs: loadKnobs(join(shelf, 'bass.knobs.yaml')).slice(0, 1) },
      ]),
    );
    expect(plain(new KnobLine().text(session, 200))).toBe('mod   0  keys.cutoff 2.00 kHz  bass.cutoff 1.20 kHz');
    tap(session, 'ArrowRight');
    tap(session, 'ArrowUp');
    // Two knobs on one controller share its value, each through its own range.
    expect(plain(new KnobLine().text(session, 200))).toBe('mod   0  keys.cutoff 2.08 kHz  bass.cutoff 2.08 kHz');
  });

  it('shows a window of whole knobs on a narrow terminal, which moves only when the choice leaves it', () => {
    const session = withJuno();
    const knobLine = new KnobLine();
    expect(plain(knobLine.text(session, 40))).toBe('mod   0  cutoff 2.00 kHz  res 0.300 ›');
    tap(session, 'ArrowRight', 2);
    expect(plain(knobLine.text(session, 40))).toBe('mod   0  cutoff 2.00 kHz  res 0.300 ›');
    tap(session, 'ArrowRight');
    expect(plain(knobLine.text(session, 40))).toBe('‹ res 0.300  attack  800 ms ›');
    tap(session, 'ArrowUp', 5);
    expect(plain(knobLine.text(session, 40))).toBe('‹ res 0.300  attack  1.02 s ›');
    tap(session, 'ArrowLeft');
    expect(plain(knobLine.text(session, 40))).toBe('‹ res 0.300  attack  1.02 s ›');
    tap(session, 'ArrowLeft');
    expect(plain(knobLine.text(session, 40))).toBe('‹ cutoff 2.00 kHz  res 0.300 ›');
    tap(session, 'ArrowLeft', 2);
    expect(plain(knobLine.text(session, 40))).toBe('‹ attack  1.02 s  release  1.50 s');
  });

  it('cuts a knob wider than the terminal, never the markers, so the line never wraps', () => {
    const session = withJuno();
    tap(session, 'ArrowRight');
    expect(plain(new KnobLine().text(session, 16))).toBe('‹ cutoff 2.00  ›');
    for (let choice = 0; choice < session.knobs.length; choice++) {
      for (let width = 8; width <= 40; width++) {
        expect(plain(new KnobLine().text(session, width)).length).toBeLessThanOrEqual(width);
      }
      tap(session, 'ArrowRight');
    }
  });
});

describe('typing on the knob line', () => {
  const onCutoff = (): KeysSession => {
    const session = new KeysSession(loadKeymap(join(builtinKeymapDir(), 'musical.yaml')), knobList([{ name: 'juno', knobs: juno }]));
    tap(session, 'ArrowRight');
    return session;
  };

  it('shows an entry in the value’s place, in the knob’s units, at the value’s width', () => {
    const session = onCutoff();
    const knobLine = new KnobLine();
    const rest = plain(knobLine.text(session, 200));
    tap(session, 'Digit8');
    tap(session, 'Digit0');
    tap(session, 'Digit0');
    const typing = knobLine.text(session, 200);
    expect(typing).toBe('mod   0  \x1b[7mcutoff  800_ Hz\x1b[27m  res 0.300  attack  800 ms  release  1.50 s');
    expect(plain(typing)).toHaveLength(rest.length);
  });

  it('widens the knob only while an entry outgrows its value', () => {
    const session = onCutoff();
    for (let i = 0; i < 6; i++) tap(session, 'Digit1');
    expect(plain(new KnobLine().text(session, 200))).toBe('mod   0  cutoff 111111_ Hz  res 0.300  attack  800 ms  release  1.50 s');
    tap(session, 'Escape');
    expect(plain(new KnobLine().text(session, 200))).toBe('mod   0  cutoff 2.00 kHz  res 0.300  attack  800 ms  release  1.50 s');
  });

  it('keeps its length through a glide', () => {
    const session = onCutoff();
    const knobLine = new KnobLine();
    const rest = plain(knobLine.text(session, 200));
    tap(session, 'Digit5');
    tap(session, 'Digit0');
    tap(session, 'Enter');
    const lengths = new Set<number>();
    let now = performance.now();
    while (session.ticking()) {
      session.tick((now += 40));
      lengths.add(plain(knobLine.text(session, 200)).length);
    }
    expect([...lengths]).toEqual([rest.length]);
    expect(plain(knobLine.text(session, 200))).toBe('mod   0  cutoff  50.0 Hz  res 0.300  attack  800 ms  release  1.50 s');
  });

  it('says Ctrl-C quits on Escape with no entry open', () => {
    const session = onCutoff();
    tap(session, 'Escape');
    expect(statusText(session, undefined, undefined, 200)).toBe('Field Keys · musical · transpose 0 · velocity 100 · bend +0 · Ctrl-C quits · –');
  });
});

describe('redrawing the lines above the status line', () => {
  it('draws them all the first time, then only from the first that changed', () => {
    expect(redrawAbove([], ['juno starting', 'mod   0'])).toBe('\r\x1b[Kjuno starting\n\r\x1b[Kmod   0\n');
    expect(redrawAbove(['juno starting', 'mod   0'], ['juno starting', 'mod   0'])).toBe('');
    expect(redrawAbove(['juno starting', 'mod   0'], ['juno starting', 'mod   1'])).toBe('\x1b[1A\r\x1b[Kmod   1\n');
    expect(redrawAbove(['juno starting', 'mod   0'], ['juno live', 'mod   0'])).toBe('\x1b[2A\r\x1b[Kjuno live\n\r\x1b[Kmod   0\n');
  });

  it('clears what is left below when a line goes', () => {
    expect(redrawAbove(['juno live', 'mod   0'], ['juno live'])).toBe('\x1b[1A\x1b[J');
    expect(redrawAbove(['juno live'], ['juno live', 'mod   0'])).toBe('\r\x1b[Kmod   0\n');
  });
});
