import type { LoadedSong } from './project.js';

// The `seq:` claim (sequencer.md §3.6): a track whose notes `field seq`
// plays live, through a voice into the track's input, would play them
// twice if its renders stayed. So the session leaves out each entry that
// renders notes on the track, its parts and its record entry, and keeps
// its audio. Like solo (model/solo.ts) it is a session-only change made
// at compile, on a freshly loaded copy, and the files never change. The
// session keeps the length those renders give the song (graph/live.ts).
//
// A record entry on a track with an instrument records MIDI
// (sequencer.md §3.4), and validation refuses an audio take there, so
// every take it can choose renders notes.
export function leaveOutNotes(song: LoadedSong, tracks: ReadonlySet<string>): void {
  for (const track of song.tracks) {
    if (!tracks.has(track.data.name)) continue;
    const instrument = track.data.instrument;
    track.data.inputs = track.data.inputs.filter(
      (entry) => entry.notes === undefined && (entry.record === undefined || instrument === undefined),
    );
  }
}
