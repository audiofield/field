import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { curlRequest, packageRoot as upgradeRoot, uninstall, upgrade } from './upgrade.js';

// `field upgrade` is a doorway to install.sh and nothing else
// (install.md §2.5): it has to find the right installer, hand it the
// target, and give back its exit status. These run real bash against a
// stand-in installer, because the handoff is the whole command.

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'field-upgrade-'));
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

// An installer that records its arguments and exits with a known status.
function standIn(dir: string, status: number): { installer: string; argsFile: string } {
  const installer = join(dir, 'install.sh');
  const argsFile = join(dir, 'args');
  writeFileSync(installer, `printf '%s\\n' "$#:$*" > "$(dirname "$0")/args"\nexit ${status}\n`);
  return { installer, argsFile };
}

describe('field upgrade', () => {
  it('finds the package it runs from, with install.sh beside it', () => {
    expect(join(upgradeRoot(), 'install.sh')).toBe(join(packageRoot, 'install.sh'));
    expect(existsSync(join(upgradeRoot(), 'install.sh'))).toBe(true);
  });

  it('refuses on Windows, naming the build steps instead', () => {
    const { installer } = standIn(scratch, 0);
    expect(() => upgrade('cli', { installer, platform: 'win32', err: () => {} })).toThrow(
      'install.sh, which does not support Windows yet',
    );
  });

  it('refuses when there is no installer, rather than guessing at another', () => {
    const installer = join(scratch, 'install.sh');
    expect(() => upgrade(undefined, { installer, platform: 'darwin', err: () => {} })).toThrow(
      `cannot upgrade: ${installer} does not exist`,
    );
  });
});

// `field uninstall` is the installer's `uninstall` target, found and run as
// `field upgrade` finds and runs the installer (install.md §3.5).
describe('field uninstall', () => {
  it('refuses on Windows, naming pnpm remove instead', () => {
    const { installer } = standIn(scratch, 0);
    expect(() => uninstall({ installer, platform: 'win32', err: () => {} })).toThrow(
      'field uninstall runs install.sh, which does not support Windows yet — run pnpm remove -g field',
    );
  });

  it.skipIf(process.platform === 'win32')('runs the installer with the uninstall target and returns its exit status', () => {
    const { installer, argsFile } = standIn(scratch, 2);
    const lines: string[] = [];
    expect(uninstall({ installer, err: (line) => lines.push(line) })).toBe(2);
    expect(readFileSync(argsFile, 'utf8')).toBe('1:uninstall\n');
    expect(lines).toEqual([`+ ${installer} uninstall`]);
  });
});

// These hand a real bash the stand-in, which Windows does not reliably have.
describe.skipIf(process.platform === 'win32')('field upgrade runs the installer', () => {
  it('hands the installer its target and returns its exit status', () => {
    const { installer, argsFile } = standIn(scratch, 3);
    const lines: string[] = [];
    expect(upgrade('status', { installer, err: (line) => lines.push(line) })).toBe(3);
    expect(readFileSync(argsFile, 'utf8')).toBe('1:status\n');
    expect(lines).toEqual([`+ ${installer} status`]);
  });

  it('passes no target when given none, so the installer picks its default', () => {
    const { installer, argsFile } = standIn(scratch, 0);
    expect(upgrade(undefined, { installer, err: () => {} })).toBe(0);
    expect(readFileSync(argsFile, 'utf8')).toBe('0:\n');
  });

  it('runs the installer through bash, so a checkout without the execute bit still upgrades', () => {
    // writeFileSync leaves the stand-in at 0644.
    const { installer } = standIn(scratch, 0);
    expect(upgrade('cli', { installer, err: () => {} })).toBe(0);
  });

  it('quotes a path that needs it in the line it prints', () => {
    const dir = join(scratch, "a checkout's home");
    mkdirSync(dir);
    const { installer } = standIn(dir, 0);
    const lines: string[] = [];
    upgrade('all', { installer, err: (line) => lines.push(line) });
    expect(lines).toEqual([`+ '${scratch}/a checkout'\\''s home/install.sh' all`]);
  });
});

