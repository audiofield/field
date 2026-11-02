// SynthDefs and OSC that Field writes itself (live-supercollider.md
// chunk 2), for the few small graphs it hands scsynth without sclang:
// the ones built around FieldOut, which sclang has no class for, because
// the class would have to be installed into every user's class library.
//
// The formats are SuperCollider's own, documented in its help as
// "Synth Definition File Format" (version 2) and "Non-Realtime
// Synthesis": big-endian throughout, strings as one length byte and
// their bytes, OSC padded to four bytes.

export type Rate = 'scalar' | 'control' | 'audio';
const RATE: Record<Rate, number> = { scalar: 0, control: 1, audio: 2 };

// An input is another UGen's output or a constant.
export type UGenInput = { ugen: number; output?: number } | { constant: number };

export interface UGenSpec {
  name: string; // the UGen's class name, as the plugin registers it
  rate: Rate;
  inputs: UGenInput[];
  outputs: Rate[];
  special?: number; // the operator index of a BinaryOpUGen, else 0
}

export interface SynthDefSpec {
  name: string;
  // Named controls, read by a Control UGen the caller places first.
  params: { name: string; value: number }[];
  ugens: UGenSpec[];
}

class Writer {
  private chunks: Buffer[] = [];
  int8(v: number) {
    const b = Buffer.alloc(1);
    b.writeInt8(v);
    this.chunks.push(b);
  }
  int16(v: number) {
    const b = Buffer.alloc(2);
    b.writeInt16BE(v);
    this.chunks.push(b);
  }
  int32(v: number) {
    const b = Buffer.alloc(4);
    b.writeInt32BE(v);
    this.chunks.push(b);
  }
  float32(v: number) {
    const b = Buffer.alloc(4);
    b.writeFloatBE(v);
    this.chunks.push(b);
  }
  pstring(s: string) {
    const bytes = Buffer.from(s, 'ascii');
    if (bytes.length > 255) throw new Error(`"${s}" is too long for a SynthDef name`);
    const length = Buffer.alloc(1);
    length.writeUInt8(bytes.length);
    this.chunks.push(length);
    this.chunks.push(bytes);
  }
  bytes(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

// One SynthDef in a version-2 file, the bytes /d_recv takes.
export function synthDefFile(def: SynthDefSpec): Buffer {
  const constants: number[] = [];
  const constantIndex = (value: number): number => {
    const at = constants.findIndex((c) => Object.is(c, Math.fround(value)));
    if (at >= 0) return at;
    constants.push(Math.fround(value));
    return constants.length - 1;
  };
  for (const ugen of def.ugens) for (const input of ugen.inputs) if ('constant' in input) constantIndex(input.constant);

  const w = new Writer();
  w.int32(0x53436766); // "SCgf"
  w.int32(2);
  w.int16(1);
  w.pstring(def.name);
  w.int32(constants.length);
  for (const c of constants) w.float32(c);
  w.int32(def.params.length);
  for (const p of def.params) w.float32(p.value);
  w.int32(def.params.length);
  def.params.forEach((p, i) => {
    w.pstring(p.name);
    w.int32(i);
  });
  w.int32(def.ugens.length);
  for (const ugen of def.ugens) {
    w.pstring(ugen.name);
    w.int8(RATE[ugen.rate]);
    w.int32(ugen.inputs.length);
    w.int32(ugen.outputs.length);
    w.int16(ugen.special ?? 0);
    for (const input of ugen.inputs) {
      if ('constant' in input) {
        w.int32(-1);
        w.int32(constantIndex(input.constant));
      } else {
        if (input.ugen < 0 || input.ugen >= def.ugens.length) throw new Error(`no UGen ${input.ugen} in "${def.name}"`);
        w.int32(input.ugen);
        w.int32(input.output ?? 0);
      }
    }
    for (const rate of ugen.outputs) w.int8(RATE[rate]);
  }
  w.int16(0); // no variants
  return w.bytes();
}

// The voice host's route (live-supercollider.md chunk 3): two channels
// from the private bus an instrument's voices play into, written into the
// daemon's ring by FieldOut. Freed before the server quits, which a
// FieldOut still running at shutdown does not survive.
export const ROUTE_DEF = 'field-route';

export function routeSynthDef(): Buffer {
  return synthDefFile({
    name: ROUTE_DEF,
    params: [
      { name: 'in', value: 0 },
      { name: 'ring', value: 0 },
    ],
    ugens: [
      { name: 'Control', rate: 'control', inputs: [], outputs: ['control', 'control'] },
      { name: 'In', rate: 'audio', inputs: [{ ugen: 0, output: 0 }], outputs: ['audio', 'audio'] },
      {
        name: 'FieldOut',
        rate: 'audio',
        inputs: [{ ugen: 0, output: 1 }, { ugen: 1, output: 0 }, { ugen: 1, output: 1 }],
        outputs: [],
      },
    ],
  });
}

export type OscArg = number | string | Buffer | { float: number };

function oscString(s: string): Buffer {
  const bytes = Buffer.from(`${s}\0`, 'utf8');
  return Buffer.concat([bytes, Buffer.alloc((4 - (bytes.length % 4)) % 4)]);
}

// An OSC message: integers as 'i', other numbers and { float } as 'f',
// strings as 's', buffers as blobs.
export function oscMessage(address: string, ...args: OscArg[]): Buffer {
  let tags = ',';
  const parts: Buffer[] = [];
  for (const arg of args) {
    if (Buffer.isBuffer(arg)) {
      tags += 'b';
      const size = Buffer.alloc(4);
      size.writeInt32BE(arg.length);
      parts.push(size, arg, Buffer.alloc((4 - (arg.length % 4)) % 4));
    } else if (typeof arg === 'string') {
      tags += 's';
      parts.push(oscString(arg));
    } else if (typeof arg === 'number' && Number.isInteger(arg)) {
      tags += 'i';
      const b = Buffer.alloc(4);
      b.writeInt32BE(arg);
      parts.push(b);
    } else {
      tags += 'f';
      const b = Buffer.alloc(4);
      b.writeFloatBE(typeof arg === 'number' ? arg : arg.float);
      parts.push(b);
    }
  }
  return Buffer.concat([oscString(address), oscString(tags), ...parts]);
}

// An OSC bundle at `seconds` (NTP time, as a non-realtime score counts
// from zero) holding `messages`.
export function oscBundle(seconds: number, messages: Buffer[]): Buffer {
  const time = Buffer.alloc(8);
  time.writeUInt32BE(Math.floor(seconds));
  time.writeUInt32BE(Math.round((seconds - Math.floor(seconds)) * 2 ** 32) >>> 0, 4);
  const elements = messages.map((m) => {
    const size = Buffer.alloc(4);
    size.writeInt32BE(m.length);
    return Buffer.concat([size, m]);
  });
  return Buffer.concat([oscString('#bundle'), time, ...elements]);
}

// A non-realtime score: each bundle prefixed with its length, in time
// order. scsynth -N runs until the last bundle's time.
export function nrtScore(bundles: Buffer[]): Buffer {
  return Buffer.concat(
    bundles.flatMap((bundle) => {
      const size = Buffer.alloc(4);
      size.writeInt32BE(bundle.length);
      return [size, bundle];
    }),
  );
}
