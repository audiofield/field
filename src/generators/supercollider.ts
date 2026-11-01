import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync, readdirSync } from 'node:fs';
import { dirname, extname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { sha256File } from '../hash.js';
import type { SupercolliderSound } from './types.js';
import type { Generator } from './types.js';

const execFileAsync = promisify(execFile);

// supercollider: a SuperCollider program defines the sound, rendered
// offline (NRT). The contract (sc-render.md §2): the program is a plain
// .scd run via sclang with FIELD_OUTPUT / FIELD_SEED / FIELD_DURATION /
// FIELD_SAMPLE_RATE / FIELD_CHANNELS in the environment; it writes
// FIELD_OUTPUT and exits. Determinism given the seed is the program's
// job; the program's content hash is a cache input, so editing the code
// invalidates its own renders. `source:` names the program: a bare
// filename resolves on the type's home shelf, shared/instruments/
// (project-layout.md §4.3); a slashed path is project-relative.

const SCLANG_APP_FALLBACK = '/Applications/SuperCollider.app/Contents/MacOS/sclang';

type ExecError = Error & {
  code?: string;
  killed?: boolean;
  stdout?: string;
  stderr?: string;
};

// sclang reports compile and runtime errors on *stdout*; Node's exec error
// message carries only stderr. Surface both, or the edit-retry loop this
// exists for is flying blind.
function formatScError(err: ExecError, programPath: string, timeoutMs: number): Error {
  if (err.killed) {
    return new Error(
      `sclang timed out after ${Math.round(timeoutMs / 1000)}s for ${programPath} — ` +
        `did the program call 0.exit?`,
    );
  }
  const stdoutTail = (err.stdout ?? '')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .slice(-15)
    .join('\n');
  const detail = stdoutTail ? `\n${stdoutTail}` : '';
  return new Error(`sclang failed for ${programPath}: ${err.message}${detail}`);
}

// The home-shelf resolution (§4.3): every bare spelling resolves in its
// natural home, explicit spellings escape — never a search path.
export function programPath(sound: Pick<SupercolliderSound, 'source'>): string {
  return sound.source.includes('/') ? sound.source : posix.join('shared/instruments', sound.source);
}

// An instrument named by `field keys` or a record entry
// (keyboard-instrument.md §2.1, §12.2): `.scd` is added to a name without
// an extension, then it resolves as a supercollider: entry's source does.
export function instrumentProgram(instrument: string): string {
  return programPath({ source: posix.extname(instrument) === '' ? `${instrument}.scd` : instrument });
}

// Field's own SuperCollider programs, beside the package's source.
export function scScript(name: string): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'sc', name);
}

