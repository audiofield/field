import { spawnSync } from 'node:child_process';
import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A test here runs install.sh one or more times, each a few dozen processes.
// Under a full parallel suite one took longer than vitest's 5-second
// default, so the file gets thirty.
vi.setConfig({ testTimeout: 30_000 });

// install.sh, run by real bash against a clone of its own in a temporary
// directory (install.md §2). pnpm, cmake, and the field CLI are stand-ins
// that record what they were asked, and PATH holds nothing else but links
// to the ordinary tools the script needs, so whatever happens to be
// installed on the machine running the suite cannot answer in their place.
// Locally that is macOS's bash 3.2 and in CI bash 5, so both run it.
// Windows skips them: the installer does not support it yet
// (install.md §7.6), and `field upgrade` refuses there instead.
const posix = describe.skipIf(process.platform === 'win32');

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const AUDIOD = 'native/audiod/build/field-audiod_artefacts/Release/field-audiod';

function which(tool: string): string | undefined {
  for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
    const path = join(dir, tool);
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch {
      // not here
    }
  }
  return undefined;
}

const BASH = which('bash')!;
const UNAME = which('uname')!;
const GIT = which('git')!;
// curl and git are stand-ins too, and so are uname and the compiler
// checks; tar and gzip unpack the stand-in releases.
const TOOLS = [
  'bash',
  'node',
  'dirname',
  'sed',
  'grep',
  'cat',
  'mkdir',
  'ln',
  'rm',
  'rmdir',
  'chmod',
  'touch',
  'mv',
  'readlink',
  'tar',
  'gzip',
  'mktemp',
  'tail',
];

let root: string;
let upstream: string;
let repo: string;
let bin: string;
let pnpmHome: string;
let log: string;
// A release install's directories, under the temporary HOME, and where the
// stand-in curl serves GitHub from.
let data: string;
let shim: string;
let serve: string;
let downloaded: string;

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, HOME: root, GIT_CONFIG_NOSYSTEM: '1' },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function write(path: string, text: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  if (mode !== undefined) chmodSync(path, mode);
}

// A stand-in pnpm, which does what each command the installer runs would
// do to the files the installer then reads, and nothing more.
const PNPM = `#!${BASH}
echo "pnpm $*" >> "$FAKE_LOG"
dir=""
if [ "$1" = --dir ]; then dir="$2"; shift 2; fi
case "$1 \${2:-}" in
  "--version ") echo 11.15.1 ;;
  "bin -g") [ -z "\${FAKE_NO_GLOBAL_BIN:-}" ] || exit 1; echo "$FAKE_PNPM_HOME/bin" ;;
  "ls -g")
    if [ -L "$FAKE_PNPM_HOME/global/field" ]; then
      printf '[{"path":"g","dependencies":{"field":{"path":"%s"}}}]\\n' "$FAKE_PNPM_HOME/global/field"
    else
      echo '[{"path":"g"}]'
    fi ;;
  "add -g")
    mkdir -p "$FAKE_PNPM_HOME/global" "$FAKE_PNPM_HOME/bin"
    rm -f "$FAKE_PNPM_HOME/global/field"
    ln -s "$3" "$FAKE_PNPM_HOME/global/field"
    printf '#!/bin/sh\\n' > "$FAKE_PNPM_HOME/bin/field"
    chmod +x "$FAKE_PNPM_HOME/bin/field" ;;
  "remove -g")
    rm -f "$FAKE_PNPM_HOME/global/field" "$FAKE_PNPM_HOME/bin/field" ;;
  "install --frozen-lockfile") echo "Packages: +122"; echo "依存関係を解決しています、依存関係を解決しています" ;;
  "run build")
    mkdir -p "$dir/dist"
    node "$dir/scripts/stamp-build.mjs" > /dev/null
    cat "$FAKE_CLI" > "$dir/dist/cli.js" ;;
  "run build:ui")
    [ -z "\${FAKE_UI_FAILS:-}" ] || exit 2
    mkdir -p "$dir/ui/dist"
    printf '<!doctype html>\\n' > "$dir/ui/dist/index.html" ;;
  "run build:native")
    [ -z "\${FAKE_NATIVE_FAILS:-}" ] || { echo "cmake: JUCE did not compile" >&2; exit 2; }
    # Where native/audiod/CMakeLists.txt would have FetchContent put JUCE.
    mkdir -p "$dir/native/audiod/build"
    printf '%s\\n' "\${FIELD_FETCHCONTENT_BASE_DIR:-unset}" > "$dir/native/audiod/build/fetchcontent"
    # A daemon already built is left alone, as CMake leaves field-audiod
    # when the edit was to another target's source.
    [ ! -e "$dir/${AUDIOD}" ] || exit 0
    mkdir -p "$dir/${dirname(AUDIOD)}"
    printf '#!/bin/sh\\n' > "$dir/${AUDIOD}"
    chmod +x "$dir/${AUDIOD}" ;;
  *) echo "pnpm stand-in: unexpected $*" >&2; exit 99 ;;
esac
`;

// The CLI's half of the workers target and of the status rows.
const CLI = `require('fs').appendFileSync(process.env.FAKE_LOG, 'field ' + process.argv.slice(2).join(' ') + '\\n');
if (process.argv.includes('--check')) {
  console.log('worker-current field-aced');
  console.log('worker-stale   field-voiced is out of date — run field setup voiced');
  process.exitCode = 1;
}
`;

// A stand-in curl, which serves GitHub's two hosts from FAKE_SERVE and a
// file:// URL from the disk, and records each request with the config it
// read on stdin, which is where a token travels.
const CURL = `#!${BASH}
url="" out="" config=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    --config) [ "$2" != - ] || config="$(cat)"; shift 2 ;;
    --retry) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
echo "curl $url\${config:+ [$config]}" >> "$FAKE_LOG"
case "$url" in
  https://raw.githubusercontent.com/*) path="$FAKE_SERVE/raw/\${url#https://raw.githubusercontent.com/}" ;;
  https://github.com/*) path="$FAKE_SERVE/github/\${url#https://github.com/}" ;;
  file://*) path="\${url#file://}" ;;
  *) echo "curl: (6) Could not resolve host" >&2; exit 6 ;;
esac
[ -f "$path" ] || { echo "curl: (22) The requested URL returned error: 404" >&2; exit 22; }
if [ -n "$out" ]; then cat "$path" > "$out"; else cat "$path"; fi
`;

// A stand-in git, which answers ls-remote for github.com from the
// repositories under FAKE_SERVE/git, as the stand-in curl serves GitHub's
// files, and runs the real git for everything else.
const GIT_STANDIN = `#!${BASH}
if [ "\${1:-}" = ls-remote ]; then
  echo "git ls-remote $2" >> "$FAKE_LOG"
  case "$2" in
    https://github.com/*)
      url="file://$FAKE_SERVE/git/\${2#https://github.com/}"
      shift 2
      set -- ls-remote "$url" "$@"
      ;;
  esac
fi
exec ${GIT} "$@"
`;

// The CLI a stand-in release builds. It logs which version ran it, and
// keeps its worker environments in its own version directory, as the real
// one keeps python/<worker>/.venv.
const RELEASE_CLI = `const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, 'field@' + version + ' ' + args.join(' ') + '\\n');
const marker = (name) => path.join(root, 'python', name.replace(/^field-/, ''), '.venv', 'set-up');
if (args[0] === '--version') console.log(version);
if (args[0] === 'setup' && args.includes('--check')) {
  for (const name of ['field-aced', 'field-voiced']) {
    if (!fs.existsSync(marker(name))) {
      console.log('worker-absent  ' + name + ' is not set up — field setup ' + name.slice(6) + ' sets it up');
    } else if (process.env.FAKE_NO_UV) {
      console.log('worker-no-uv   ' + name + ' is set up, and uv is not installed (brew install uv)');
      process.exitCode = 1;
    } else {
      console.log('worker-current ' + name);
    }
  }
} else if (args[0] === 'setup' && args[1] !== undefined && !args[1].startsWith('--')) {
  if (process.env.FAKE_SETUP_FAILS) process.exit(3);
  fs.mkdirSync(path.dirname(marker(args[1])), { recursive: true });
  fs.writeFileSync(marker(args[1]), '');
}
`;

beforeEach(() => {
  // Resolved, because the installer compares paths it resolves with
  // pwd -P, and macOS's temporary directory sits behind /var -> /private/var.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'field-install-')));
  upstream = join(root, 'upstream');
  repo = join(root, 'checkout');
  bin = join(root, 'bin');
  pnpmHome = join(root, 'pnpm');
  log = join(root, 'log');

  // Only what the installer reads: itself, the marker that makes a
  // checkout, the real build stamp, and UI and daemon sources to be newer
  // than.
  copyFileSync(join(packageRoot, 'install.sh'), join(root, 'install.sh'));
  write(join(upstream, 'install.sh'), readFileSync(join(root, 'install.sh'), 'utf8'), 0o755);
  write(join(upstream, 'src/cli.ts'), '');
  write(join(upstream, 'package.json'), '{ "name": "field" }\n');
  write(join(upstream, 'scripts/stamp-build.mjs'), readFileSync(join(packageRoot, 'scripts/stamp-build.mjs'), 'utf8'));
  write(join(upstream, 'ui/src/main.tsx'), '');
  write(join(upstream, 'native/audiod/CMakeLists.txt'), '');
  write(join(upstream, 'native/audiod/src/main.cpp'), '');
  write(join(upstream, '.gitignore'), 'dist/\nnative/audiod/build/\n');
  git(root, 'init', '--quiet', '-b', 'main', upstream);
  git(upstream, 'add', '.');
  git(upstream, 'commit', '--quiet', '-m', 'one');
  git(root, 'clone', '--quiet', upstream, repo);

  mkdirSync(bin);
  mkdirSync(join(root, 'tmp'));
  for (const tool of TOOLS) {
    const path = which(tool);
    if (path !== undefined) symlinkSync(path, join(bin, tool));
  }
  write(join(bin, 'pnpm'), PNPM, 0o755);
  write(join(bin, 'cmake'), `#!${BASH}\necho "cmake version 3.30.2"\n`, 0o755);
  write(join(bin, 'curl'), CURL, 0o755);
  write(join(bin, 'git'), GIT_STANDIN, 0o755);
  // The platform is the machine's unless FAKE_UNAME names another, so the
  // macOS and Linux checks both run wherever the suite does. A compiler,
  // make, and every header module are there unless a test removes them, or
  // names the modules FAKE_NO_HEADERS leaves out.
  write(
    join(bin, 'uname'),
    `#!${BASH}\nif [ -n "\${FAKE_UNAME:-}" ] && [ "\${1:-}" = -s ]; then echo "$FAKE_UNAME"; else exec ${UNAME} "$@"; fi\n`,
    0o755,
  );
  write(join(bin, 'xcode-select'), `#!${BASH}\necho ${root}\n`, 0o755);
  write(join(bin, 'c++'), `#!${BASH}\n`, 0o755);
  write(join(bin, 'make'), `#!${BASH}\n`, 0o755);
  write(
    join(bin, 'pkg-config'),
    `#!${BASH}\ncase " \${FAKE_NO_HEADERS:-} " in *" $2 "*) exit 1 ;; esac\n`,
    0o755,
  );
  write(join(root, 'cli.js'), CLI);
  write(join(root, 'release-cli.js'), RELEASE_CLI);
  writeFileSync(log, '');

  data = join(root, '.local', 'share', 'field');
  shim = join(root, '.local', 'bin', 'field');
  serve = join(root, 'serve');
  // The installer on its own, as `field upgrade` downloads it.
  downloaded = join(root, 'download', 'install.sh');
  write(downloaded, readFileSync(join(packageRoot, 'install.sh'), 'utf8'));
});