// A release install has no checkout beside its package, so `field upgrade`
// downloads the newest installer from the repository and ref the install
// recorded, and runs that (install.md §3.2). These serve the installer
// from a file:// URL, which curl fetches as it would GitHub's.
describe.skipIf(process.platform === 'win32')('field upgrade in a release install', () => {
  let data: string;
  let raw: string;
  let argsFile: string;

  // A version directory beside `current` and release.conf, as install.sh
  // leaves them, and a stand-in installer served at the recorded ref that
  // records its target and the data directory it was handed.
  beforeEach(() => {
    data = join(scratch, 'data');
    mkdirSync(join(data, '0.2.0'), { recursive: true });
    symlinkSync('0.2.0', join(data, 'current'));
    writeFileSync(join(data, 'release.conf'), 'repo=someone/field\nref=v9\nbin=/unused\n');
    raw = join(scratch, 'raw');
    argsFile = join(scratch, 'args');
    serveInstaller('someone/field', 'v9', 4);
  });

  function serveInstaller(repo: string, ref: string, status: number): void {
    mkdirSync(join(raw, repo, ref), { recursive: true });
    writeFileSync(
      join(raw, repo, ref, 'install.sh'),
      `printf '%s\\n' "$#:$*" "\${FIELD_DATA_DIR:-}" > "$UPGRADE_ARGS"\nexit ${status}\n`,
    );
  }

  // The git server is a directory too, so the commit lookup never reaches
  // GitHub, and finds nothing unless a test serves a repository there.
  function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    return {
      PATH: process.env['PATH'],
      HOME: scratch,
      GIT_CONFIG_NOSYSTEM: '1',
      FIELD_RAW_URL: `file://${raw}`,
      FIELD_ARCHIVE_URL: `file://${scratch}/git`,
      UPGRADE_ARGS: argsFile,
      ...extra,
    };
  }

  // A repository for the git server, with `ref` an annotated tag on its
  // one commit, as the Release workflow moves v0, and that commit's id.
  function serveRepository(repo: string, ref: string): string {
    const dir = join(scratch, 'git', `${repo}.git`);
    mkdirSync(dir, { recursive: true });
    const git = (...args: string[]): string => {
      const result = spawnSync(
        'git',
        ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args],
        { cwd: dir, encoding: 'utf8', env: env() },
      );
      if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
      return result.stdout.trim();
    };
    git('init', '--quiet');
    git('commit', '--quiet', '--allow-empty', '-m', 'release');
    git('tag', '-a', '-m', ref, ref);
    return git('rev-parse', 'HEAD');
  }

  it('downloads the installer at the recorded ref and runs it with the same target', () => {
    const lines: string[] = [];
    const status = upgrade('status', { root: join(data, '0.2.0'), env: env(), err: (line) => lines.push(line) });
    expect(status).toBe(4);
    expect(readFileSync(argsFile, 'utf8')).toBe(`1:status\n${realpathSync(data)}\n`);
    expect(lines).toEqual([`+ curl -fsSL file://${raw}/someone/field/v9/install.sh | bash -s -- status`]);
  });

  it('downloads the installer at the commit the ref names, past a stale copy at the ref', () => {
    const commit = serveRepository('someone/field', 'v9');
    serveInstaller('someone/field', commit, 6);
    const lines: string[] = [];
    expect(upgrade('status', { root: join(data, '0.2.0'), env: env(), err: (line) => lines.push(line) })).toBe(6);
    expect(lines).toEqual([`+ curl -fsSL file://${raw}/someone/field/${commit}/install.sh | bash -s -- status`]);
  });

  it('runs from the version current links to, as the shim runs it', () => {
    const lines: string[] = [];
    expect(upgrade(undefined, { root: join(data, 'current'), env: env(), err: (line) => lines.push(line) })).toBe(4);
    expect(readFileSync(argsFile, 'utf8')).toBe(`0:\n${realpathSync(data)}\n`);
    expect(lines).toEqual([`+ curl -fsSL file://${raw}/someone/field/v9/install.sh | bash`]);
  });

  it('takes FIELD_REPO and FIELD_REF ahead of the record', () => {
    serveInstaller('other/field', 'main', 0);
    expect(upgrade('all', { root: join(data, '0.2.0'), env: env({ FIELD_REPO: 'other/field', FIELD_REF: 'main' }), err: () => {} })).toBe(0);
    expect(readFileSync(argsFile, 'utf8')).toBe(`1:all\n${realpathSync(data)}\n`);
  });

  it('follows audiofield/field when the record names the repository before it moved', () => {
    writeFileSync(join(data, 'release.conf'), 'repo=okamnesiac/field\nref=v0\n');
    serveInstaller('audiofield/field', 'v0', 0);
    const lines: string[] = [];
    expect(upgrade(undefined, { root: join(data, '0.2.0'), env: env(), err: (line) => lines.push(line) })).toBe(0);
    expect(lines).toEqual([`+ curl -fsSL file://${raw}/audiofield/field/v0/install.sh | bash`]);
  });

  it('follows audiofield/field at v0 when nothing is recorded', () => {
    const loose = join(scratch, 'loose', '0.1.0');
    mkdirSync(loose, { recursive: true });
    serveInstaller('audiofield/field', 'v0', 0);
    expect(upgrade('status', { root: loose, env: env(), err: () => {} })).toBe(0);
    // Not a data directory, so the installer chooses its own.
    expect(readFileSync(argsFile, 'utf8')).toBe('1:status\n\n');
  });

  it("runs the installed version's own installer offline, and downloads nothing", () => {
    rmSync(raw, { recursive: true });
    writeFileSync(join(data, '0.2.0', 'install.sh'), `printf '%s\\n' "$#:$*" "\${FIELD_DATA_DIR:-}" > "$UPGRADE_ARGS"\nexit 5\n`);
    const lines: string[] = [];
    const status = upgrade('status', { root: join(data, 'current'), env: env({ FIELD_OFFLINE: '1' }), err: (line) => lines.push(line) });
    expect(status).toBe(5);
    expect(readFileSync(argsFile, 'utf8')).toBe(`1:status\n${realpathSync(data)}\n`);
    expect(lines).toEqual([`+ ${realpathSync(data)}/0.2.0/install.sh status`]);
  });

  it("takes no data directory or record from another program's current link", () => {
    const opt = join(scratch, 'opt');
    const unpacked = join(opt, 'field-0.2.0');
    mkdirSync(join(opt, '2.0.1'), { recursive: true });
    mkdirSync(unpacked);
    symlinkSync('2.0.1', join(opt, 'current'));
    writeFileSync(join(opt, 'release.conf'), 'repo=someone/field\nref=v9\n');
    serveInstaller('audiofield/field', 'v0', 0);
    const lines: string[] = [];
    expect(upgrade('status', { root: unpacked, env: env(), err: (line) => lines.push(line) })).toBe(0);
    expect(readFileSync(argsFile, 'utf8')).toBe('1:status\n\n');
    expect(lines).toEqual([`+ curl -fsSL file://${raw}/audiofield/field/v0/install.sh | bash -s -- status`]);
  });

  it('refuses with the URL when the installer does not download', () => {
    rmSync(raw, { recursive: true });
    expect(() => upgrade('status', { root: join(data, '0.2.0'), env: env(), err: () => {} })).toThrow(
      `cannot upgrade: could not download the installer from file://${raw}/someone/field/v9/install.sh — for a private repository, set GITHUB_TOKEN`,
    );
  });

  it("runs a checkout's own installer, and downloads nothing", () => {
    const checkout = join(scratch, 'checkout');
    mkdirSync(join(checkout, '.git'), { recursive: true });
    mkdirSync(join(checkout, 'src'));
    writeFileSync(join(checkout, 'src', 'cli.ts'), '');
    writeFileSync(join(checkout, 'install.sh'), `printf '%s\\n' "$#:$*" > "$UPGRADE_ARGS"\n`);
    const lines: string[] = [];
    expect(upgrade('cli', { root: checkout, env: env(), err: (line) => lines.push(line) })).toBe(0);
    expect(readFileSync(argsFile, 'utf8')).toBe('1:cli\n');
    expect(lines).toEqual([`+ ${realpathSync(checkout)}/install.sh cli`]);
  });
});

describe('the installer download', () => {
  it("sends GITHUB_TOKEN to GitHub in curl's config, never on its command line", () => {
    const url = 'https://raw.githubusercontent.com/audiofield/field/v0/install.sh';
    const request = curlRequest(url, '/tmp/install.sh', { GITHUB_TOKEN: 'secret-token' });
    expect(request.args).toEqual(['-fsSL', '--retry', '2', '-o', '/tmp/install.sh', '--config', '-', url]);
    expect(request.input).toBe('header = "Authorization: Bearer secret-token"\n');
  });

  it('sends no token to any other host, or without one', () => {
    for (const url of ['https://example.com/install.sh', 'http://raw.githubusercontent.com/x', 'file:///tmp/install.sh']) {
      expect(curlRequest(url, '/tmp/install.sh', { GITHUB_TOKEN: 'secret-token' }).input).toBeUndefined();
    }
    expect(curlRequest('https://github.com/x', '/tmp/install.sh', {}).input).toBeUndefined();
  });
});
