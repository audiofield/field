// The voice host behind `field keys` and `field sc voice`
// (keyboard-instrument.md §2.6, sequencer.md §2.6). It boots its own
// scsynth on the output device, loads each voice (arming.md §2.1), and
// plays each from its own MIDI sources (voice-sources.scd). Field reads
// only the lines that start with "@field ", each one JSON object; the rest
// of sclang's output is left for diagnosing a failure.
//
// Environment: FIELD_INSTRUMENTS (a JSON list of the voices, each an
// object with "program", its absolute path; "knobs", the checked copy of
// its knob file, absent when it has none: instrument-knobs.md §2.4; and
// "sources", the names of the MIDI sources it plays from, absent to play
// from every source but the Field Seq ones),
// FIELD_SC_PORT (the scsynth port Field chose), FIELD_PARENT_PID,
// FIELD_DEVICE (optional output device), FIELD_MODE=voice, and
// FIELD_VOICE_TRACE (optional: report each voice as it starts and ends).
// To play through the effects (live-supercollider.md chunk 3):
// FIELD_RINGS (a JSON list beside FIELD_INSTRUMENTS, each the daemon ring
// that instrument's voices go to, or null for the device) and
// FIELD_ROUTE_DEF (the route's SynthDef file, which Field writes because
// sclang has no FieldOut class). Field puts FieldOut's directory on
// SC_PLUGIN_PATH, which scsynth searches beside its own plugins.
// sclang's own port, which Field also chooses (-u), takes /field/reload:
// load every program again, as one has changed (§14), keeping them all as
// they were if one does not load.
(
var here = PathName(thisProcess.nowExecutingPath).pathOnly;
var loadVoice = thisProcess.interpreter.executeFile(here +/+ "voice-load.scd");
var playsFrom = thisProcess.interpreter.executeFile(here +/+ "voice-sources.scd");
var makeVoicer = thisProcess.interpreter.executeFile(here +/+ "voicer.scd");
var instruments = "FIELD_INSTRUMENTS".getenv.parseJSON;
var port = "FIELD_SC_PORT".getenv.asInteger;
var parentPid = "FIELD_PARENT_PID".getenv;
var device = "FIELD_DEVICE".getenv;
var trace = "FIELD_VOICE_TRACE".getenv.notNil;
var rings = "FIELD_RINGS".getenv !? (_.parseJSON);
var routeDef = "FIELD_ROUTE_DEF".getenv;
// Each routed instrument's private bus and its route, made at each boot.
var buses = [], routes = [], startRoutes, stopRoutes;
// True until the server answers, at the first boot and at each restart:
// a note then has no server to sound on, so it is ignored.
var server, voiceDefs, problem, voicers, booting = true;
// Each source's uid, and the voices that play from it.
var hearing, sourceProblem, heard;
var loadAll, addAll;
var jsonValue, emit, fail, stopServer, deviceProblem, run, boot, restart;

jsonValue = { |value|
	if (value.isString or: { value.isKindOf(Symbol) }) {
		"\"" ++ value.asString.replace("\\", "\\\\").replace("\"", "\\\"") ++ "\""
	} { value.asString }
};
emit = { |pairs|
	var body = pairs.clump(2).collect { |kv| jsonValue.(kv[0]) ++ ":" ++ jsonValue.(kv[1]) }.join(",");
	("@field {" ++ body ++ "}").postln;
};
// A route per instrument with a ring: two channels from its private bus
// into the ring, at the tail, after every voice. JSON's null arrives as
// nil or as the string "null", depending on the parser.
startRoutes = {
	var ring = { |i| rings !? { |list| list[i] } };
	buses = instruments.collect { |path, i|
		var r = ring.(i);
		if (r.notNil and: { r != "null" }) { Bus.audio(server, 2) }
	};
	routes = buses.collect { |bus, i|
		bus !? { Synth.tail(server, 'field-route', [\in, bus.index, \ring, ring.(i).asInteger]) }
	};
};
// At shutdown scsynth unloads its plugins before it frees the synths
// still running, and a FieldOut among them would call a destructor that
// is gone: free every node first.
stopRoutes = {
	if (server.notNil and: { server.serverRunning }) { server.freeAll };
	routes = [];
};
// A server that is still booting has not bound its port, so a /quit would
// miss it: the host stops its server by process.
stopServer = {
	stopRoutes.();
	server !? { |s| s.pid !? { |pid| ("kill " ++ pid ++ " 2>/dev/null").systemCmd } };
};
// exit does not stop the code that called it, so a failure is the last
// thing its branch does.
fail = { |message|
	emit.(["error", message]);
	stopServer.();
	1.exit;
};
// scsynth falls back to the default input and output for a name it does
// not find, which opens the microphone (§10.1), and SuperCollider passes
// the name to the shell that starts scsynth between bare double quotes.
deviceProblem = { |name|
	case
	{ name.any { |char| "\"`$\\".includes(char) } } {
		"the device name " ++ name ++ " has a character (\" ` $ \\) that would reach the shell that starts scsynth"
	}
	{ ServerOptions.outDevices.includesEqual(name).not } {
		"no output device named " ++ name ++ " (field devices lists them)"
	}
	{ nil };
};

// Watched here rather than through waitForBoot, whose onFailure never runs
// in SuperCollider 3.14: a server that exits while it boots, as one does
// when the device will not start, would otherwise leave the host waiting
// forever. Each server's process is reported, so `field keys` can stop it
// even while it boots.
boot = {
	var started = Main.elapsedTime, launched;
	server.boot;
	Routine {
		var waiting = true;
		while { waiting } {
			0.1.wait;
			if (launched.isNil and: { server.pid.notNil }) {
				launched = server.pid;
				emit.(["server_pid", launched]);
			};
			case
			{ server.serverRunning } {
				waiting = false;
				addAll.();
				routeDef !? { |path| server.sendMsg(\d_load, path) };
				server.sync;
				startRoutes.();
				server.sync;
				booting = false;
				emit.(["ready", true, "device", device ? "system output", "sample_rate", server.sampleRate.asInteger]);
			}
			{ launched.notNil and: { server.pid.isNil } } {
				waiting = false;
				fail.("scsynth exited while it booted on " ++ (device ? "the system output") ++ ": the device did not start");
			}
			{ Main.elapsedTime - started > 20 } {
				waiting = false;
				fail.("scsynth did not boot on " ++ (device ? "the system output") ++ " within 20 seconds");
			};
		};
	}.play(AppClock);
};

// Each program's voice, or the first program's problem. Each SynthDef is
// renamed for its place in the list, so two programs that name their
// voices alike still both play.
loadAll = {
	var defs = [], why;
	instruments.do { |each, i|
		var def, problem;
		# def, problem = loadVoice.(each["program"], each["knobs"]);
		if (problem.notNil) { why = why ? problem } {
			def.name = ("field" ++ i ++ "_" ++ def.name).asSymbol;
			defs = defs.add(def);
		};
	};
	[defs, why]
};
addAll = { voiceDefs.do(_.add) };

// scsynth keeps computing at the rate it booted at when the device moves
// to another, so every voice would play sharp or flat. Each status reply
// carries the booted rate and the rate measured from the device clock.
restart = {
	booting = true;
	voicers.do(_.forgetVoices);
	emit.(["restarting", true]);
	stopRoutes.();
	server.quit(onComplete: boot);
};

run = {
	server = Server(\fieldKeys, NetAddr("127.0.0.1", port));
	server.options.numInputBusChannels = 0;
	server.options.numOutputBusChannels = 2;
	server.options.hardwareBufferSize = 128;
	server.options.sampleRate = nil;
	// Named for both directions: given no input device, scsynth on macOS
	// opens the default one even with no input channels, and blocks on the
	// microphone permission (keyboard-instrument.md §10.1).
	if (device.notNil) {
		server.options.inDevice = device;
		server.options.outDevice = device;
	};
	Server.default = server;

	// A voicer per voice, with its own notes, pedal, and controllers,
	// because each voice hears only its own sources.
	voicers = instruments.collect { |each, i|
		makeVoicer.(
			{ |note, velocity, freq, controls|
				var out = buses[i] !? (_.index) ? 0;
				Synth(voiceDefs[i].name, [\freq, freq, \amp, velocity / 127, \gate, 1, \out, out] ++ controls, server)
			},
			{ |synth, control, value| synth.set(control, value) },
			{ |synth| synth.set(\gate, 0) },
			if (trace) { { |note, on| emit.([if (on) { "voice_on" } { "voice_off" }, note, "voice", i]) } }
		)
	};
	heard = { |src, action| hearing[src].do { |i| action.(voicers[i]) } };

	MIDIIn.connectAll(verbose: false);

	MIDIdef.noteOn(\fieldNoteOn, { |velocity, note, chan, src|
		if (booting.not) { heard.(src, _.noteOn(chan, note, velocity)) };
	});
	MIDIdef.noteOff(\fieldNoteOff, { |velocity, note, chan, src| heard.(src, _.noteOff(chan, note)) });
	MIDIdef.cc(\fieldControl, { |value, number, chan, src| heard.(src, _.cc(chan, number, value)) });
	MIDIdef.bend(\fieldBend, { |value, chan, src| heard.(src, _.bend(chan, value)) });

	// A program's file changed: load them again. Voices that load are what
	// the next note plays, and the notes sounding finish as they started;
	// if any program does not load, every voice stays as it was.
	OSCdef(\fieldReload, { |msg, time, addr|
		if (addr.ip == "127.0.0.1") {
			var next, why;
			# next, why = loadAll.();
			case
			{ why.notNil } { emit.(["reload_error", why]) }
			{ booting } {
				// The boot adds whatever voiceDefs holds when the server answers.
				voiceDefs = next;
				emit.(["reloaded", true]);
			}
			{
				voiceDefs = next;
				fork {
					addAll.();
					server.sync;
					emit.(["reloaded", true]);
				};
			};
		};
	}, '/field/reload');

	Routine {
		loop {
			0.7.wait;
			if (booting.not and: { server.serverRunning }) {
				var booted = server.sampleRate, measured = server.actualSampleRate;
				if (booted.notNil and: { measured.notNil } and: { booted > 0 } and: { (measured / booted - 1).abs > 0.01 }) {
					restart.();
				};
			};
		};
	}.play(AppClock);

	// No orphans: once `field keys` is gone, so is this host and its server.
	Routine {
		loop {
			1.wait;
			if (("kill -0 " ++ parentPid ++ " 2>/dev/null").systemCmd != 0) {
				stopServer.();
				0.exit;
			};
		};
	}.play(AppClock);

	boot.();
};

// A voice hears the sources there when the host starts, so a command
// publishes its own, as `field keys` publishes Field Keys, first.
MIDIClient.init(verbose: false);
# hearing, sourceProblem = playsFrom.(instruments, MIDIClient.sources);
# voiceDefs, problem = loadAll.();
case
	{ problem.notNil } { fail.(problem) }
	{ sourceProblem.notNil } { fail.(sourceProblem) }
	{ device.notNil and: { deviceProblem.(device).notNil } } { fail.(deviceProblem.(device)) }
	{ run.() };
)