// Every test here is synchronous, spawnSync from start to finish, so between
// tests the worker drains only microtasks and never reads a message. Vitest's
// worker sends its task updates to the main thread and waits for the reply,
// which sat unread across the whole file, more than a minute, until the call
// timed out as an unhandled "Timeout calling onTaskUpdate" with every test
// passed. One turn of the event loop after each test lets the reply in.
afterEach(async () => {
  rmSync(root, { recursive: true, force: true });
  await new Promise((resolve) => setImmediate(resolve));
});

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
  log: string[];
}

function install(target?: string, env: Record<string, string> = {}, script = join(repo, 'install.sh')): Run {
  writeFileSync(log, '');
  const result = spawnSync(BASH, target === undefined ? [script] : [script, target], {
    encoding: 'utf8',
    env: {
      PATH: [join(pnpmHome, 'bin'), bin].join(delimiter),
      HOME: root,
      GIT_CONFIG_NOSYSTEM: '1',
      FAKE_LOG: log,
      FAKE_PNPM_HOME: pnpmHome,
      FAKE_CLI: join(root, 'cli.js'),
      TMPDIR: join(root, 'tmp'),
      ...env,
    },
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    log: readFileSync(log, 'utf8').split('\n').filter(Boolean),
  };
}

// The installer in a pseudo-terminal, through script(1), whose arguments
// differ between macOS and util-linux. Its output is the terminal's.
const SCRIPT = which('script');
function inTerminal(target: string, env: Record<string, string> = {}): Run {
  if (SCRIPT === undefined) throw new Error('these tests need script(1) on PATH');
  writeFileSync(log, '');
  const command = [BASH, join(repo, 'install.sh'), target];
  const args =
    process.platform === 'darwin'
      ? ['-q', '/dev/null', ...command]
      : ['-qec', command.map((arg) => `'${arg.replace(/'/g, `'\\''`)}'`).join(' '), '/dev/null'];
  const result = spawnSync(SCRIPT, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: [join(pnpmHome, 'bin'), bin].join(delimiter),
      HOME: root,
      GIT_CONFIG_NOSYSTEM: '1',
      FAKE_LOG: log,
      FAKE_PNPM_HOME: pnpmHome,
      FAKE_CLI: join(root, 'cli.js'),
      TMPDIR: join(root, 'tmp'),
      TERM: 'xterm',
      ...env,
    },
  });
  return {
    status: result.status,
    stdout: result.stdout.replace(/\r\n/g, '\n'),
    stderr: result.stderr,
    log: readFileSync(log, 'utf8').split('\n').filter(Boolean),
  };
}

// The rows of a status, keyed by label, the warning marker dropped.
function rows(stdout: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    const match = /^(\S+)\s+(?:⚠️ {2})?(.*)$/.exec(line);
    if (match) map.set(match[1]!, match[2]!);
  }
  return map;
}

// The commands a run made that change something: everything but pnpm's
// queries.
function changes(run: Run): string[] {
  return run.log.filter((line) => !/^pnpm (ls|bin|--version)/.test(line));
}

function linkTo(target: string): void {
  mkdirSync(join(pnpmHome, 'global'), { recursive: true });
  mkdirSync(join(pnpmHome, 'bin'), { recursive: true });
  symlinkSync(target, join(pnpmHome, 'global', 'field'));
}

interface Publish {
  repo?: string;
  ref?: string;
  // The archive's top-level directory, which GitHub names <repo>-<version>.
  prefix?: string;
  archive?: boolean;
  // The version's own install.sh, when it is not this one.
  installer?: string;
}

// Releases a version as the Release workflow does: package.json raised on
// upstream's main and tagged vX.Y.Z, and the ref (v0) moved to it, as an
// annotated tag unless the ref is upstream's branch. The stand-in git
// serves upstream as the repository's git server, and the stand-in curl
// serves package.json and the installer from "raw", at the commit and at
// the ref, and the tag's source archive, made as GitHub makes one, from
// "github". Returns the commit.
function publish(version: string, options: Publish = {}): string {
  const slug = options.repo ?? 'audiofield/field';
  const ref = options.ref ?? 'v0';
  const manifest = `{\n  "name": "field",\n  "version": "${version}"\n}\n`;
  write(join(upstream, 'package.json'), manifest);
  if (options.installer !== undefined) write(join(upstream, 'install.sh'), options.installer);
  git(upstream, 'commit', '--quiet', '-am', `release ${version}`);
  git(upstream, 'tag', `v${version}`);
  if (git(upstream, 'branch', '--list', ref) === '') git(upstream, 'tag', '-f', '-a', '-m', ref, ref);
  const server = join(serve, 'git', `${slug}.git`);
  if (!existsSync(server)) {
    mkdirSync(dirname(server), { recursive: true });
    symlinkSync(upstream, server);
  }
  const commit = git(upstream, 'rev-parse', 'HEAD');
  for (const at of [commit, ref]) {
    write(join(serve, 'raw', slug, at, 'package.json'), manifest);
    write(join(serve, 'raw', slug, at, 'install.sh'), readFileSync(join(packageRoot, 'install.sh'), 'utf8'));
  }
  if (options.archive === false) return commit;
  const archive = join(serve, 'github', slug, 'archive', 'refs', 'tags', `v${version}.tar.gz`);
  mkdirSync(dirname(archive), { recursive: true });
  git(upstream, 'archive', '--format=tar.gz', `--prefix=${options.prefix ?? `field-${version}`}/`, '-o', archive, `v${version}`);
  return commit;
}

// A release installer, the downloaded one unless named, with the release
// CLI and the bin directory on PATH.
function release(target?: string, env: Record<string, string> = {}, script = downloaded): Run {
  return install(
    target,
    {
      FAKE_SERVE: serve,
      FAKE_CLI: join(root, 'release-cli.js'),
      PATH: [join(pnpmHome, 'bin'), join(root, '.local', 'bin'), bin].join(delimiter),
      ...env,
    },
    script,
  );
}

// The shim, run as a shell runs `field`.
function field(...args: string[]): { status: number | null; stdout: string } {
  const result = spawnSync(shim, args, { encoding: 'utf8', env: { PATH: bin, FAKE_LOG: log } });
  return { status: result.status, stdout: result.stdout };
}

function current(dir = data): string {
  return readlinkSync(join(dir, 'current'));
}

posix('install.sh cli', () => {
  it('installs, builds the CLI and the UI, and links the checkout, in that order', () => {
    const run = install('cli');
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(changes(run)).toEqual([
      `pnpm --dir ${repo} install --frozen-lockfile`,
      `pnpm --dir ${repo} run build`,
      `pnpm --dir ${repo} run build:ui`,
      `pnpm add -g ${repo}`,
    ]);
    expect(readlinkSync(join(pnpmHome, 'global', 'field'))).toBe(repo);
    expect(rows(run.stdout).get('linked')).toBe('~/pnpm/bin/field -> ~/checkout');
  });

  it('leaves a link that already points here alone, and builds anyway', () => {
    linkTo(repo);
    const run = install('cli');
    expect(run.status).toBe(0);
    expect(run.log).not.toContain(`pnpm add -g ${repo}`);
    expect(run.log).toContain(`pnpm --dir ${repo} run build`);
    expect(run.log).toContain(`pnpm --dir ${repo} run build:ui`);
  });

  it('stops before linking when the UI does not build', () => {
    const run = install('cli', { FAKE_UI_FAILS: '1' });
    expect(run.status).toBe(2);
    expect(run.log.some((line) => line.startsWith('pnpm add'))).toBe(false);
  });

  it('moves a link from another checkout, and says so', () => {
    const other = join(root, 'other');
    mkdirSync(other);
    linkTo(other);
    const run = install('cli');
    expect(run.status).toBe(0);
    expect(run.log).toContain(`pnpm add -g ${repo}`);
    expect(rows(run.stdout).get('moved')).toBe('field ~/other -> ~/checkout');
  });

  it('stops before installing anything when pnpm has no global bin directory', () => {
    const run = install('cli', { FAKE_NO_GLOBAL_BIN: '1' });
    expect(run.status).toBe(69);
    expect(run.stderr).toContain('run pnpm setup');
    expect(changes(run)).toEqual([]);
  });

  it('stops before installing anything when that directory is not on PATH', () => {
    const run = install('cli', { PATH: bin });
    expect(run.status).toBe(69);
    expect(run.stderr).toContain(`pnpm's global bin directory ${pnpmHome}/bin is not on PATH`);
    expect(changes(run)).toEqual([]);
  });

  it('needs no global bin directory on PATH when the link already points here', () => {
    linkTo(repo);
    const run = install('cli', { PATH: bin });
    expect(run.status).toBe(0);
    expect(run.log).toContain(`pnpm --dir ${repo} run build`);
  });

  it('refuses a Node older than 24 before touching anything', () => {
    rmSync(join(bin, 'node'));
    write(join(bin, 'node'), `#!${BASH}\necho v22.11.0\n`, 0o755);
    const run = install('cli');
    expect(run.status).toBe(69);
    expect(run.stderr).toContain('Field needs Node 24 or newer, and node is 22.11.0');
    expect(run.log.some((line) => line.includes('install'))).toBe(false);
  });

  it('names corepack on Linux when pnpm is missing and Node has corepack', () => {
    rmSync(join(bin, 'pnpm'));
    write(join(bin, 'corepack'), `#!${BASH}\n`, 0o755);
    const run = install('cli', { FAKE_UNAME: 'Linux' });
    expect(run.status).toBe(69);
    expect(run.stderr).toContain('  corepack enable pnpm\n');
  });

  // Node 25 and newer ship without corepack, so naming it there sends the
  // reader to a command that is not found.
  it("names pnpm's installation page on Linux when Node has no corepack", () => {
    rmSync(join(bin, 'pnpm'));
    const run = install('cli', { FAKE_UNAME: 'Linux' });
    expect(run.status).toBe(69);
    expect(run.stderr).toContain('  # pnpm, from https://pnpm.io/installation\n');
    expect(run.stderr).not.toContain('corepack');
  });

  it('names Homebrew on macOS when pnpm is missing', () => {
    rmSync(join(bin, 'pnpm'));
    const run = install('cli', { FAKE_UNAME: 'Darwin' });
    expect(run.status).toBe(69);
    expect(run.stderr).toContain('  brew install pnpm\n');
  });

  it('builds the CLI without the tools only the daemon needs', () => {
    for (const tool of ['cmake', 'c++', 'make', 'xcode-select']) rmSync(join(bin, tool));
    expect(install('cli').status).toBe(0);
  });
});

