import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { constants, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// `field upgrade [target]`: run an installer with the same target, output,
// and exit status (install.md §2.5). Installing belongs to install.sh,
// which knows how to build and link each piece, so nothing here decides
// what an upgrade is. Which installer depends on the install:
//
// - A checkout runs the install.sh beside the package this file was loaded
//   from, which for a linked checkout is the checkout itself.
// - A release install downloads the newest installer, install.sh at the
//   commit the ref its install recorded names now, in the repository it
//   recorded, and runs that (install.md §3.2), as Projector's `project
//   upgrade` does. The copy
//   inside the installed version is as old as the version, so it runs only
//   under FIELD_OFFLINE, when nothing newer can download.

export const DEFAULT_REPO = 'audiofield/field';
export const DEFAULT_REF = 'v0';
// Field's repository before it moved to DEFAULT_REPO. GitHub's redirect from
// the old name ends when another repository takes it, so an install that
// recorded it follows DEFAULT_REPO, as install.sh's does (install.md §11).
const MOVED_REPO = 'okamnesiac/field';
// install.sh's VERSION_PATTERN.
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const RAW_URL = 'https://raw.githubusercontent.com';
const ARCHIVE_URL = 'https://github.com';

// Two levels up from src/commands/ and from dist/commands/ alike.
export function packageRoot(): string {
  return fileURLToPath(new URL('../..', import.meta.url));
}

// The test install.sh makes (install.md §2.1, as amended): a git work tree
// with the CLI's source beside the installer. A release version has the
// source and no .git.
export function isCheckout(root: string): boolean {
  return existsSync(join(root, '.git')) && existsSync(join(root, 'src', 'cli.ts'));
}

export interface ReleaseSource {
  repo: string;
  ref: string;
  // The directory holding the installed versions, when this package is one
  // of them: a directory named X.Y.Z, as install.sh names each version,
  // with a `current` link beside it. A `current` beside any other
  // directory, such as an unpacked field-0.2.0, is another program's.
  dataDir?: string | undefined;
}

// What release.conf in the data directory records, key by key.
function readRecord(path: string): Map<string, string> {
  const record = new Map<string, string>();
  if (!existsSync(path)) return record;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const at = line.indexOf('=');
    if (at > 0 && !record.has(line.slice(0, at))) record.set(line.slice(0, at), line.slice(at + 1));
  }
  return record;
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

// Where a release install came from: FIELD_REPO and FIELD_REF, then what
// the install recorded, then the defaults, the order install.sh reads them
// in. So an install from a fork upgrades from the fork.
export function releaseSource(root: string, env: NodeJS.ProcessEnv): ReleaseSource {
  const parent = dirname(root);
  const dataDir = VERSION.test(basename(root)) && isSymlink(join(parent, 'current')) ? parent : undefined;
  const record = dataDir === undefined ? new Map<string, string>() : readRecord(join(dataDir, 'release.conf'));
  const recorded = record.get('repo');
  return {
    repo: env['FIELD_REPO'] || (recorded === MOVED_REPO ? DEFAULT_REPO : recorded) || DEFAULT_REPO,
    ref: env['FIELD_REF'] || record.get('ref') || DEFAULT_REF,
    dataDir,
  };
}

// The commit the ref names, asked of the repository's git server as
// install.sh's ref_commit asks it. raw.githubusercontent.com caches a file
// at a tag or branch for up to five minutes, so the installer at v0 just
// after a release can be the release before it's; a file at a commit
// never changes. A tag wins over a branch of the same name, and an
// annotated tag gives the commit it points at. Undefined when git is
// missing or cannot answer, and the installer downloads at the ref.
export function refCommit(source: ReleaseSource, env: NodeJS.ProcessEnv): string | undefined {
  const base = (env['FIELD_ARCHIVE_URL'] || ARCHIVE_URL).replace(/\/+$/, '');
  const names = [`refs/tags/${source.ref}^{}`, `refs/tags/${source.ref}`, `refs/heads/${source.ref}`];
  const result = spawnSync('git', ['ls-remote', `${base}/${source.repo}.git`, ...names], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (result.error || result.status !== 0) return undefined;
  const commits = new Map<string, string>();
  for (const line of result.stdout.split('\n')) {
    const [commit, name] = line.split('\t');
    if (commit !== undefined && name !== undefined && /^[0-9a-f]{40,}$/.test(commit)) commits.set(name, commit);
  }
  return names.map((name) => commits.get(name)).find((commit) => commit !== undefined);
}

export function installerUrl(source: ReleaseSource, env: NodeJS.ProcessEnv, commit?: string): string {
  const base = (env['FIELD_RAW_URL'] || RAW_URL).replace(/\/+$/, '');
  return `${base}/${source.repo}/${commit ?? source.ref}/install.sh`;
}

const GITHUB_HOSTS = new Set(['github.com', 'raw.githubusercontent.com', 'api.github.com', 'codeload.github.com']);

// curl's arguments for a download, and the config it reads on stdin. As in
// install.sh, GITHUB_TOKEN goes only to GitHub's own hosts over https, and
// in the config rather than on the command line, where any process on the
// machine could read it.
export function curlRequest(
  url: string,
  dest: string,
  env: NodeJS.ProcessEnv,
): { args: string[]; input?: string | undefined } {
  const args = ['-fsSL', '--retry', '2', '-o', dest];
  const token = env['GITHUB_TOKEN'];
  let host = '';
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:') host = parsed.hostname;
  } catch {
    // not a URL curl can use either; curl says so
  }
  if (token && GITHUB_HOSTS.has(host)) {
    return { args: [...args, '--config', '-', url], input: `header = "Authorization: Bearer ${token}"\n` };
  }
  return { args: [...args, url] };
}

function curlDownload(url: string, dest: string, env: NodeJS.ProcessEnv): void {
  const { args, input } = curlRequest(url, dest, env);
  const result = spawnSync('curl', args, { input, stdio: ['pipe', 'inherit', 'inherit'], env });
  if (result.error) throw new Error(`cannot upgrade: could not run curl: ${result.error.message}`);
  if (result.status !== 0) {
    const hint = env['GITHUB_TOKEN'] ? '' : ' — for a private repository, set GITHUB_TOKEN';
    throw new Error(`cannot upgrade: could not download the installer from ${url}${hint}`);
  }
}

export interface UpgradeDeps {
  // The package this field runs from; the installed version's directory
  // in a release install.
  root?: string | undefined;
  installer?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  download?: ((url: string, dest: string, env: NodeJS.ProcessEnv) => void) | undefined;
  run?: ((script: string, args: string[], env: NodeJS.ProcessEnv) => number) | undefined;
  err?: ((line: string) => void) | undefined;
  platform?: NodeJS.Platform | undefined;
}

// `field uninstall`: the installer's `uninstall` target, run the way an
// upgrade runs the installer (install.md §3.5). It removes a release
// install's versions and shim, or a checkout's pnpm link, and never the
// checkout itself.
export function uninstall(deps: UpgradeDeps = {}): number {
  if ((deps.platform ?? process.platform) === 'win32') {
    throw new Error(
      'field uninstall runs install.sh, which does not support Windows yet — run pnpm remove -g field, then delete the checkout if you no longer want it',
    );
  }
  return upgrade('uninstall', deps);
}

export function upgrade(target: string | undefined, deps: UpgradeDeps = {}): number {
  // install.sh is bash and builds with the POSIX toolchain, so on Windows
  // this would hand a script to whatever `bash` resolves to, which may be
  // WSL's and not the Windows side at all (install.md §7.6).
  if ((deps.platform ?? process.platform) === 'win32') {
    throw new Error(
      'field upgrade runs install.sh, which does not support Windows yet — in the field checkout, run ' +
        'pnpm install --frozen-lockfile, pnpm build, pnpm build:ui, and pnpm build:native',
    );
  }
  const env = deps.env ?? process.env;
  const err = deps.err ?? ((line: string) => process.stderr.write(`${line}\n`));
  const run = deps.run ?? runInstaller;
  const args = target === undefined ? [] : [target];
  // The real path: node runs the shim's target through the `current` link,
  // and the data directory is the parent of the version, not of the link.
  let root = deps.root ?? packageRoot();
  try {
    root = realpathSync(root);
  } catch {
    // a root that does not exist stays as given: no checkout, and no data
    // directory beside it, so a downloaded installer uses its default
  }
  const runHere = (installer: string, installerEnv: NodeJS.ProcessEnv): number => {
    if (!existsSync(installer)) throw new Error(`cannot upgrade: ${installer} does not exist`);
    // The command it runs, as you would type it, so the output that follows
    // has a name and the step can be repeated by hand.
    err(`+ ${[installer, ...args].map(displayQuote).join(' ')}`);
    return run(installer, args, installerEnv);
  };
  if (deps.installer !== undefined || isCheckout(root)) return runHere(deps.installer ?? join(root, 'install.sh'), env);
  const source = releaseSource(root, env);
  // The installer reads the data directory from FIELD_DATA_DIR, so one
  // installed somewhere other than the default upgrades in place.
  const childEnv: NodeJS.ProcessEnv = { ...env };
  if (source.dataDir !== undefined && !env['FIELD_DATA_DIR']) childEnv['FIELD_DATA_DIR'] = source.dataDir;
  // Offline, the installed version's own installer stands in for the
  // newest one, which cannot download. FIELD_OFFLINE keeps it from
  // downloading anything either (install.md §3.2).
  if (env['FIELD_OFFLINE']) return runHere(join(root, 'install.sh'), childEnv);
  const url = installerUrl(source, env, refCommit(source, env));
  const scratch = mkdtempSync(join(tmpdir(), 'field-upgrade-'));
  try {
    const script = join(scratch, 'install.sh');
    (deps.download ?? curlDownload)(url, script, env);
    err(`+ curl -fsSL ${displayQuote(url)} | bash${args.length > 0 ? ` -s -- ${args.map(displayQuote).join(' ')}` : ''}`);
    return run(script, args, childEnv);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// Through bash rather than the script's own execute bit, which a checkout
// with core.fileMode off, a copy made without modes, or a download, does
// not keep.
function runInstaller(script: string, args: string[], env: NodeJS.ProcessEnv): number {
  const result = spawnSync('bash', [script, ...args], { stdio: 'inherit', env });
  if (result.error) throw result.error;
  if (result.signal !== null) return 128 + (constants.signals[result.signal] ?? 0);
  return result.status ?? 1;
}

function displayQuote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}
