// Plays a program's pattern into notes for `field sc notes`
// (sequencer.md §2.8), with no server. The program runs under
// FIELD_MODE=notes, where its value must be a Pattern of note events.
// The harness plays it under the seed for FIELD_BEATS quarter notes and
// writes each note that starts before then to FIELD_OUTPUT as JSON,
// {"notes": [[beat, sustain, midinote, amp, chan], ...]}, with times in
// quarter notes from the start and chan 0-based, as a pattern spells
// them. A note is its MIDI number from ~freq, which every spelling of
// pitch reaches: ~midinote misses \freq, \ctranspose, and \harmonic. Field
// writes the part from that.
//
// FIELD_PROGRAM  the program, by absolute path
// FIELD_SEED     the seed, for the program as it runs and for its pattern
// FIELD_BEATS    how many quarter notes to play
// FIELD_OUTPUT   the JSON file to write
(
var program = "FIELD_PROGRAM".getenv;
var seed = "FIELD_SEED".getenv.asInteger;
var beats = "FIELD_BEATS".getenv.asFloat;
var out = "FIELD_OUTPUT".getenv;
var name = PathName(program).fileName;
// A pattern whose events never move time on would play forever.
var most = 100000;
var compiled, pattern, error, problem, stream, event, now = 0, count = 0, notes = [], finite, saved;

// Read above, and gone before the program runs, so in notes mode the
// program sees FIELD_MODE alone.
["FIELD_PROGRAM", "FIELD_SEED", "FIELD_BEATS", "FIELD_OUTPUT"].do(_.unsetenv);
finite = { |x| x.isNumber and: { x.isNaN.not } and: { x.abs != inf } };

thisThread.randSeed = seed;
compiled = thisProcess.interpreter.compileFile(program);
if (compiled.isNil) { problem = name ++ " does not compile" } {
	// As executeFile runs it, so a program can find its own directory.
	saved = thisProcess.nowExecutingPath;
	thisProcess.nowExecutingPath = program;
	pattern = protect { try { compiled.value } { |e| error = e.errorString; nil } } { thisProcess.nowExecutingPath = saved };
	case
	{ error.notNil } { problem = name ++ " does not answer FIELD_MODE=notes: running it in notes mode failed with " ++ error }
	{ pattern.isKindOf(Pattern).not } { problem = name ++ " does not answer FIELD_MODE=notes: in notes mode its value must be a Pattern" };
};

// sclang stays running after an uncaught error, so a pattern that fails
// as it plays would wait out Field's timeout and lose what it printed.
try {
	// A seed given as a number would repeat the pattern forever; one seed
	// plays it once.
	problem ?? { stream = Pseed(Pn(seed, 1), pattern).asStream };
	while { problem.isNil and: { now < beats } and: { (event = stream.next(Event.default)).notNil } } {
		count = count + 1;
		case
		{ event.isKindOf(Event).not } { problem = name ++ "'s pattern makes " ++ event.class.name ++ ", not events" }
		{ count > most } { problem = name ++ "'s pattern made " ++ most ++ " events without reaching beat " ++ beats }
		{ finite.(event.delta).not } { problem = name ++ "'s pattern has an event at beat " ++ now ++ " whose dur is " ++ event.delta }
		{
			if (event.isRest.not) {
				event.use {
					var sustains = ~sustain.value.asArray, amps = ~amp.value.asArray;
					~freq.value.cpsmidi.asArray.do { |note, i|
						var row = [now, sustains.wrapAt(i), note, amps.wrapAt(i), ~chan ? 0];
						if (row.every(finite)) { notes = notes.add(row) } {
							problem = name ++ "'s pattern has a note at beat " ++ now ++ " that is not a number: " ++ row;
						};
					};
				};
			};
			now = now + event.delta;
		};
	};
} { |e| problem = name ++ "'s pattern failed at beat " ++ now ++ ": " ++ e.errorString };

if (problem.notNil) {
	("ERROR: " ++ problem).postln;
	1.exit;
} {
	File.use(out, "w", { |file|
		file.write("{\"notes\":[" ++ notes.collect { |row| "[" ++ row.join(",") ++ "]" }.join(",") ++ "]}");
	});
	0.exit;
};
)
