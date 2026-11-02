import { describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';
import { canonicalText } from '../yaml/emit.js';
import { formatNotesFile, noteNumber, notesFileOrder, notesFileSchema, notesFromMessages, renderEvents } from './notes.js';

describe('pairing captured messages into notes', () => {
  it('pairs each note-on with its note-off, by channel and note', () => {
    const file = notesFromMessages(
      [
        { at: 0, midi: [144, 60, 100] },
        { at: 12000, midi: [145, 60, 90] },
        { at: 24000, midi: [128, 60, 0] },
        { at: 30000, midi: [129, 60, 0] },
      ],
      48000,
    );
    expect(file.notes).toEqual([
      { at: 0, length: 24000, note: 60, velocity: 100 },
      { at: 12000, length: 18000, note: 60, velocity: 90, channel: 2 },
    ]);
  });

  it('takes a note-on with velocity 0 as a note-off', () => {
    const file = notesFromMessages([{ at: 0, midi: [144, 62, 80] }, { at: 100, midi: [144, 62, 0] }], 200);
    expect(file.notes).toEqual([{ at: 0, length: 100, note: 62, velocity: 80 }]);
  });

  it('ends a sounding note when the same note starts again', () => {
    const file = notesFromMessages(
      [
        { at: 0, midi: [144, 60, 100] },
        { at: 500, midi: [144, 60, 70] },
        { at: 900, midi: [128, 60, 0] },
      ],
      1000,
    );
    expect(file.notes).toEqual([
      { at: 0, length: 500, note: 60, velocity: 100 },
      { at: 500, length: 400, note: 60, velocity: 70 },
    ]);
  });

  it('lets a note held at the end last to the end, and drops a note-off with no note-on', () => {
    const file = notesFromMessages([{ at: 10, midi: [128, 64, 0] }, { at: 100, midi: [144, 67, 90] }], 1000);
    expect(file.notes).toEqual([{ at: 100, length: 900, note: 67, velocity: 90 }]);
  });

  it('keeps controller changes and bends, and ignores other messages', () => {
    const file = notesFromMessages(
      [
        { at: 5, midi: [176, 64, 127] },
        { at: 6, midi: [224, 0, 96] },
        { at: 7, midi: [177, 1, 51] },
        { at: 8, midi: [192, 3] },
        { at: 9, midi: [248] },
      ],
      10,
    );
    expect(file).toEqual({
      length: 10,
      notes: [],
      controls: [
        { at: 5, cc: 64, value: 127 },
        { at: 7, cc: 1, value: 51, channel: 2 },
      ],
      bends: [{ at: 6, value: 96 << 7 }],
    });
  });
});

describe('the notes file', () => {
  const file = notesFromMessages(
    [
      { at: 0, midi: [144, 60, 100] },
      { at: 480, midi: [145, 64, 90] },
      { at: 960, midi: [128, 60, 0] },
      { at: 1200, midi: [176, 64, 127] },
      { at: 2000, midi: [224, 0, 96] },
    ],
    2400,
  );

  it('writes a take in ticks, one row per note, in a fixed key order', () => {
    expect(formatNotesFile(file)).toBe(
      [
        'length: 2400',
        'notes:',
        '  - {at: 0, length: 960, note: 60, velocity: 100}',
        '  - {at: 480, length: 1920, note: 64, velocity: 90, channel: 2}',
        'controls:',
        '  - {at: 1200, cc: 64, value: 127}',
        'bends:',
        '  - {at: 2000, value: 12288}',
        '',
      ].join('\n'),
    );
  });

  it('reads back as the notes it was written from', () => {
    expect(notesFileSchema.parse(parseDocument(formatNotesFile(file)).toJS())).toEqual(file);
  });

  it('writes a take that is already a formatted part, so a copy keeps the take\'s bytes', () => {
    expect(canonicalText(formatNotesFile(file), notesFileOrder)).toBe(formatNotesFile(file));
  });

  it('writes an empty take', () => {
    const empty = notesFromMessages([], 480);
    expect(formatNotesFile(empty)).toBe('length: 480\nnotes: []\ncontrols: []\nbends: []\n');
    expect(notesFileSchema.parse(parseDocument(formatNotesFile(empty)).toJS())).toEqual(empty);
  });
});

describe('a part', () => {
  const parse = (text: string) => notesFileSchema.safeParse(parseDocument(text).toJS());
  const messages = (text: string): string[] => {
    const parsed = parse(text);
    return parsed.success ? [] : parsed.error.issues.map((i) => `${i.message} at ${i.path.join('.')}`);
  };

  it('names notes in scientific pitch, where C4 is 60, with sharps or flats', () => {
    expect(['C4', 'C#4', 'Db4', 'A4', 'B3', 'C-1', 'G9'].map(noteNumber)).toEqual([60, 61, 61, 69, 59, 0, 127]);
    expect(['H2', 'c4', 'C', 'G#9', 'Cb-1', 'C10'].map(noteNumber)).toEqual(Array(6).fill(undefined));
  });

  it('takes musical time and note names, and plays a note at velocity 100 when it names none', () => {
    const parsed = parse('length: [2]\nnotes:\n  - { at: [1, 2], length: [0, 1], note: G3 }\n  - { at: 1920, length: 480, note: 60, velocity: 90 }\n');
    expect(parsed.success && parsed.data).toEqual({
      length: [2],
      notes: [
        { at: [1, 2], length: [0, 1], note: 55, velocity: 100 },
        { at: 1920, length: 480, note: 60, velocity: 90 },
      ],
      controls: [],
      bends: [],
    });
  });

  it('refuses a note name that is not one', () => {
    expect(messages('notes:\n  - { at: 0, length: 480, note: H2 }\n')).toEqual([
      '"H2" is not a note name: a note is a MIDI number from 0 to 127 or a name in scientific pitch, where C4 is 60 at notes.0.note',
    ]);
    expect(messages('notes:\n  - { at: 0, length: 480, note: 128 }\n')).toEqual([
      'a note is a MIDI number from 0 to 127 or a name in scientific pitch, where C4 is 60 at notes.0.note',
    ]);
  });

  it('refuses musical time in a take timed in samples', () => {
    expect(messages('sample_rate: 48000\nlength: 96000\nnotes:\n  - { at: [1, 2], length: 480, note: 60 }\n')).toEqual([
      'a notes file with sample_rate: counts samples, so its times are scalars at notes.0.at',
    ]);
  });

  it('formats one row per note and keeps each spelling', () => {
    const text = [
      'notes:',
      '  - at: [1]',
      '    note: C3',
      '    length: [0, 1]',
      '  - { at: [1, 2], length: [0, 1], note: G3, velocity: 110, channel: 2 }',
      'length: [2]',
      'controls: []',
      'bends: []',
      '',
    ].join('\n');
    expect(canonicalText(text, notesFileOrder)).toBe(
      [
        'length: [2]',
        'notes:',
        '  - {at: [1], length: [0, 1], note: C3}',
        '  - {at: [1, 2], length: [0, 1], note: G3, velocity: 110, channel: 2}',
        'controls: []',
        'bends: []',
        '',
      ].join('\n'),
    );
  });
});

describe('render events', () => {
  it('puts every event in time order in seconds, offs before controls before ons at one instant', () => {
    expect(
      renderEvents({
        sample_rate: 48000,
        length: 96000,
        notes: [
          { at: 0, length: 24000, note: 60, velocity: 100 },
          { at: 24000, length: 24000, note: 60, velocity: 90 },
        ],
        controls: [{ at: 24000, cc: 64, value: 127 }],
        bends: [{ at: 48000, value: 8192, channel: 3 }],
      }),
    ).toEqual([
      [0, 'on', 0, 60, 100],
      [0.5, 'off', 0, 60],
      [0.5, 'cc', 0, 64, 127],
      [0.5, 'on', 0, 60, 90],
      [1, 'off', 0, 60],
      [1, 'bend', 2, 8192],
    ]);
  });

  it('releases a zero-length note right after its own on, not before every on at that instant', () => {
    // A pad's on and off inside one sample: the off must follow the on,
    // or the voice it starts is never released.
    const file = notesFromMessages(
      [
        { at: 4800, midi: [144, 36, 120] },
        { at: 4800, midi: [128, 36, 0] },
        { at: 4800, midi: [144, 60, 90] },
      ],
      9600,
    );
    expect(file.notes).toEqual([
      { at: 4800, length: 0, note: 36, velocity: 120 },
      { at: 4800, length: 4800, note: 60, velocity: 90 },
    ]);
    expect(renderEvents({ ...file, sample_rate: 48000 })).toEqual([
      [0.1, 'on', 0, 36, 120],
      [0.1, 'off', 0, 36],
      [0.1, 'on', 0, 60, 90],
      [0.2, 'off', 0, 60],
    ]);
  });
});
