// Which voices play from each MIDI source (sequencer.md §2.6), for the
// voice host. Its value is a function of the voices, FIELD_INSTRUMENTS
// as the host parses it, and the sources, as MIDIClient.sources lists
// them, that answers [hearing, problem]: `hearing` maps each source's uid
// to the indexes of the voices that play from it, and `problem` says
// which source a voice names that is not there, or is nil.
//
// A voice with "sources" plays from each source whose name or device is
// one of them. A voice without plays from every source except the
// `Field Seq <song>/<track>` ones, each of which carries one track's
// parts for that track's own voice.
{ |voices, endpoints|
	var hearing = IdentityDictionary.new, problem;
	var matches = { |endpoint, name| endpoint.name == name or: { endpoint.device == name } };
	var sequenced = { |endpoint| endpoint.name.beginsWith("Field Seq ") };
	voices.do { |voice, i|
		var named = voice["sources"];
		named.do { |name|
			if (problem.isNil and: { endpoints.any { |endpoint| matches.(endpoint, name) }.not }) {
				problem = "no MIDI source named " ++ name ++ "; the sources are "
					++ if (endpoints.isEmpty) { "none" } { endpoints.collect(_.name).join(", ") };
			};
		};
		endpoints.do { |endpoint|
			var hears = if (named.notNil) { named.any { |name| matches.(endpoint, name) } } { sequenced.(endpoint).not };
			if (hears) { hearing[endpoint.uid] = hearing[endpoint.uid].add(i) };
		};
	};
	[hearing, problem]
}