posix('install.sh before it changes anything', () => {
  it('names everything missing on macOS at once, and the commands that install it', () => {
    for (const tool of ['node', 'pnpm', 'cmake', 'xcode-select']) rmSync(join(bin, tool));
    const run = install(undefined, { FAKE_UNAME: 'Darwin' });
    expect(run.status).toBe(69);
    for (const label of ['node-missing', 'pnpm-missing', 'cmake-missing', 'xcode-missing']) {
      expect(run.stderr).toContain(`  ${label} `);
    }
    // The command line tools first, because Homebrew needs them too.
    expect(run.stderr).toContain(
      '  xcode-select --install\n  # Homebrew first, from https://brew.sh\n  brew install node pnpm cmake\n',
    );
    expect(run.stderr).toContain(`Then open a new shell and run ~/checkout/install.sh all again.`);
    expect(changes(run)).toEqual([]);
  });

  it('leaves Homebrew out of the steps when it is installed', () => {
    rmSync(join(bin, 'cmake'));
    write(join(bin, 'brew'), `#!${BASH}\n`, 0o755);
    const run = install('audiod', { FAKE_UNAME: 'Darwin' });
    expect(run.status).toBe(69);
    expect(run.stderr).toContain('Install what is missing:\n\n  brew install cmake\n\n');
  });

  it('names the Debian packages on Linux, and what no package covers', () => {
    for (const tool of ['node', 'c++', 'git']) rmSync(join(bin, tool));
    write(join(bin, 'apt-get'), `#!${BASH}\n`, 0o755);
    const run = install(undefined, { FAKE_UNAME: 'Linux', FAKE_NO_HEADERS: 'alsa x11' });
    expect(run.status).toBe(69);
    expect(run.stderr).toContain('  compiler-missing ');
    expect(run.stderr).toContain('  git-missing ');
    expect(run.stderr).toContain('pkg-config finds no alsa x11');
    expect(run.stderr).toContain(
      '  sudo apt-get install -y build-essential git libasound2-dev libfreetype-dev libfontconfig1-dev',
    );
    expect(run.stderr).toContain('  # Node 24 or newer, from https://nodejs.org/en/download\n');
    expect(run.stderr).not.toContain("your distribution's package manager");
    expect(changes(run)).toEqual([]);
  });

  it("says the Debian names are to translate on a Linux without apt-get", () => {
    const run = install('audiod', { FAKE_UNAME: 'Linux', FAKE_NO_HEADERS: 'glu' });
    expect(run.status).toBe(69);
    expect(run.stderr).toContain("install the same with your distribution's package manager");
    expect(run.stderr).toContain('libglu1-mesa-dev');
  });

  // build:native runs CMake's default generator, which on Linux is Unix
  // Makefiles, and a compiler installed without build-essential brings no
  // make.
  it('names make on Linux when there is a compiler and no make', () => {
    rmSync(join(bin, 'make'));
    write(join(bin, 'apt-get'), `#!${BASH}\n`, 0o755);
    const run = install('audiod', { FAKE_UNAME: 'Linux' });
    expect(run.status).toBe(69);
    expect(run.stderr).toContain('  make-missing ');
    expect(run.stderr).toContain('  sudo apt-get install -y make\n');
    expect(changes(run)).toEqual([]);
  });

  it('needs no make when CMAKE_GENERATOR names another generator', () => {
    rmSync(join(bin, 'make'));
    expect(install('audiod', { FAKE_UNAME: 'Linux', CMAKE_GENERATOR: 'Ninja' }).status).toBe(0);
  });

  it('asks for the headers too when there is no pkg-config to look for them', () => {
    rmSync(join(bin, 'pkg-config'));
    const run = install('audiod', { FAKE_UNAME: 'Linux' });
    expect(run.status).toBe(69);
    expect(run.stderr).toContain('  pkg-config-missing ');
    expect(run.stderr).toContain('  headers-unchecked ');
    expect(run.stderr).toContain('apt-get install -y pkg-config libasound2-dev');
  });

  // Ubuntu 22.04 packages CMake 3.22 and Debian 11 3.18, so the cmake
  // package there installs one the next run rejects as too old.
  it('names cmake.org on Linux for a missing CMake when apt-get would install one too old', () => {
    rmSync(join(bin, 'cmake'));
    write(join(bin, 'apt-get'), `#!${BASH}\n`, 0o755);
    write(join(bin, 'apt-cache'), `#!${BASH}\nprintf 'cmake:\\n  Installed: (none)\\n  Candidate: 3.22.1-1ubuntu1\\n'\n`, 0o755);
    const run = install('audiod', { FAKE_UNAME: 'Linux' });
    expect(run.status).toBe(69);
    expect(run.stderr).toContain('needs CMake 3.24 or newer, and apt-get would install 3.22.1');
    expect(run.stderr).toContain('  # CMake 3.24 or newer, from https://cmake.org/download/\n');
    expect(run.stderr).not.toContain('apt-get install');
  });

  it('names the cmake package on Linux when apt-get would install a new enough one', () => {
    rmSync(join(bin, 'cmake'));
    write(join(bin, 'apt-get'), `#!${BASH}\n`, 0o755);
    write(join(bin, 'apt-cache'), `#!${BASH}\nprintf 'cmake:\\n  Installed: (none)\\n  Candidate: 3.28.3-1build7\\n'\n`, 0o755);
    const run = install('audiod', { FAKE_UNAME: 'Linux' });
    expect(run.status).toBe(69);
    expect(run.stderr).toContain('  sudo apt-get install -y cmake\n');
    expect(run.stderr).not.toContain('cmake.org');
  });

  it('checks for no headers on macOS, where JUCE uses the system frameworks', () => {
    rmSync(join(bin, 'pkg-config'));
    expect(install('audiod', { FAKE_UNAME: 'Darwin' }).status).toBe(0);
  });
});

