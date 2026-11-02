// juno — the JU-06A from okamnesiac/offset (patches/ju06a.scd), a model of
// the Roland Juno's chain: DCO (saw, pulse, sub, noise) → HPF → resonant
// VCF → VCA → BBD-style chorus, all under one ADSR. Set to the classic
// Juno pad from offset's sessions/juno.scd: saw and pulse, the pulse width
// swept by the LFO, a slow attack, a long release, and the chorus on.
//
// Under FIELD_MODE=voice its value is one voice, gated, which `field keys
// juno` plays, with vibrato from the mod wheel (§14) and the knobs in
// juno.knobs.yaml, and a track with `instrument: juno` renders
// (keyboard-instrument.md §2.6).
// Otherwise it runs under Field's sc-render contract and renders a held
// C minor ninth chord for FIELD_DURATION.
(
var pad = (
	lfoRate: 0.3, lfoDelay: 0, dcoLfo: 0,
	range: 8, sawLevel: 1, pulseLevel: 1, subLevel: 0, noiseLevel: 0,
	pwm: 0.4, pwmMode: 1, pwmLfo: 0,
	hpfFreq: 20,
	vcfFreq: 2000, vcfRes: 0.3, vcfEnv: 0.3, vcfLfo: 0.1, vcfKeyFollow: 0,
	atk: 0.8, dec: 0.5, sus: 0.7, rel: 1.5,
	chorusOn: 1, chorusRate: 0.5, chorusDepth: 0.005,
	modVibrato: 0.5, modOpen: 0 // the mod wheel is vibrato, as on a Juno's bender
);
var level = 0.12; // a voice's gain: room for chords under 0 dBFS

// One JU-06A voice for the settings in `k`, stereo, freed when its
// envelope ends after the gate closes. A render fixes every setting, so
// they shape the graph. A voice takes four of them, the cutoff, the
// resonance, the attack, and the release, as signals from its knobs; the
// rest stay fixed, and those the graph tests with `if`, such as chorusOn,
// must. `mod`, the mod wheel
// from 0 to 1, comes only in voice mode: it adds vibrato of up to
// modVibrato semitones and opens the filter by up to modOpen times its
// cutoff. A render passes none, so its graph is the one without them.
var ju06a = { |freq, gate, k, mod|
	var lfo, pw, sig, env, cutoff;
	lfo = SinOsc.kr(k[\lfoRate]) * EnvGen.kr(Env([0, 0, 1], [k[\lfoDelay], 0.01]));
	freq = freq * (8 / k[\range]) * (2 ** (lfo * k[\dcoLfo] / 12));
	if (mod.notNil) { freq = freq * (2 ** (SinOsc.kr(5.5) * mod * k[\modVibrato] / 12)) };
	pw = if (k[\pwmMode] == 1) { SinOsc.kr(k[\lfoRate]).range(0.1, 0.9) } { k[\pwm] };
	pw = (pw + (lfo * k[\pwmLfo])).clip(0.05, 0.95);
	sig = (Saw.ar(freq) * k[\sawLevel]) + (Pulse.ar(freq, pw) * k[\pulseLevel]);
	if (k[\subLevel] > 0) { sig = sig + (Pulse.ar(freq * 0.5, 0.5) * k[\subLevel]) };
	if (k[\noiseLevel] > 0) { sig = sig + (WhiteNoise.ar * k[\noiseLevel]) };
	sig = HPF.ar(sig, k[\hpfFreq].clip(20, 20000));
	env = EnvGen.kr(Env.adsr(k[\atk], k[\dec], k[\sus], k[\rel]), gate, doneAction: 2);
	cutoff = k[\vcfFreq] * (1 + (env * k[\vcfEnv]) + (lfo * k[\vcfLfo])) + (freq * k[\vcfKeyFollow]);
	if (mod.notNil) { cutoff = cutoff * (1 + (mod * k[\modOpen])) };
	sig = RLPF.ar(sig, cutoff.clip(20, 20000), 1 - k[\vcfRes].clip(0, 0.95)) * env;
	if (k[\chorusOn] == 1) {
		[0, pi].collect { |phase|
			sig + DelayC.ar(sig, 0.05, SinOsc.kr(k[\chorusRate], phase).range(0.001, 0.001 + k[\chorusDepth]))
		} * 0.7
	} {
		sig ! 2
	}
};

if ("FIELD_MODE".getenv == "voice") {
	// Each knob in juno.knobs.yaml, as the signal its controller sets: cc74
	// from 0 to 1, mapped through the knob's range from the copy of the file
	// that Field checked (keys.md, "Make an instrument playable"), starting
	// at the knob's default. A knob the file leaves out keeps the setting's
	// fixed value.
	var knobs = ("FIELD_KNOBS".getenv ?? {
		Error("juno maps its knobs from juno.knobs.yaml, whose checked copy Field names in FIELD_KNOBS").throw
	}).parseYAMLFile["knobs"];
	var knob = { |name, fixed|
		var each = knobs.detect { |knob| knob["name"] == name };
		if (each.isNil) { fixed } {
			var spec = ControlSpec(each["min"].asFloat, each["max"].asFloat, each["curve"].asSymbol, each["step"].asFloat);
			spec.map(("cc" ++ each["cc"]).asSymbol.kr(spec.unmap(each["default"].asFloat), 0.05))
		}
	};
	SynthDef(\junoKey, { |out = 0, freq = 220, amp = 0.5, gate = 1, mod = 0|
		var k = pad.copy;
		k[\vcfFreq] = knob.("cutoff", k[\vcfFreq]);
		k[\vcfRes] = knob.("res", k[\vcfRes]);
		k[\atk] = knob.("attack", k[\atk]);
		k[\rel] = knob.("release", k[\rel]);
		Out.ar(out, ju06a.(freq, gate, k, mod.lag(0.05)) * amp * level);
	})
} {
	var seed = "FIELD_SEED".getenv.asInteger;
	var dur = "FIELD_DURATION".getenv.asFloat;
	var rate = "FIELD_SAMPLE_RATE".getenv.asInteger;
	var out = "FIELD_OUTPUT".getenv;
	var chans = "FIELD_CHANNELS".getenv.asInteger;
	var release = (dur - pad[\rel]).max(0);
	var events = [];
	thisThread.randSeed = seed; // nothing here is random; kept for the contract

	SynthDef(\junoRender, { |freq = 220, amp = 0.5, gate = 1|
		var sig = ju06a.(freq, gate, pad) * amp * level;
		Out.ar(0, if (chans == 1) { sig.sum * 0.5 } { sig });
	}).store;

	[48, 51, 55, 58, 62].do { |note, i| // C3 Eb3 G3 Bb3 D4
		var node = 1000 + i;
		events = events.add([0.0, [\s_new, \junoRender, node, 0, 0, \freq, note.midicps, \amp, 0.8]]);
		events = events.add([release, [\n_set, node, \gate, 0]]);
	};
	Score(events ++ [[dur, [0]]]).recordNRT(
		outputFilePath: out,
		sampleRate: rate,
		headerFormat: "WAV",
		sampleFormat: "int24",
		options: ServerOptions.new.numOutputBusChannels_(chans),
		duration: dur,
		action: { 0.exit }
	);
}
)