// An environment variable by name. Windows names are case-insensitive —
// PATH is usually spelled `Path` there — and only process.env itself knows
// that, so a copied environment is searched without regard to case.
function variable(env: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform): string | undefined {
  if (env[name] !== undefined || platform !== 'win32') return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

// The extensions a spawn without a shell can start on Windows. PATHEXT also
// lists .bat and .cmd, but Node refuses those without a shell (spawn
// EINVAL, since the CVE-2024-27980 releases), and both callers spawn
// without one.
const WINDOWS_EXECUTABLES = ['.com', '.exe'];

// A command name found on PATH the way a spawn can start it. Windows runs
// `sclang` as `sclang.exe`, so a name without an extension is tried with
// each executable extension and never bare: an extensionless file there
// cannot run.
function onPath(name: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | undefined {
  const windows = platform === 'win32';
  const names = windows && extname(name) === '' ? WINDOWS_EXECUTABLES.map((ext) => name + ext) : [name];
  for (const dir of (variable(env, 'PATH', platform) ?? '').split(windows ? ';' : ':')) {
    if (dir === '') continue;
    for (const candidate of names.map((n) => join(dir, n))) {
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // not here
      }
    }
  }
  return undefined;
}

// Whether a FIELD_SCLANG value names a file rather than a command to look
// up on PATH: any separator does, and on Windows a backslash or a drive
// (`C:\Program Files\SuperCollider-3.13.0\sclang.exe`).
function namesAFile(value: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' ? /[\\/:]/.test(value) : value.includes('/');
}

// Where the SuperCollider installer puts sclang when it is not on PATH:
// the app bundle on macOS, and a versioned directory under Program Files
// on Windows, newest first (3.13.0 sorts after 3.9.3).
function installedSclang(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | undefined {
  if (platform === 'darwin') return existsSync(SCLANG_APP_FALLBACK) ? SCLANG_APP_FALLBACK : undefined;
  if (platform !== 'win32') return undefined;
  const programFiles = variable(env, 'ProgramFiles', platform) ?? 'C:\\Program Files';
  let entries: string[];
  try {
    entries = readdirSync(programFiles);
  } catch {
    return undefined;
  }
  return entries
    .filter((entry) => /^SuperCollider/i.test(entry))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    .map((entry) => join(programFiles, entry, 'sclang.exe'))
    .find((candidate) => existsSync(candidate));
}

// The sclang to run: FIELD_SCLANG, then PATH, then where the installer
// puts it. One lookup for a render and for the long-running voice host
// (keyboard-instrument.md §2.8). The override is the determinism escape
// hatch (sc-render.md §2); a typo'd wrapper must never silently run the
// installed sclang instead. The platform is a parameter so the Windows
// rules are testable anywhere.
export function sclangCommand(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const override = env['FIELD_SCLANG'];
  if (override) {
    const found = namesAFile(override, platform)
      ? existsSync(override)
        ? override
        : undefined
      : onPath(override, env, platform);
    if (found === undefined) throw new Error(`FIELD_SCLANG points at a missing binary: ${override}`);
    if (platform === 'win32' && !WINDOWS_EXECUTABLES.includes(extname(found).toLowerCase())) {
      throw new Error(
        `FIELD_SCLANG points at ${found}, which Windows cannot start directly; ` +
          'point it at sclang.exe or an .exe wrapper',
      );
    }
    return found;
  }
  const found = onPath('sclang', env, platform) ?? installedSclang(env, platform);
  if (found === undefined) throw new Error('sclang not found on PATH (install SuperCollider or set FIELD_SCLANG)');
  return found;
}

// Run an SC program under the supercollider contract. Used by the rule
// and by `field sc render` (direct, uncached iteration).
export async function runScProgram(
  programPath: string,
  outputPath: string,
  params: {
    seed: number;
    duration: number;
    channels: number;
    sampleRate: number;
    timeoutMs?: number;
    // More of the program's environment, such as a take render's
    // FIELD_INSTRUMENT and FIELD_EVENTS (keyboard-instrument.md §12.3).
    env?: Record<string, string>;
  },
): Promise<void> {
  const env = {
    ...process.env,
    ...params.env,
    FIELD_OUTPUT: outputPath,
    FIELD_SEED: String(params.seed),
    FIELD_DURATION: String(params.duration),
    FIELD_SAMPLE_RATE: String(params.sampleRate),
    FIELD_CHANNELS: String(params.channels),
  };
  // The ceiling scales with the render: NRT is usually faster than realtime,
  // but the schema admits hour-long renders, and the ceiling exists to catch
  // hangs, not to race legitimate work.
  const timeout = params.timeoutMs ?? Math.max(180_000, 60_000 + params.duration * 10_000);
  await runSclang(programPath, env, timeout);
}

// Runs sclang on `script`, and throws with what it printed when it fails
// or outlives `timeoutMs`, naming `program`, the user's program, which
// may be one that `script` runs.
export async function runSclang(script: string, env: NodeJS.ProcessEnv, timeoutMs: number, program = script): Promise<void> {
  // scsynth prints a line per score bundle in NRT, about 20 bytes, so a
  // long take's render outgrows Node's 1 MiB default and is killed.
  const options = { env, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 };
  try {
    await execFileAsync(sclangCommand(), [script], options);
  } catch (err) {
    throw formatScError(err as ExecError, program, timeoutMs);
  }
}

export const supercolliderGenerator: Generator<SupercolliderSound> = {
  version: 1,
  wiringFields: ['source'],

  sources() {
    // The program is an input by content hash, not a graph node.
    return [];
  },

  validate(sound, ctx) {
    if (sound.source !== posix.normalize(sound.source) || sound.source.includes('\\')) {
      ctx.push(`program path not in normalized form: ${sound.source}`);
      return;
    }
    const resolved = ctx.resolveFile('', programPath(sound)); // project-relative
    if (resolved.problem) ctx.push(`program ${resolved.problem}`);
  },

  async extraInputs(root, sound) {
    const program = programPath(sound);
    return [{ label: program, sha256: await sha256File(join(root, program)) }];
  },

  async execute(sound, _inputPaths, outputPath, ctx) {
    await runScProgram(join(ctx.root, programPath(sound)), outputPath, {
      seed: sound.seed,
      duration: sound.duration,
      channels: sound.channels,
      sampleRate: ctx.sampleRate,
    });
    if (!existsSync(outputPath)) {
      throw new Error(
        `sc program ${sound.source} exited without writing FIELD_OUTPUT — ` +
          `it must render to the path in FIELD_OUTPUT and call 0.exit`,
      );
    }
  },

  async verifyAfterRun(root, sound, extraInputs) {
    const after = await sha256File(join(root, programPath(sound)));
    if (after !== extraInputs[0]!.sha256) {
      throw new Error(
        `refusing to cache: ${sound.source} changed during the render — re-run the build`,
      );
    }
  },
};