posix('install.sh audiod and workers', () => {
  it('builds the daemon through pnpm build:native', () => {
    const run = install('audiod');
    expect(run.status).toBe(0);
    expect(run.log).toContain(`pnpm --dir ${repo} run build:native`);
    expect(rows(run.stdout).get('building')).toBe('field-audiod, takes a while');
    expect(rows(run.stdout).get('built')).toBe(`~/checkout/${AUDIOD}`);
    // A rebuild is not announced as a first build.
    expect(rows(install('audiod').stdout).has('building')).toBe(false);
  });

  it('refuses to build the daemon without CMake', () => {
    rmSync(join(bin, 'cmake'));
    const run = install('audiod');
    expect(run.status).toBe(69);
    expect(run.stderr).toContain('CMake 3.24 or newer');
    expect(run.log).not.toContain(`pnpm --dir ${repo} run build:native`);
  });

  it('stops before installing anything when everything is asked for without CMake', () => {
    rmSync(join(bin, 'cmake'));
    const run = install();
    expect(run.status).toBe(69);
    expect(run.stderr).toContain('CMake 3.24 or newer');
    expect(changes(run)).toEqual([]);
  });

  it('refuses a CMake older than 3.24 before installing anything', () => {
    write(join(bin, 'cmake'), `#!${BASH}\necho "cmake version 3.22.1"\n`, 0o755);
    const run = install();
    expect(run.status).toBe(69);
    expect(run.stderr).toContain('needs CMake 3.24 or newer, and cmake is 3.22.1');
    expect(changes(run)).toEqual([]);
  });

  it('takes a CMake of a newer major version', () => {
    write(join(bin, 'cmake'), `#!${BASH}\necho "cmake version 4.0.0"\n`, 0o755);
    expect(install('audiod').status).toBe(0);
  });

  it("leaves JUCE's download in the checkout's own build directory", () => {
    expect(install('audiod').status).toBe(0);
    expect(readFileSync(join(repo, 'native/audiod/build/fetchcontent'), 'utf8')).toBe('unset\n');
  });

  it('fails when the daemon does not build', () => {
    const run = install('audiod', { FAKE_NATIVE_FAILS: '1' });
    expect(run.status).toBe(1);
    expect(rows(run.stdout).has('built')).toBe(false);
  });

  it('keeps build output off the screen, and removes its log once the target succeeds', () => {
    const run = install('cli');
    expect(run.status).toBe(0);
    expect(run.stdout).not.toContain('Packages: +122');
    expect(rows(run.stdout).has('linked')).toBe(true);
    expect(readdirSync(join(root, 'tmp'))).toEqual([]);
  });

  it("prints the end of a failed step's output, and keeps the log", () => {
    const run = install('audiod', { FAKE_NATIVE_FAILS: '1' });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(
      'install.sh: pnpm --dir ~/checkout run build:native exited with status 2. The end of its output:\n\n  cmake: JUCE did not compile\n',
    );
    const logs = readdirSync(join(root, 'tmp'));
    expect(logs).toHaveLength(1);
    expect(run.stderr).toContain(`The whole log is in ${join(root, 'tmp', logs[0]!)}\n`);
    expect(readFileSync(join(root, 'tmp', logs[0]!), 'utf8')).toBe(
      `$ pnpm --dir ${repo} run build:native\ncmake: JUCE did not compile\n`,
    );
  });

  it('draws build output in a dimmed window no wider than the terminal, and erases it', () => {
    const run = inTerminal('cli', { COLUMNS: '24' });
    expect(run.status).toBe(0);
    // Each line the window draws: the escape that clears the row and
    // dims, the text, and the escape that resets.
    const drawn = [...run.stdout.matchAll(/\x1b\[2K\x1b\[2m(.*?)\x1b\[0m/g)].map((match) => match[1]!);
    expect(drawn).toContain('  Packages: +122');
    expect(drawn).toContain(`  ${'?'.repeat(19)}`);
    for (const line of drawn) {
      expect(line).toMatch(/^[\x20-\x7e]*$/);
      expect(line.length).toBeLessThan(24);
    }
    // Erased, so nothing of the build is left among the rows after it.
    const after = run.stdout.slice(run.stdout.lastIndexOf('\x1b[J'));
    expect(after).not.toContain('Packages');
    expect(rows(after.slice('\x1b[J'.length)).has('linked')).toBe(true);
    expect(readdirSync(join(root, 'tmp'))).toEqual([]);
  });

  it('shows every line of build output with FIELD_VERBOSE', () => {
    const run = install('cli', { FIELD_VERBOSE: '1' });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('Packages: +122\n');
    expect(readdirSync(join(root, 'tmp'))).toEqual([]);
  });

  it('re-syncs workers through the CLI, which knows which are set up', () => {
    install('cli');
    const run = install('workers');
    expect(run.status).toBe(0);
    expect(run.log).toContain('field setup --existing');
  });

  it('needs the CLI built before it can sync workers', () => {
    const run = install('workers');
    expect(run.status).toBe(69);
    expect(run.stderr).toContain('run ~/checkout/install.sh cli first');
  });

  it('installs everything with no target', () => {
    const run = install();
    expect(run.status).toBe(0);
    expect(run.log).toEqual(
      expect.arrayContaining([
        `pnpm --dir ${repo} run build`,
        `pnpm add -g ${repo}`,
        `pnpm --dir ${repo} run build:native`,
        'field setup --existing',
      ]),
    );
  });
});

posix('install.sh status', () => {
  it('reports a fresh checkout as installing nothing yet', () => {
    const run = install('status');
    expect(run.status).toBe(0);
    const status = rows(run.stdout);
    expect(status.get('checkout')).toMatch(/^~\/checkout \(main at [0-9a-f]{7}\)$/);
    expect(status.get('repo-current')).toBe('main matches origin/main');
    expect(status.get('cli-missing')).toBe('pnpm links no field — run ~/checkout/install.sh cli');
    expect(status.get('cli-unbuilt')).toContain('dist/ holds no build');
    expect(status.get('ui-missing')).toBe('ui/dist holds no build, so field ui cannot open — run ~/checkout/install.sh cli');
    expect(status.get('audiod-missing')).toBe('field-audiod is not built — run ~/checkout/install.sh audiod');
    expect(status.get('workers')).toBe('unknown until the CLI is built');
    expect(status.get('cmake')).toBe('3.30.2');
  });

  it('reports an install of this checkout as current, and names field upgrade as the way back', () => {
    install();
    const status = rows(install('status').stdout);
    expect(status.get('cli')).toBe('~/pnpm/bin/field -> ~/checkout');
    expect(status.get('cli-current')).toMatch(/^built from [0-9a-f]{7}$/);
    expect(status.get('ui-current')).toBe('~/checkout/ui/dist');
    expect(status.get('audiod-current')).toBe(`~/checkout/${AUDIOD}`);
    expect(status.get('worker-current')).toBe('field-aced');
    expect(status.get('worker-stale')).toBe('field-voiced is out of date — run field setup voiced');
    expect(install('status').stdout).toContain('worker-stale   ⚠️  field-voiced');
  });

  it('reports a build behind a new commit as stale', () => {
    install();
    const built = git(repo, 'rev-parse', '--short', 'HEAD');
    write(join(repo, 'src/more.ts'), '');
    git(repo, 'add', '.');
    git(repo, 'commit', '--quiet', '-m', 'two');
    const head = git(repo, 'rev-parse', '--short', 'HEAD');
    expect(rows(install('status').stdout).get('cli-stale')).toBe(
      `dist/ was built from ${built}, and the checkout is at ${head} — run field upgrade cli`,
    );
  });

  it('reports a build behind an uncommitted edit as stale', () => {
    install();
    write(join(repo, 'src/cli.ts'), 'edited');
    expect(rows(install('status').stdout).get('cli-stale')).toBe(
      'dist/ was built with 0 uncommitted changes, and the checkout has 1 — run field upgrade cli',
    );
  });

  it('names the file the UI bundles that changed since the UI was built', () => {
    install();
    const past = new Date(Date.now() - 60_000);
    utimesSync(join(repo, 'ui/dist/index.html'), past, past);
    expect(rows(install('status').stdout).get('ui-stale')).toBe(
      'src/cli.ts changed since the UI was built — run field upgrade cli',
    );
  });

  it('leaves tests out of the UI comparison, because no build reads them', () => {
    install();
    const built = new Date(Date.now() - 30_000);
    const sources = new Date(Date.now() - 60_000);
    utimesSync(join(repo, 'ui/dist/index.html'), built, built);
    for (const file of ['src/cli.ts', 'ui/src/main.tsx']) utimesSync(join(repo, file), sources, sources);
    write(join(repo, 'src/cli.test.ts'), '');
    git(repo, 'add', '.');
    git(repo, 'commit', '--quiet', '-m', 'a test');
    expect(rows(install('status').stdout).get('ui-current')).toBe('~/checkout/ui/dist');
  });

  it('names the daemon source that changed since the daemon was built', () => {
    install();
    const past = new Date(Date.now() - 60_000);
    utimesSync(join(repo, AUDIOD), past, past);
    expect(rows(install('status').stdout).get('audiod-stale')).toBe(
      'native/audiod/CMakeLists.txt changed since field-audiod was built — run field upgrade audiod',
    );
  });

  it('counts the ring header, FieldOut, and the macOS SDK file, which the same build reads, as daemon sources', () => {
    install();
    const built = new Date(Date.now() - 30_000);
    const sources = new Date(Date.now() - 60_000);
    utimesSync(join(repo, AUDIOD), built, built);
    for (const file of ['native/audiod/CMakeLists.txt', 'native/audiod/src/main.cpp']) utimesSync(join(repo, file), sources, sources);
    expect(rows(install('status').stdout).has('audiod-current')).toBe(true);
    write(join(repo, 'native/ring/field_ring.h'), '');
    git(repo, 'add', '.');
    git(repo, 'commit', '--quiet', '-m', 'the ring');
    expect(rows(install('status').stdout).get('audiod-stale')).toBe(
      'native/ring/field_ring.h changed since field-audiod was built — run field upgrade audiod',
    );
    utimesSync(join(repo, 'native/ring/field_ring.h'), sources, sources);
    write(join(repo, 'native/sc-fieldout/FieldOut.cpp'), '');
    git(repo, 'add', '.');
    git(repo, 'commit', '--quiet', '-m', 'FieldOut');
    expect(rows(install('status').stdout).get('audiod-stale')).toBe(
      'native/sc-fieldout/FieldOut.cpp changed since field-audiod was built — run field upgrade audiod',
    );
    utimesSync(join(repo, 'native/sc-fieldout/FieldOut.cpp'), sources, sources);
    write(join(repo, 'native/macos-sdk.cmake'), '');
    git(repo, 'add', '.');
    git(repo, 'commit', '--quiet', '-m', 'the SDK');
    expect(rows(install('status').stdout).get('audiod-stale')).toBe(
      'native/macos-sdk.cmake changed since field-audiod was built — run field upgrade audiod',
    );
  });

  it('reports the daemon current after the rebuild it names, though CMake relinked nothing', () => {
    install();
    const past = new Date(Date.now() - 60_000);
    utimesSync(join(repo, AUDIOD), past, past);
    expect(rows(install('status').stdout).has('audiod-stale')).toBe(true);
    expect(install('audiod').status).toBe(0);
    expect(rows(install('status').stdout).get('audiod-current')).toBe(`~/checkout/${AUDIOD}`);
  });

  it('says when field links another checkout', () => {
    const other = join(root, 'other');
    mkdirSync(other);
    linkTo(other);
    expect(rows(install('status').stdout).get('cli-elsewhere')).toBe(
      'field links ~/other, not this checkout — run ~/checkout/install.sh cli to link this one',
    );
  });

  it("says when another field is ahead of pnpm's on PATH", () => {
    install('cli');
    const elsewhere = join(root, 'elsewhere');
    write(join(elsewhere, 'field'), '#!/bin/sh\n', 0o755);
    const run = install('status', { PATH: [elsewhere, join(pnpmHome, 'bin'), bin].join(delimiter) });
    expect(rows(run.stdout).get('cli-shadowed')).toBe(
      "field on PATH is ~/elsewhere/field, ahead of pnpm's ~/pnpm/bin/field",
    );
  });

  it("names a release install's shim when it is ahead of pnpm's field on PATH", () => {
    install('cli');
    write(shim, "#!/bin/sh\n# Field's release shim, written by install.sh. It runs the version that\n", 0o755);
    const run = install('status', { PATH: [join(root, '.local', 'bin'), join(pnpmHome, 'bin'), bin].join(delimiter) });
    expect(rows(run.stdout).get('cli-shadowed')).toBe(
      "field on PATH is ~/.local/bin/field, a release install's shim, ahead of pnpm's ~/pnpm/bin/field",
    );
  });

  it('says how far the checkout is behind its upstream', () => {
    write(join(upstream, 'src/new.ts'), '');
    git(upstream, 'add', '.');
    git(upstream, 'commit', '--quiet', '-m', 'two');
    // Offline, it compares against the last fetch, which was the clone.
    expect(rows(install('status', { FIELD_OFFLINE: '1' }).stdout).get('repo-current')).toBe(
      'main matches origin/main (offline; compared against the last fetch of origin)',
    );
    expect(rows(install('status').stdout).get('repo-behind')).toBe(
      'main is 1 commit behind origin/main — run git pull in ~/checkout, then ~/checkout/install.sh all',
    );
  });

  it('says a branch with unpushed commits is ahead of its upstream, rather than that it matches', () => {
    write(join(repo, 'src/local.ts'), '');
    git(repo, 'add', '.');
    git(repo, 'commit', '--quiet', '-m', 'local');
    const status = rows(install('status').stdout);
    expect(status.has('repo-current')).toBe(false);
    expect(status.get('repo-ahead')).toBe('main is 1 commit ahead of origin/main');
  });

  it('says when CMake is too old to build the daemon', () => {
    write(join(bin, 'cmake'), `#!${BASH}\necho "cmake version 3.22.1"\n`, 0o755);
    expect(rows(install('status').stdout).get('cmake-old')).toBe(
      '3.22.1 — building field-audiod needs CMake 3.24 or newer',
    );
  });

  it('notes a FIELD_AUDIOD override', () => {
    expect(rows(install('status', { FIELD_AUDIOD: '/opt/field-audiod' }).stdout).get('audiod-override')).toBe(
      'FIELD_AUDIOD is set, so field runs /opt/field-audiod instead of this build',
    );
  });
});

// Reads files only, so it runs on Windows too.
describe('install.sh constants', () => {
  it('requires the CMake that native/audiod/CMakeLists.txt does', () => {
    const cmake = readFileSync(join(packageRoot, 'native/audiod/CMakeLists.txt'), 'utf8');
    const script = readFileSync(join(packageRoot, 'install.sh'), 'utf8');
    const required = /cmake_minimum_required\(VERSION (\d+)\.(\d+)/.exec(cmake);
    expect(required).not.toBeNull();
    expect(/^CMAKE_MAJOR=(\d+)$/m.exec(script)?.[1]).toBe(required![1]);
    expect(/^CMAKE_MINOR=(\d+)$/m.exec(script)?.[1]).toBe(required![2]);
  });

  it('sets the JUCE download directory that native/audiod/CMakeLists.txt reads before it fetches JUCE', () => {
    const cmake = readFileSync(join(packageRoot, 'native/audiod/CMakeLists.txt'), 'utf8');
    const script = readFileSync(join(packageRoot, 'install.sh'), 'utf8');
    const reads = cmake.indexOf('$ENV{FIELD_FETCHCONTENT_BASE_DIR}');
    expect(reads).toBeGreaterThan(-1);
    expect(reads).toBeLessThan(cmake.indexOf('include(FetchContent)'));
    expect(script).toContain('export FIELD_FETCHCONTENT_BASE_DIR="$FETCH_CACHE"');
  });
});

// install.md §2.1, as amended: a checkout is the script in a git work tree
// with the CLI's source beside it, and anything else is a release.
posix('install.sh tells a checkout from a release', () => {
  it('installs a checkout as a checkout', () => {
    const status = rows(install('status').stdout);
    expect(status.has('checkout')).toBe(true);
    expect(status.has('release')).toBe(false);
  });

  it('installs a release from a copy of the source without .git, as a source archive is', () => {
    publish('0.2.0');
    const unpacked = join(root, 'unpacked');
    write(join(unpacked, 'install.sh'), readFileSync(join(repo, 'install.sh'), 'utf8'));
    write(join(unpacked, 'src/cli.ts'), '');
    const run = install('status', { FAKE_SERVE: serve }, join(unpacked, 'install.sh'));
    const status = rows(run.stdout);
    expect(status.has('checkout')).toBe(false);
    expect(status.get('release')).toBe('audiofield/field v0 is at 0.2.0');
    expect(status.get('not-installed')).toContain('no release of Field is installed in ~/.local/share/field');
  });

  it('installs a release when bash reads it from curl', () => {
    publish('0.2.0');
    const result = spawnSync(BASH, ['-s', '--', 'status'], {
      input: readFileSync(downloaded, 'utf8'),
      encoding: 'utf8',
      env: { PATH: bin, HOME: root, FAKE_LOG: log, FAKE_SERVE: serve },
    });
    expect(result.status).toBe(0);
    expect(rows(result.stdout).get('not-installed')).toBe(
      'no release of Field is installed in ~/.local/share/field — run curl -fsSL https://raw.githubusercontent.com/audiofield/field/v0/install.sh | bash',
    );
  });
});

posix('install.sh installs a release', () => {
  it('builds the version v0 names in a directory of its own, switches current to it, and links the shim', () => {
    const commit = publish('0.2.0');
    const run = release();
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    const version = join(data, '0.2.0');
    expect(changes(run)).toEqual([
      'git ls-remote https://github.com/audiofield/field.git',
      `curl https://raw.githubusercontent.com/audiofield/field/${commit}/package.json`,
      'curl https://github.com/audiofield/field/archive/refs/tags/v0.2.0.tar.gz',
      `pnpm --dir ${version} install --frozen-lockfile`,
      `pnpm --dir ${version} run build`,
      `pnpm --dir ${version} run build:ui`,
      `pnpm --dir ${version} run build:native`,
    ]);
    expect(current()).toBe('0.2.0');
    expect(readFileSync(join(data, 'release.conf'), 'utf8')).toBe(
      `repo=audiofield/field\nref=v0\nbin=${join(root, '.local', 'bin')}\n`,
    );
    // JUCE's download goes to a cache beside the versions, not into this one.
    expect(readFileSync(join(version, 'native/audiod/build/fetchcontent'), 'utf8')).toBe(
      `${join(data, 'cache', 'fetchcontent')}\n`,
    );
    const status = rows(run.stdout);
    expect(status.get('release')).toBe('audiofield/field v0 is at 0.2.0');
    expect(status.get('switched')).toBe('~/.local/share/field/current -> 0.2.0');
    expect(status.get('linked')).toBe('~/.local/bin/field -> ~/.local/share/field/current');
    expect(status.get('cli')).toBe('~/.local/bin/field -> ~/.local/share/field/current');
    expect(field('--version')).toEqual({ status: 0, stdout: '0.2.0\n' });
  });

  it('upgrades to the next release, keeps the version it replaced, and removes the one before that', () => {
    publish('0.2.0');
    expect(release().status).toBe(0);
    publish('0.3.0');
    expect(release().status).toBe(0);
    expect(current()).toBe('0.3.0');
    expect(field('--version').stdout).toBe('0.3.0\n');
    expect(existsSync(join(data, '0.2.0'))).toBe(true);
    publish('0.4.0');
    const run = release();
    expect(run.status).toBe(0);
    expect(current()).toBe('0.4.0');
    expect(existsSync(join(data, '0.3.0'))).toBe(true);
    expect(existsSync(join(data, '0.2.0'))).toBe(false);
    expect(rows(run.stdout).get('removed')).toBe('0.2.0');
  });

  it('removes only the versions and downloads it made, in a data directory that holds other things', () => {
    const others = ['2024.01.15 photos/a.jpg', '3.11.4/bin/python3', '.download-9.9.9/notes', 'notes/todo'];
    for (const path of others) write(join(data, path), '');
    // What a run killed while it downloaded leaves.
    mkdirSync(join(data, '.download-0.1.0', 'unpacked'), { recursive: true });
    publish('0.2.0');
    release();
    publish('0.3.0');
    const run = release();
    expect(run.status).toBe(0);
    for (const path of others) expect(existsSync(join(data, path))).toBe(true);
    expect(existsSync(join(data, '.download-0.1.0'))).toBe(false);
    expect(run.stdout).not.toContain('3.11.4');
    const status = release('status').stdout;
    expect(status).not.toContain('3.11.4');
    expect(rows(status).get('previous')).toBe('0.2.0 in ~/.local/share/field/0.2.0, kept to switch back to by hand');
  });

  it('refuses to replace a directory named for the version that it did not install', () => {
    write(join(data, '0.2.0', 'mine'), 'keep\n');
    publish('0.2.0');
    const run = release();
    expect(run.status).toBe(69);
    expect(run.stderr).toContain('~/.local/share/field/0.2.0 is in the way, and it is not a version Field installed');
    expect(readFileSync(join(data, '0.2.0', 'mine'), 'utf8')).toBe('keep\n');
    expect(existsSync(join(data, 'current'))).toBe(false);
    expect(run.log.some((line) => line.startsWith('pnpm') || line.includes('archive'))).toBe(false);
  });

  it('leaves the installed version current when the download fails', () => {
    publish('0.2.0');
    release();
    publish('0.3.0', { archive: false });
    const run = release();
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('could not download https://github.com/audiofield/field/archive/refs/tags/v0.3.0.tar.gz');
    expect(run.stderr).toContain('0.3.0 did not install, so 0.2.0 stays current and field still runs it');
    expect(current()).toBe('0.2.0');
    expect(field('--version').stdout).toBe('0.2.0\n');
    expect(existsSync(join(data, '.download-0.3.0'))).toBe(false);
  });

  it('leaves the installed version current when the new one does not build, and installs it on the next run', () => {
    publish('0.2.0');
    release();
    publish('0.3.0');
    const run = release(undefined, { FAKE_NATIVE_FAILS: '1' });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('0.3.0 did not install, so 0.2.0 stays current');
    expect(current()).toBe('0.2.0');
    expect(field('--version').stdout).toBe('0.2.0\n');
    // Removed, so status never offers it as a version to switch back to.
    expect(existsSync(join(data, '0.3.0'))).toBe(false);
    expect(rows(release('status').stdout).has('previous')).toBe(false);
    expect(release().status).toBe(0);
    expect(current()).toBe('0.3.0');
  });

  it('says nothing was switched when the first install fails', () => {
    publish('0.2.0');
    const run = release(undefined, { FAKE_UI_FAILS: '1' });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('0.2.0 did not install, and nothing was switched to it');
    expect(existsSync(join(data, 'current'))).toBe(false);
    expect(existsSync(join(data, '0.2.0'))).toBe(false);
    expect(existsSync(shim)).toBe(false);
  });

  it('sets up again in the new version each worker set up in the version it replaces, before switching', () => {
    publish('0.2.0');
    release();
    field('setup', 'aced');
    publish('0.3.0');
    const run = release();
    expect(run.status).toBe(0);
    expect(run.log).toContain('field@0.2.0 setup --check');
    expect(run.log).toContain('field@0.3.0 setup field-aced');
    expect(run.log).not.toContain('field@0.3.0 setup field-voiced');
    expect(existsSync(join(data, '0.3.0', 'python', 'aced', '.venv', 'set-up'))).toBe(true);
    expect(rows(run.stdout).get('setting-up')).toBe('field-aced in 0.3.0, as it was in 0.2.0');
  });

  it('leaves the installed version current when a worker does not set up in the new one', () => {
    publish('0.2.0');
    release();
    field('setup', 'aced');
    publish('0.3.0');
    const run = release(undefined, { FAKE_SETUP_FAILS: '1' });
    expect(run.status).toBe(3);
    expect(run.stderr).toContain('0.3.0 did not install, so 0.2.0 stays current');
    expect(current()).toBe('0.2.0');
    expect(existsSync(join(data, '0.3.0'))).toBe(false);
  });

  it('skips a worker whose uv is gone, which could not run in the old version either', () => {
    publish('0.2.0');
    release();
    field('setup', 'aced');
    publish('0.3.0');
    const run = release(undefined, { FAKE_NO_UV: '1' });
    expect(run.status).toBe(0);
    expect(current()).toBe('0.3.0');
    expect(run.log).not.toContain('field@0.3.0 setup field-aced');
    expect(rows(run.stdout).get('worker-skipped')).toBe(
      'field-aced was set up in 0.2.0, and uv is not installed, so 0.3.0 does not set it up — brew install uv, then field setup field-aced',
    );
  });

  it('downloads and builds nothing when the newest release is installed, and re-syncs its workers', () => {
    const commit = publish('0.2.0');
    release();
    const run = release();
    expect(run.status).toBe(0);
    expect(changes(run)).toEqual([
      'git ls-remote https://github.com/audiofield/field.git',
      `curl https://raw.githubusercontent.com/audiofield/field/${commit}/package.json`,
      'field@0.2.0 setup --existing',
    ]);
    expect(rows(run.stdout).get('installed')).toBe('0.2.0 is installed');
  });

  it('builds only the missing piece of the installed version', () => {
    publish('0.2.0');
    release();
    rmSync(join(data, '0.2.0', AUDIOD));
    const run = release();
    expect(run.status).toBe(0);
    expect(run.log).toContain(`pnpm --dir ${join(data, '0.2.0')} run build:native`);
    expect(run.log).not.toContain(`pnpm --dir ${join(data, '0.2.0')} run build`);
  });

  it('takes the archive\'s single top-level directory whatever it is called', () => {
    publish('0.2.0', { prefix: 'audiofield-field-1a2b3c4' });
    expect(release().status).toBe(0);
    expect(field('--version').stdout).toBe('0.2.0\n');
  });

  it('refuses a version that is not X.Y.Z, since it names a directory', () => {
    write(join(serve, 'raw/audiofield/field/v0/package.json'), '{\n  "version": "../../x"\n}\n');
    const run = release();
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("names version '../../x', which is not X.Y.Z");
    expect(existsSync(data)).toBe(false);
  });

  it('refuses a version older than release installs, whose field upgrade could not leave it', () => {
    publish('0.2.0', { installer: '#!/usr/bin/env bash\necho "run this from a Field checkout" >&2\nexit 69\n' });
    const run = release();
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('0.2.0 predates release installs');
    expect(run.stderr).toContain('0.2.0 did not install, and nothing was switched to it');
    expect(existsSync(join(data, 'current'))).toBe(false);
    expect(existsSync(join(data, '0.2.0'))).toBe(false);
    expect(run.log.some((line) => line.startsWith('pnpm'))).toBe(false);
  });

  it('reads the version at the commit v0 names, past a stale copy at v0', () => {
    publish('0.2.0');
    release();
    const commit = publish('0.3.0');
    // raw.githubusercontent.com caches a file at a ref for up to five
    // minutes, so just after a release v0 can still read as the last one.
    write(join(serve, 'raw/audiofield/field/v0/package.json'), '{\n  "name": "field",\n  "version": "0.2.0"\n}\n');
    const run = release();
    expect(run.status).toBe(0);
    expect(run.log).toContain(`curl https://raw.githubusercontent.com/audiofield/field/${commit}/package.json`);
    expect(rows(run.stdout).get('release')).toBe('audiofield/field v0 is at 0.3.0');
    expect(current()).toBe('0.3.0');
  });

  it('reads the version at the ref when git cannot name its commit', () => {
    publish('0.2.0');
    rmSync(join(serve, 'git'), { recursive: true });
    const run = release();
    expect(run.status).toBe(0);
    expect(run.log).toContain('git ls-remote https://github.com/audiofield/field.git');
    expect(run.log).toContain('curl https://raw.githubusercontent.com/audiofield/field/v0/package.json');
    expect(current()).toBe('0.2.0');
  });

  it('follows the repository and ref it was installed from', () => {
    publish('0.2.0', { repo: 'someone/field', ref: 'main' });
    expect(release(undefined, { FIELD_REPO: 'someone/field', FIELD_REF: 'main' }).status).toBe(0);
    expect(readFileSync(join(data, 'release.conf'), 'utf8')).toContain('repo=someone/field\nref=main\n');
    const commit = publish('0.3.0', { repo: 'someone/field', ref: 'main' });
    const run = release();
    expect(run.status).toBe(0);
    expect(run.log).toContain('git ls-remote https://github.com/someone/field.git');
    expect(run.log).toContain(`curl https://raw.githubusercontent.com/someone/field/${commit}/package.json`);
    expect(current()).toBe('0.3.0');
  });

  it('moves an install that recorded the repository before it moved', () => {
    publish('0.2.0');
    expect(release().status).toBe(0);
    const record = join(data, 'release.conf');
    write(record, readFileSync(record, 'utf8').replace('repo=audiofield/field', 'repo=okamnesiac/field'));
    const commit = publish('0.3.0');
    expect(rows(release('status').stdout).get('release')).toBe('audiofield/field v0 is at 0.3.0');
    const run = release();
    expect(run.status).toBe(0);
    expect(run.log).toContain('git ls-remote https://github.com/audiofield/field.git');
    expect(run.log).toContain(`curl https://raw.githubusercontent.com/audiofield/field/${commit}/package.json`);
    expect(current()).toBe('0.3.0');
    expect(readFileSync(record, 'utf8')).toContain('repo=audiofield/field\n');
  });

  it('refuses a FIELD_REPO that is not owner/repository', () => {
    const run = release(undefined, { FIELD_REPO: 'someone/../field' });
    expect(run.status).toBe(64);
    expect(run.stderr).toContain('FIELD_REPO is owner/repository');
  });

  it('sends GITHUB_TOKEN to GitHub in curl config, and never to a URL FIELD_RAW_URL names', () => {
    const commit = publish('0.2.0');
    const run = release(undefined, { GITHUB_TOKEN: 'secret-token' });
    expect(run.status).toBe(0);
    const header = '[header = "Authorization: Bearer secret-token"]';
    expect(run.log).toContain(`curl https://raw.githubusercontent.com/audiofield/field/${commit}/package.json ${header}`);
    expect(run.log).toContain(`curl https://github.com/audiofield/field/archive/refs/tags/v0.2.0.tar.gz ${header}`);
    publish('0.3.0');
    const elsewhere = release(undefined, {
      GITHUB_TOKEN: 'secret-token',
      FIELD_RAW_URL: `file://${serve}/raw`,
      FIELD_ARCHIVE_URL: `file://${serve}/github`,
    });
    expect(elsewhere.status).toBe(0);
    expect(elsewhere.log).toContain(`curl file://${serve}/raw/audiofield/field/v0/package.json`);
    expect(elsewhere.log).toContain(`curl file://${serve}/github/audiofield/field/archive/refs/tags/v0.3.0.tar.gz`);
    expect(current()).toBe('0.3.0');
  });

  it('installs where FIELD_DATA_DIR and FIELD_BIN_DIR say, quoting a path that needs it', () => {
    publish('0.2.0');
    const dataDir = join(root, "a user's data");
    const binDir = join(root, 'my bin');
    const run = release(undefined, { FIELD_DATA_DIR: dataDir, FIELD_BIN_DIR: binDir });
    expect(run.status).toBe(0);
    expect(current(dataDir)).toBe('0.2.0');
    const result = spawnSync(join(binDir, 'field'), ['--version'], { encoding: 'utf8', env: { PATH: bin, FAKE_LOG: log } });
    expect(result.stdout).toBe('0.2.0\n');
    expect(readFileSync(join(dataDir, 'release.conf'), 'utf8')).toContain(`bin=${binDir}\n`);
  });

  it('refuses to replace a field in the bin directory that is not its shim', () => {
    publish('0.2.0');
    write(shim, '#!/bin/sh\necho mine\n', 0o755);
    const run = release();
    expect(run.status).toBe(69);
    expect(run.stderr).toContain("~/.local/bin/field exists and is not Field's release shim");
    expect(run.log).toEqual([]);
    expect(readFileSync(shim, 'utf8')).toBe('#!/bin/sh\necho mine\n');
  });

  it('refuses a bin directory it cannot write before anything changes', () => {
    publish('0.2.0');
    const locked = join(root, 'locked');
    mkdirSync(locked, { mode: 0o555 });
    const run = release(undefined, { FIELD_BIN_DIR: join(locked, 'bin') });
    expect(run.status).toBe(69);
    expect(run.stderr).toContain('the shim goes in ~/locked/bin, and you cannot write to ~/locked');
    expect(run.log).toEqual([]);
    expect(existsSync(data)).toBe(false);
  });

  it('refuses in a Windows shell, naming the steps for a checkout', () => {
    publish('0.2.0');
    rmSync(join(bin, 'uname'), { force: true });
    write(join(bin, 'uname'), `#!${BASH}\necho MINGW64_NT-10.0-19045\n`, 0o755);
    const run = release();
    expect(run.status).toBe(69);
    expect(run.stderr).toContain('installing a release does not support Windows yet');
    expect(run.log).toEqual([]);
    expect(existsSync(data)).toBe(false);
  });

  it('refuses to install offline', () => {
    const run = release(undefined, { FIELD_OFFLINE: '1' });
    expect(run.status).toBe(69);
    expect(run.stderr).toContain('FIELD_OFFLINE is set');
  });

  it('names curl and tar, and the download to run again, before it makes a directory', () => {
    rmSync(join(bin, 'curl'));
    rmSync(join(bin, 'tar'));
    write(join(bin, 'apt-get'), `#!${BASH}\n`, 0o755);
    const run = release(undefined, { FAKE_UNAME: 'Linux' });
    expect(run.status).toBe(69);
    expect(run.stderr).toContain('  sudo apt-get install -y curl tar\n');
    expect(run.stderr).toContain(
      'Then open a new shell and run curl -fsSL https://raw.githubusercontent.com/audiofield/field/v0/install.sh | bash again.',
    );
    expect(existsSync(data)).toBe(false);
  });

  it('says how to put the bin directory on PATH when it is not', () => {
    publish('0.2.0');
    const run = release(undefined, { PATH: [join(pnpmHome, 'bin'), bin].join(delimiter), SHELL: '/bin/zsh' });
    expect(run.status).toBe(0);
    expect(rows(run.stdout).get('not-on-path')).toBe(
      '~/.local/bin is not on PATH, so your shell does not find the shim — add export PATH="$HOME/.local/bin:$PATH" to ~/.zshrc, then open a new shell',
    );
    expect(rows(release('status').stdout).has('not-on-path')).toBe(false);
  });

  it("says when a checkout's field is ahead of the release's on PATH", () => {
    publish('0.2.0');
    write(join(pnpmHome, 'bin', 'field'), '#!/bin/sh\n', 0o755);
    const run = release();
    expect(rows(run.stdout).get('cli-shadowed')).toBe(
      "field on PATH is ~/pnpm/bin/field, ahead of the release's ~/.local/bin/field",
    );
  });

  it("finds the data directory beside a version's own installer", () => {
    publish('0.2.0');
    const dataDir = join(root, 'elsewhere');
    release(undefined, { FIELD_DATA_DIR: dataDir });
    const run = install('status', { FAKE_SERVE: serve, FAKE_CLI: join(root, 'release-cli.js') }, join(dataDir, '0.2.0', 'install.sh'));
    expect(rows(run.stdout).get('installed')).toBe('0.2.0 in ~/elsewhere/0.2.0');
  });

  it("leaves another program's current link alone beside a release unpacked as GitHub names it", () => {
    publish('0.2.0');
    const opt = join(root, 'opt');
    write(join(opt, '2.0.1', 'bin', 'tool'), '');
    symlinkSync('2.0.1', join(opt, 'current'));
    const unpacked = join(opt, 'field-0.2.0');
    write(join(unpacked, 'install.sh'), readFileSync(downloaded, 'utf8'));
    write(join(unpacked, 'src/cli.ts'), '');
    const run = release(undefined, {}, join(unpacked, 'install.sh'));
    expect(run.status).toBe(0);
    expect(readlinkSync(join(opt, 'current'))).toBe('2.0.1');
    expect(existsSync(join(opt, 'release.conf'))).toBe(false);
    expect(existsSync(join(opt, '0.2.0'))).toBe(false);
    expect(current()).toBe('0.2.0');
  });
});

posix('install.sh release targets', () => {
  it('rebuild a piece of the installed version where it is', () => {
    const commit = publish('0.2.0');
    release();
    const version = join(data, '0.2.0');
    rmSync(join(version, AUDIOD));
    const audiod = release('audiod');
    expect(audiod.status).toBe(0);
    expect(changes(audiod)).toEqual([
      `pnpm --dir ${version} run build:native`,
      'git ls-remote https://github.com/audiofield/field.git',
      `curl https://raw.githubusercontent.com/audiofield/field/${commit}/package.json`,
    ]);
    expect(readFileSync(join(version, 'native/audiod/build/fetchcontent'), 'utf8')).toBe(
      `${join(data, 'cache', 'fetchcontent')}\n`,
    );
    expect(rows(audiod.stdout).get('release-latest')).toBe('0.2.0 is installed');
    const cli = release('cli');
    expect(cli.status).toBe(0);
    expect(cli.log).toContain(`pnpm --dir ${version} run build`);
    expect(cli.log).toContain(`pnpm --dir ${version} run build:ui`);
    const workers = release('workers');
    expect(workers.status).toBe(0);
    expect(workers.log).toContain('field@0.2.0 setup --existing');
  });

  it('say there is nothing to rebuild before a release is installed', () => {
    for (const target of ['cli', 'audiod', 'workers']) {
      const run = release(target);
      expect(run.status).toBe(69);
      expect(run.stderr).toContain('no release of Field is installed in ~/.local/share/field');
    }
  });
});

posix('install.sh status in a release install', () => {
  it('reports the newest release as current, and every piece of it', () => {
    publish('0.2.0');
    release();
    const run = release('status');
    expect(run.status).toBe(0);
    const status = rows(run.stdout);
    expect(status.get('installed')).toBe('0.2.0 in ~/.local/share/field/0.2.0');
    expect(status.get('release')).toBe('audiofield/field v0 is at 0.2.0');
    expect(status.get('release-latest')).toBe('0.2.0 is installed');
    expect(status.get('cli')).toBe('~/.local/bin/field -> ~/.local/share/field/current');
    expect(status.get('ui-current')).toBe('~/.local/share/field/0.2.0/ui/dist');
    expect(status.get('audiod-current')).toBe(`~/.local/share/field/0.2.0/${AUDIOD}`);
    expect(status.get('worker-absent')).toBe('field-voiced is not set up — field setup voiced sets it up');
    expect(status.has('previous')).toBe(false);
  });

  it('says when a newer release is out, and names field upgrade', () => {
    publish('0.2.0');
    release();
    publish('0.3.0');
    const status = rows(release('status').stdout);
    expect(status.get('release')).toBe('audiofield/field v0 is at 0.3.0');
    expect(status.get('release-behind')).toBe('0.2.0 is installed, and v0 is at 0.3.0 — run field upgrade all');
  });

  it('says when the installed version is newer than the one its ref names', () => {
    const commit = publish('0.3.0');
    release();
    write(join(serve, 'raw/audiofield/field', commit, 'package.json'), '{\n  "version": "0.2.0"\n}\n');
    expect(rows(release('status').stdout).get('release-ahead')).toBe('0.3.0 is installed, newer than 0.2.0 at v0');
  });

  it('names the missing piece of the installed version, and the upgrade that builds it', () => {
    publish('0.2.0');
    release();
    const version = join(data, '0.2.0');
    rmSync(join(version, 'dist', 'cli.js'));
    rmSync(join(version, 'ui', 'dist', 'index.html'));
    rmSync(join(version, AUDIOD));
    const status = rows(release('status', { FIELD_AUDIOD: '/opt/field-audiod' }).stdout);
    expect(status.get('cli-unbuilt')).toBe('~/.local/share/field/0.2.0/dist holds no build — run field upgrade cli');
    expect(status.get('ui-missing')).toBe('ui/dist holds no build, so field ui cannot open — run field upgrade cli');
    expect(status.get('audiod-override')).toBe('FIELD_AUDIOD is set, so field runs /opt/field-audiod instead of this build');
    expect(status.get('audiod-missing')).toBe('field-audiod is not built — run field upgrade audiod');
    rmSync(shim);
    expect(rows(release('status').stdout).get('cli-missing')).toBe(
      'no field shim in ~/.local/bin — run curl -fsSL https://raw.githubusercontent.com/audiofield/field/v0/install.sh | bash',
    );
  });

  it('names the version kept after an upgrade', () => {
    publish('0.2.0');
    release();
    publish('0.3.0');
    release();
    expect(rows(release('status').stdout).get('previous')).toBe(
      '0.2.0 in ~/.local/share/field/0.2.0, kept to switch back to by hand',
    );
  });

  it('compares nothing offline', () => {
    publish('0.2.0');
    release();
    const run = release('status', { FIELD_OFFLINE: '1' });
    expect(rows(run.stdout).get('release')).toBe('audiofield/field v0 (offline; not compared)');
    expect(run.log.some((line) => line.startsWith('curl'))).toBe(false);
  });

  it('names the token when GitHub does not answer', () => {
    const status = rows(release('status').stdout);
    expect(status.get('release')).toBe(
      'audiofield/field v0 (could not read its version from https://raw.githubusercontent.com — for a private repository, set GITHUB_TOKEN)',
    );
  });
});

// install.md §3.5: uninstall removes what the installer can show it made,
// and nothing else.
posix('install.sh uninstall', () => {
  it('removes a release install: the shim, every version, current, release.conf, and the cache, then the data directory', () => {
    publish('0.2.0');
    release();
    publish('0.3.0');
    release();
    write(join(data, 'cache', 'fetchcontent', 'juce-src', 'CMakeLists.txt'), '');
    const run = release('uninstall');
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(changes(run)).toEqual([]);
    expect(existsSync(shim)).toBe(false);
    expect(existsSync(data)).toBe(false);
    expect(run.stdout).toContain('removed        ~/.local/bin/field\n');
    expect(run.stdout).toContain('removed        0.2.0\n');
    expect(run.stdout).toContain('removed        0.3.0\n');
    expect(run.stdout).toContain('removed        ~/.local/share/field\n');
    expect(rows(run.stdout).get('uninstalled')).toBe('to install again: curl -fsSL https://field.one/install.sh | bash');
  });

  it('keeps what it did not put there: another field in the bin directory, and other things in the data directory', () => {
    const others = ['3.11.4/bin/python3', '.download-9.9.9/notes', 'notes/todo'];
    for (const path of others) write(join(data, path), '');
    publish('0.2.0');
    release();
    write(shim, '#!/bin/sh\necho mine\n', 0o755);
    const run = release('uninstall');
    expect(run.status).toBe(0);
    expect(readFileSync(shim, 'utf8')).toBe('#!/bin/sh\necho mine\n');
    for (const path of others) expect(existsSync(join(data, path))).toBe(true);
    expect(existsSync(join(data, '0.2.0'))).toBe(false);
    expect(existsSync(join(data, 'current'))).toBe(false);
    expect(existsSync(join(data, 'release.conf'))).toBe(false);
    expect(run.stdout).toContain("kept           ~/.local/bin/field, which is not Field's release shim\n");
    expect(run.stdout).toContain('kept           ~/.local/share/field, which holds things Field did not put there\n');
    expect(run.stdout).not.toContain('3.11.4');
  });

  // The shim is the one record of where its install lives, so the
  // uninstall of another data directory leaves it to name that one.
  it('keeps a shim that runs another data directory, and names that directory', () => {
    publish('0.2.0');
    const custom = join(root, 'custom');
    release(undefined, { FIELD_DATA_DIR: custom });
    const run = release('uninstall');
    expect(run.status).toBe(0);
    expect(changes(run)).toEqual([]);
    expect(field('--version').stdout).toBe('0.2.0\n');
    expect(rows(run.stdout).get('not-installed')).toBe('no release of Field is installed in ~/.local/share/field');
    expect(rows(run.stdout).get('kept')).toBe(
      '~/.local/bin/field, which runs the install in ~/custom — to remove that install, uninstall again with FIELD_DATA_DIR=~/custom',
    );
    expect(release('uninstall', { FIELD_DATA_DIR: custom }).status).toBe(0);
    expect(existsSync(shim)).toBe(false);
    expect(existsSync(custom)).toBe(false);
  });

  it('removes its own versions, and keeps the shim another install wrote over its own', () => {
    publish('0.2.0');
    release();
    const custom = join(root, 'custom');
    release(undefined, { FIELD_DATA_DIR: custom });
    const run = release('uninstall');
    expect(run.status).toBe(0);
    expect(existsSync(data)).toBe(false);
    expect(field('--version').stdout).toBe('0.2.0\n');
    expect(current(custom)).toBe('0.2.0');
    expect(rows(run.stdout).get('kept')).toBe(
      '~/.local/bin/field, which runs the install in ~/custom — to remove that install, uninstall again with FIELD_DATA_DIR=~/custom',
    );
  });

  it('keeps a shim whose exec line it cannot read', () => {
    publish('0.2.0');
    release();
    const text = readFileSync(shim, 'utf8').replace(/^exec node .*$/m, 'exec node "$HOME/elsewhere/cli.js" "$@"');
    write(shim, text, 0o755);
    const run = release('uninstall');
    expect(run.status).toBe(0);
    expect(readFileSync(shim, 'utf8')).toBe(text);
    expect(existsSync(data)).toBe(false);
    expect(rows(run.stdout).get('kept')).toBe('~/.local/bin/field, which does not run ~/.local/share/field/current');
  });

  // `field uninstall` hands the installer the data directory's real path,
  // and the shim has the path it was installed through, quoted.
  it('removes the shim it wrote through a link to the data directory, whose path needs quoting', () => {
    publish('0.2.0');
    mkdirSync(join(root, 'real'));
    symlinkSync(join(root, 'real'), join(root, 'link'));
    release(undefined, { FIELD_DATA_DIR: join(root, 'link', "a user's data") });
    const run = release('uninstall', { FIELD_DATA_DIR: join(root, 'real', "a user's data") });
    expect(run.status).toBe(0);
    expect(existsSync(shim)).toBe(false);
    expect(existsSync(join(root, 'real', "a user's data"))).toBe(false);
    expect(run.stdout).toContain('removed        ~/.local/bin/field\n');
  });

  // field-aced downloads ACE-Step's weights into a directory of Field's own
  // (models_root in python/aced), and Chatterbox's go to the Hugging Face
  // cache, so each worker set up names the directory its weights are in.
  const ACE_ROW =
    "ACE-Step's weights stay in ~/.field/models/acestep, which every Field install on this machine uses — delete it once none of them needs the weights";
  const CHATTERBOX_ROW =
    "Chatterbox's weights stay in the Hugging Face cache, ~/.cache/huggingface, which other tools share — remove the models you no longer want from there";

  function weights(): { ace: string; huggingface: string } {
    const ace = join(root, '.field', 'models', 'acestep', 'checkpoints');
    const huggingface = join(root, '.cache', 'huggingface', 'hub');
    mkdirSync(ace, { recursive: true });
    mkdirSync(huggingface, { recursive: true });
    return { ace, huggingface };
  }

  it("leaves each worker's model weights where the worker keeps them, and says where", () => {
    publish('0.2.0');
    release();
    field('setup', 'aced');
    field('setup', 'voiced');
    const { ace, huggingface } = weights();
    const run = release('uninstall');
    expect(run.status).toBe(0);
    expect(existsSync(ace)).toBe(true);
    expect(existsSync(huggingface)).toBe(true);
    expect(run.stdout).toContain(`models-kept    ${ACE_ROW}\n`);
    expect(run.stdout).toContain(`models-kept    ${CHATTERBOX_ROW}\n`);
  });

  it('names only the weights of the workers that were set up', () => {
    publish('0.2.0');
    release();
    field('setup', 'aced');
    weights();
    const run = release('uninstall');
    expect(run.stdout).toContain(`models-kept    ${ACE_ROW}\n`);
    expect(run.stdout).not.toContain('Chatterbox');
  });

  it('names the directories FIELD_ACE_MODELS and HF_HUB_CACHE move the weights to', () => {
    publish('0.2.0');
    release();
    field('setup', 'aced');
    field('setup', 'voiced');
    mkdirSync(join(root, 'ace'));
    mkdirSync(join(root, 'hub'));
    const run = release('uninstall', {
      FIELD_ACE_MODELS: join(root, 'ace'),
      HF_HOME: join(root, 'hf'),
      HF_HUB_CACHE: join(root, 'hub'),
    });
    expect(run.stdout).toContain("ACE-Step's weights stay in ~/ace,");
    expect(run.stdout).toContain("Chatterbox's weights stay in the Hugging Face cache, ~/hub,");
  });

  it('says nothing about models when no worker was set up', () => {
    publish('0.2.0');
    release();
    weights();
    expect(rows(release('uninstall').stdout).has('models-kept')).toBe(false);
  });

  it("names a fork's installer as the way to install again", () => {
    publish('0.2.0', { repo: 'someone/field', ref: 'main' });
    release(undefined, { FIELD_REPO: 'someone/field', FIELD_REF: 'main' });
    expect(rows(release('uninstall').stdout).get('uninstalled')).toBe(
      'to install again: curl -fsSL https://raw.githubusercontent.com/someone/field/main/install.sh | bash',
    );
  });

  it('says so, and changes nothing, when no release is installed', () => {
    const run = release('uninstall');
    expect(run.status).toBe(0);
    expect(changes(run)).toEqual([]);
    expect(rows(run.stdout).get('not-installed')).toBe('no release of Field is installed in ~/.local/share/field');
  });

  it("removes a checkout's pnpm link, and keeps the checkout", () => {
    install('cli');
    expect(readlinkSync(join(pnpmHome, 'global', 'field'))).toBe(repo);
    const run = install('uninstall');
    expect(run.status).toBe(0);
    expect(changes(run)).toEqual(['pnpm remove -g field']);
    expect(existsSync(join(pnpmHome, 'global', 'field'))).toBe(false);
    expect(existsSync(join(repo, 'install.sh'))).toBe(true);
    expect(existsSync(join(repo, 'dist'))).toBe(true);
    expect(rows(run.stdout).get('unlinked')).toBe("pnpm's global field no longer links ~/checkout");
  });

  it('leaves a link to another checkout alone', () => {
    const other = join(root, 'other');
    mkdirSync(other);
    linkTo(other);
    const run = install('uninstall');
    expect(run.status).toBe(0);
    expect(changes(run)).toEqual([]);
    expect(readlinkSync(join(pnpmHome, 'global', 'field'))).toBe(other);
    expect(run.stdout).toContain("pnpm's global field links ~/other, not this checkout");
  });
});

posix('install.sh refuses', () => {
  it('an unknown target, as a usage error', () => {
    const run = install('everything');
    expect(run.status).toBe(64);
    expect(run.stderr).toContain('usage: install.sh [all|cli|audiod|workers|status|uninstall]');
    expect(existsSync(join(repo, 'dist'))).toBe(false);
  });
});
