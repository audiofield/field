import { VoiceHost, type VoiceHostOptions, type VoiceHostStatus } from './host.js';
import type { Routing } from './routing.js';

// What a command shows about its voices, which `startVoices` keeps current.
export interface VoiceState {
  status: Extract<VoiceHostStatus, { state: 'live' | 'restarting' }> | { state: 'starting' };
  // What the last save of the program did (keyboard-instrument.md §14).
  reload?: { loaded: true } | { failed: string };
  // Why nothing is heard at all: routed, but scsynth never ran the route.
  silent?: string;
}

export interface StartVoicesOptions extends Omit<VoiceHostOptions, 'onStatus' | 'onExit' | 'rings' | 'fieldOut'> {
  routing: Routing | undefined;
  state: VoiceState;
  changed: () => void;
  // Called when the host cannot start, or stops on its own.
  stop: (error: Error) => void;
}

export async function startVoices({ routing, state, changed, stop, ...options }: StartVoicesOptions): Promise<VoiceHost> {
  const host = await VoiceHost.start({
    ...options,
    ...(routing !== undefined ? { rings: routing.rings, fieldOut: routing.fieldOut } : {}),
    onStatus: (status) => {
      if (status.state === 'voice') return;
      if (status.state === 'reloaded') state.reload = { loaded: true };
      else if (status.state === 'reload-failed') state.reload = { failed: status.reason };
      else state.status = status;
      changed();
    },
    onExit: (reason) => stop(new Error(`the voice host stopped: ${reason}`)),
  });
  host.ready.catch((err: Error) => stop(new Error(`the voice host did not start: ${err.message}`)));
  // A route scsynth never ran, because FieldOut did not load in it, leaves
  // its ring empty: the voices play into a bus nothing reads.
  if (routing !== undefined) {
    void host.ready
      .then(() => routing.flowing())
      .then((flowing) => {
        if (flowing) return;
        state.silent = 'FieldOut did not load in scsynth, so nothing reaches the daemon';
        changed();
      })
      .catch(() => {});
  }
  return host;
}
