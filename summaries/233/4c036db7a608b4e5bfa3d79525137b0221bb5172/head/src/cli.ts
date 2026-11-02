#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import { Command } from 'commander';
import {
  drawSeed,
  formatSeeds,
  parseBars,
  parseGenTarget,
  parseBpm,
  parseChannels,
  parseConviction,
  parseDurationSeconds,
  parseExaggeration,
  parseExportBitDepth,
  parseExportRate,
  parseCountIn,
  parseInputChannels,
  parseSeed,
  parseVariantNumber,
  parseVariants,
  wantsVersion,
} from './cliParsers.js';
import { buildLabels, explainLabel, explanationJson, projectRelative, queryDeps, remoteReads } from './commands/build.js';
import { formatReach, rootNote } from './model/levels.js';
import { formatCable } from './model/cables.js';
import { playThroughDaemon, resolvePlayables, type Playable } from './commands/play.js';
import {
  transportCommand,
  transportLocate,
  transportStatusLines,
} from './commands/transport.js';
import { check } from './commands/check.js';
import { runScProgram } from './generators/supercollider.js';
import { createSong, createTrack } from './commands/create.js';
import { fmt } from './commands/fmt.js';
import { importAsset } from './commands/import.js';
import { init } from './commands/init.js';
import type { BuildOutcome } from './graph/build.js';
import {
  diagnosticErrors,
  findProjectRoot,
  formatDiagnostic,
  loadProject,
} from './model/project.js';

const program = new Command();

function requireRoot(): string {
  const root = findProjectRoot(process.cwd());
  if (!root) {
    process.stderr.write('not inside a Field project (no field.yaml found)\n');
    process.exit(1);
  }
  return root;
}

function fail(err: unknown): never {
  process.stderr.write(`${(err as Error).message}\n`);
  process.exit(1);
}

program
  .name('field')
  .description('Git-native, agent-operable music production')
  // Declared so it appears in `field --help`, not so commander acts on it —
  // argv is intercepted below. Dropping `.version()` took the flag out of
  // the help text, which left the only remaining way to ask undiscoverable:
  // `field version` errors with no suggestion and `--help` did not mention
  // the flag, so a change called "one way" shipped zero findable ones (#70
  // review). The description earns its place too — `--version` printing a
  // daemon report is not what the flag usually means.
  .option('-V, --version', 'which build this is, and which build each daemon is running');

// `field --version` is the only way to ask. It briefly printed the bare
// number while a `field version` subcommand printed the report, which is
// two commands differing by two dashes and a thing to remember for no
// benefit — and the obvious one gave the least useful answer. `--version`
// is the spelling every CLI has, so it is the one that stays; if a script
// ever needs only the number, the first line still starts with it.
//
// Handled before parse because commander's `.version()` can only print a
// static string, and this has to do real work.
async function printVersion(): Promise<void> {
  const { versionReport, formatVersionReport } = await import('./commands/version.js');
  const root = findProjectRoot(process.cwd()) ?? process.cwd();
  process.stdout.write(formatVersionReport(await versionReport(root), root) + '\n');
}

program
  .command('init')
  .description('initialize a Field project in the current directory')
  .option('--name <slug>', 'project name (defaults to the directory name)')
  .option('--sample-rate <hz>', 'project sample rate', (v) => Number(v))
  .option('--license <spdx>', "the project's license, an SPDX identifier such as CC-BY-4.0 (default: none)")
  .action((opts: { name?: string; sampleRate?: number; license?: string }) => {
    try {
      const root = init({ dir: process.cwd(), ...opts });
      process.stdout.write(`initialized Field project at ${root}\n`);
    } catch (err) {
      fail(err);
    }
  });

// The remote verbs (remote.md §3). `login` and `logout` mint and forget a
// token; `clone` expands a short name, clones with LFS, and warms the
// cache; `push` and `pull` are Git's verbs with the artifact offer and
// the warm behind them; `git-credential` is the helper that lets Git
// share the stored token.
program
  .command('login')
  .description('log in to an audiofield remote with a device code')
  .option('--remote <url>', "the site to log in to (default: this project's, or audiofield.io)")
  .action(async (opts: { remote?: string }) => {
    try {
      const { login, remoteForLogin } = await import('./commands/login.js');
      const { RemoteClient } = await import('./remote/client.js');
      const { defaultCredentialStore } = await import('./remote/credentials.js');
      const remote = remoteForLogin(process.cwd(), process.env, opts.remote);
      const store = defaultCredentialStore();
      const result = await login(remote, {
        client: new RemoteClient(remote),
        store,
        out: (line) => process.stdout.write(`${line}\n`),
      });
      const who = result.login ? ` as ${result.login}` : '';
      process.stdout.write(`logged in to ${remote}${who} (token in ${store.kind})\n`);
    } catch (err) {
      fail(err);
    }
  });

program
  .command('logout')
  .description('forget the stored token, revoking it on the remote when reachable')
  .option('--remote <url>', "the site to log out of (default: this project's, or audiofield.io)")
  .action(async (opts: { remote?: string }) => {
    try {
      const { logout, remoteForLogin } = await import('./commands/login.js');
      const { RemoteClient } = await import('./remote/client.js');
      const { defaultCredentialStore } = await import('./remote/credentials.js');
      const remote = remoteForLogin(process.cwd(), process.env, opts.remote);
      await logout(remote, {
        store: defaultCredentialStore(),
        client: (token) => new RemoteClient(remote, { token }),
        out: (line) => process.stdout.write(`${line}\n`),
      });
    } catch (err) {
      fail(err);
    }
  });

program
  .command('clone <target> [dir]')
  .description('clone <owner>/<project> from the remote (or any clone URL) and warm the build cache')
  .action(async (target: string, dir: string | undefined) => {
    try {
      const { clone } = await import('./commands/clone.js');
      const result = await clone({
        target,
        dir,
        cwd: process.cwd(),
        out: (line) => process.stdout.write(`${line}\n`),
      });
      process.stdout.write(`cloned into ${projectRelative(process.cwd(), result.dir)}\n`);
    } catch (err) {
      fail(err);
    }
  });

// `push` and `pull` are `git push` and `git pull` with everything after
// the verb handed to Git untouched, so `-u origin main` and `--force`
// mean what they mean there; the offer and the warm follow.
program
  .command('push')
  .description('git push, then offer the renders this machine holds to the remote')
  .allowUnknownOption()
  .allowExcessArguments()
  .action(async (_opts: unknown, cmd: { args: string[] }) => {
    try {
      const { push } = await import('./commands/push.js');
      await push({ cwd: process.cwd(), gitArgs: cmd.args, out: (line) => process.stdout.write(`${line}\n`) });
    } catch (err) {
      fail(err);
    }
  });

program
  .command('pull')
  .description('git pull, then warm the build cache for the new HEAD')
  .allowUnknownOption()
  .allowExcessArguments()
  .action(async (_opts: unknown, cmd: { args: string[] }) => {
    try {
      const { pull } = await import('./commands/pull.js');
      await pull({ cwd: process.cwd(), gitArgs: cmd.args, out: (line) => process.stdout.write(`${line}\n`) });
    } catch (err) {
      fail(err);
    }
  });

// Git's credential helper, configured by `clone` as `!field
// git-credential` for the git host and passed per invocation by `push`
// and `pull`. Git speaks to it on stdin/stdout; nothing else calls it,
// hence hidden from --help.
program
  .command('git-credential <operation>', { hidden: true })
  .action(async (operation: string) => {
    try {
      if (operation !== 'get') return; // store/erase: Field manages the token itself
      const { gitCredentialGet } = await import('./commands/login.js');
      const { defaultCredentialStore } = await import('./remote/credentials.js');
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
      const answer = gitCredentialGet(Buffer.concat(chunks).toString('utf8'), defaultCredentialStore());
      if (answer !== undefined) process.stdout.write(answer);
    } catch (err) {
      fail(err);
    }
  });

const sc = program.command('sc').description('SuperCollider');
sc.command('render <program>')
  .description('render an SC program directly (uncached, for iteration; a supercollider: entry is the cached form)')
  .requiredOption('--seed <n>', 'random seed', parseSeed)
  .requiredOption('--duration <seconds>', 'render length in seconds', parseDurationSeconds)
  .option('--channels <n>', '1 or 2', parseChannels, 2)
  .option('--output <path>', 'output WAV path (defaults to <program>.wav in the current directory)')
  .action(async (programPath: string, opts: { seed: number; duration: number; channels: number; output?: string }) => {
    try {
      const root = findProjectRoot(process.cwd());
      const project = root ? loadProject(root) : undefined;
      const sampleRate = project?.manifest?.data.sample_rate ?? 48000;
      const output = resolve(opts.output ?? `${basename(programPath, extname(programPath))}.wav`);
      await runScProgram(resolve(programPath), output, {
        seed: opts.seed,
        duration: opts.duration,
        channels: opts.channels,
        sampleRate,
      });
      if (!existsSync(output)) {
        throw new Error('sc program exited without writing FIELD_OUTPUT');
      }
      process.stdout.write(`rendered ${output} (seed ${opts.seed}, ${opts.duration}s @ ${sampleRate} Hz)\n`);
    } catch (err) {
      fail(err);
    }
  });

// The deliberate-trigger verbs over the generator category
// (project-layout.md §1.7): the recipe's model field says which generator
// ran, so the verbs carry no model prefix.
program
  .command('setup [worker]')
  .description('set up generation worker environments (uv; explicit, never automatic)')
  .option('--existing', 're-sync only the environments already set up, and set up no new one')
  .option('--check', 'report whether each environment is set up and current, changing nothing')
  .action(async (worker: string | undefined, options: { existing?: boolean; check?: boolean }) => {
    try {
      const { checkWorkers, selectWorkers, setupWorker } = await import('./commands/generate.js');
      if (options.check === true) {
        if (options.existing === true) throw new Error('--check changes nothing, so it takes no --existing');
        const { lines, ok } = checkWorkers(selectWorkers(worker));
        for (const line of lines) process.stdout.write(`${line}\n`);
        if (!ok) process.exitCode = 1;
        return;
      }
      await setupWorker((line) => process.stdout.write(`${line}\n`), worker, { existing: options.existing });
    } catch (err) {
      fail(err);
    }
  });
// Installing belongs to install.sh: a checkout runs its own, and a release
// install downloads the newest release's, so an upgrade works from any
// directory (install.md §2.5, §3.2).
program
  .command('upgrade [target]')
  .description("run the installer from anywhere, a checkout's own install.sh or the newest release's: all (the default), cli, audiod, workers, or status")
  .action(async (target: string | undefined) => {
    try {
      const { upgrade } = await import('./commands/upgrade.js');
      process.exitCode = upgrade(target);
    } catch (err) {
      fail(err);
    }
  });
program
  .command('uninstall')
  .description("remove field: a release install's versions and shim, or a checkout's pnpm link (the checkout itself stays)")
  .action(async () => {
    try {
      const { uninstall } = await import('./commands/upgrade.js');
      process.exitCode = uninstall();
    } catch (err) {
      fail(err);
    }
  });
program
  .command('generate <target>')
  .description('run a deliberate generator: fills a generative entry as <song>/<name> (a new name scaffolds a leaf track); variants land in songs/<song>/audio/<name>/')
  .option('--song <name>', 'retired — the song rides in the name (creek/lead-take)')
  .option('--prompt <text>', 'what to generate — music, through field-aced')
  .option('--text <line>', 'the line to speak or sing — voice, through field-voiced')
  .option('--seed <n>', 'base seed; variant i uses seed+i (default: random, recorded per take)', parseSeed)
  .option('--bars <n>', 'music: length in bars at the song tempo (or use --duration)', parseBars)
  .option('--duration <seconds>', 'music: length in seconds (or use --bars)', parseDurationSeconds)
  .option('--variants <n>', 'how many variants (1-8)', parseVariants, 2)
  .option('--lyrics <text>', 'music: lyrics (omit for instrumental)')
  .option('--bpm <n>', 'music: override the tempo-map bpm hint', parseBpm)
  .option('--voice-ref <asset>', "voice: the committed recording that defines the voice (omit for the model's own)")
  .option('--exaggeration <n>', 'voice: expressive intensity, 0.25-2 (lower is calmer and slower)', parseExaggeration)
  .option('--conviction <n>', 'voice: how hard it commits to the on-text reading, 0.1-1 (lower lingers)', parseConviction)
  .action(async (target: string, opts: {
    song?: string; prompt?: string; text?: string; seed?: number; bars?: number; duration?: number;
    variants: number; lyrics?: string; bpm?: number; voiceRef?: string;
    exaggeration?: number; conviction?: number;
  }) => {
    try {
      // The song rides in the name like every other command's labels;
      // the flag survives only to say so, concretely, to fingers and
      // docs that learned the old spelling.
      if (opts.song !== undefined) {
        throw new Error(
          `--song has retired — the song rides in the name: ` +
            `field generate ${opts.song}/${target} …`,
        );
      }
      const { song, name } = parseGenTarget(target, 'generate');
      const { generateVariants } = await import('./commands/generate.js');
      // A seed is provenance, not reproducibility — inference does not
      // reproduce across GPU/framework versions (bloom-in-tree.md §3),
      // and every take records the seed it ran with — so an omitted
      // --seed draws one and the output names it below.
      const seed = opts.seed ?? drawSeed();
      const result = await generateVariants(requireRoot(), name, {
        song,
        prompt: opts.prompt,
        text: opts.text,
        seed,
        bars: opts.bars,
        durationSeconds: opts.duration,
        variants: opts.variants,
        lyrics: opts.lyrics,
        bpm: opts.bpm,
        voiceRef: opts.voiceRef,
        exaggeration: opts.exaggeration,
        conviction: opts.conviction,
        onProgress: (stage) => process.stdout.write(`… ${stage}\n`),
      });
      // A voice line has no requested length to report; what it has is
      // the voice it was generated in, which is either a committed
      // recording or the model's own (voice-generation.md §6).
      const detail =
        result.durationSeconds !== undefined
          ? `${result.durationSeconds.toFixed(1)}s` +
            `${result.bpm !== undefined ? ` @ ${result.bpm} bpm` : ''}, `
          : `voice: ${result.voiceRef ?? "the model's own"}, `;
      process.stdout.write(
        `generated ${result.files.length} variants (${detail}${result.model}, ${formatSeeds(result.seeds)})\n`,
      );
      for (const file of result.files) process.stdout.write(`  ${file}\n`);
      process.stdout.write(`recipe: ${result.recipePath}\n`);
      process.stdout.write(
        `audition: field play //songs/${song}/gen:${name}-1\n` +
          `choose:   field choose //songs/${song}/gen:${name} --variant <n>\n`,
      );
    } catch (err) {
      fail(err);
    }
  });
program
  .command('choose <target>')
  .description("repoint which take a gen node or record entry plays (<song>/<name>)")
  .option('--song <name>', 'retired — the song rides in the name (creek/still-water-keys)')
  .option('--variant <n>', 'a generative variant, by number (1-based, as played/numbered)', parseVariantNumber)
  .option('--take <name>', 'a recorded take, by name (take-YYYYMMDD-HHMMSS)')
  .action(async (target: string, opts: { song?: string; variant?: number; take?: string }) => {
    try {
      if (opts.song !== undefined) {
        throw new Error(
          `--song has retired — the song rides in the name: ` +
            `field choose ${opts.song}/${target} --variant ${opts.variant ?? '<n>'}`,
        );
      }
      const { song, name } = parseGenTarget(target, 'choose');
      if ((opts.variant === undefined) === (opts.take === undefined)) {
        throw new Error('choose takes exactly one of --variant <n> (a gen node) or --take <name> (a record entry)');
      }
      if (opts.take !== undefined) {
        // A record entry's take (recording.md §3): one line in
        // audio/<node>/takes.yaml, and every placement of the track
        // follows, exactly as a variant.
        const { chooseTake } = await import('./commands/land.js');
        const result = await chooseTake(requireRoot(), song, name, opts.take);
        const moved = result.previous !== undefined && result.previous !== opts.take;
        process.stdout.write(
          `${moved ? 'moved' : 'chose'} ${name} → ${opts.take}\n` +
            `the record entry in ${song}/${name} now plays it; every placement follows\n`,
        );
        return;
      }
      const { chooseVariant } = await import('./commands/generate.js');
      const result = await chooseVariant(requireRoot(), name, {
        song,
        variant: opts.variant!,
      });
      const moved = result.previous !== undefined && result.previous !== opts.variant;
      process.stdout.write(
        `${moved ? 'moved' : 'chose'} ${name} → variant ${opts.variant} (${result.file})\n` +
          `//songs/${song}/gen:${name} now plays it; every placement follows\n`,
      );
    } catch (err) {
      fail(err);
    }
  });

const song = program.command('song').description('manage songs');
song
  .command('create <name>')
  .description('create a song with default tempo and meter')
  .action((name: string) => {
    try {
      const dir = createSong(requireRoot(), name);
      process.stdout.write(`created ${dir}\n`);
    } catch (err) {
      fail(err);
    }
  });

const track = program.command('track').description('manage tracks');
track
  .command('create <song> <name>')
  .description('create a track in a song')
  .action((songName: string, name: string) => {
    try {
      const path = createTrack(requireRoot(), songName, name);
      process.stdout.write(`created ${path}\n`);
    } catch (err) {
      fail(err);
    }
  });

const insert = program.command('insert').description("manage a track's inserts");
insert
  .command('add <track> [plugin]')
  .description('add an insert to a track (interactive chooser when no plugin is named)')
  .option('--at <position>', '1-based chain position for the new insert, or "end"')
  .option('--id <handle>', 'instance id (needed when the chain repeats a plugin)')
  .option('--au', 'prefer the AU when a name matches both formats')
  .option('--vst3', 'prefer the VST3 when a name matches both formats')
  .action(async (trackRef: string, pluginName: string | undefined, opts: { at?: string; id?: string; au?: boolean; vst3?: boolean }) => {
    try {
      if (opts.au === true && opts.vst3 === true) throw new Error('--au and --vst3 are exclusive');
      const { addInsert } = await import('./commands/insert.js');
      // The interactive halves exist exactly where a TTY does; a
      // script gets the recorded non-interactive answers instead
      // (add-insert.md §2) — named plugin required, end position,
      // duplicate case refused.
      const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
      const hooks = interactive
        ? await (async () => {
            const { runPicker } = await import('./commands/picker.js');
            return {
              choosePlugin: (items: import('./commands/picker.js').PickerItem<import('./audio/plugins.js').PluginInfo>[]) =>
                runPicker('plugin', items),
              choosePosition: (labels: string[], defaultIndex: number) =>
                runPicker(
                  'position',
                  labels.map((label, i) => ({
                    label: i === defaultIndex ? `${label} (default)` : label,
                    search: label.toLowerCase(),
                    value: i,
                  })),
                  // The cursor starts where the label says it does —
                  // bare Enter is the default, not the first row
                  // (Bugbot on #155).
                  defaultIndex,
                ),
              askId: async (prompt: string): Promise<string | undefined> => {
                const { createInterface } = await import('node:readline/promises');
                const rl = createInterface({ input: process.stdin, output: process.stdout });
                try {
                  const answer = await rl.question(`${prompt}: `);
                  return answer.trim() === '' ? undefined : answer.trim();
                } finally {
                  rl.close();
                }
              },
            };
          })()
        : undefined;
      const outcome = await addInsert(requireRoot(), trackRef, {
        ...(pluginName !== undefined ? { plugin: pluginName } : {}),
        ...(opts.at !== undefined ? { at: opts.at } : {}),
        ...(opts.id !== undefined ? { id: opts.id } : {}),
        ...(opts.au === true ? { prefer: 'au' as const } : {}),
        ...(opts.vst3 === true ? { prefer: 'vst3' as const } : {}),
        ...(hooks !== undefined ? { hooks } : {}),
      });
      if (outcome.cancelled === true) {
        process.stdout.write('nothing added\n');
        return;
      }
      const p = outcome.plugin!;
      process.stdout.write(
        `added ${p.name} (${p.format} ${p.identifier} ${p.version}) → ` +
          `${outcome.song}/${outcome.track} position ${outcome.position}/${outcome.chainLength} (${outcome.file})\n`,
      );
      if (outcome.backfilled!.length > 0) {
        process.stdout.write(`ids written on existing instances: ${outcome.backfilled!.join(', ')}\n`);
      }
      // The handoff add-insert.md §5 records: once editor sessions
      // land (plugin-hosting.md chunk 3) this runs field open instead
      // of naming it.
      // outcome.address, not outcome.track: a colliding track name
      // needs its song qualifier here too, or the advertised command
      // cannot identify the insert just added (Codex on #155).
      process.stdout.write(
        `field open ${outcome.address}/${outcome.handle} will open its editor once editor sessions land\n`,
      );
    } catch (err) {
      fail(err);
    }
  });

program
  .command('import <file>')
  .description('copy an audio file into a song and record it (and its WAV facts) in assets.yaml')
  .requiredOption('--song <name>', 'song to import into')
  .option('--name <slug>', 'asset name (defaults to the slugified filename)')
  .option('--allow-mismatch', "import a WAV whose sample rate differs from the project's")
  .action(async (file: string, opts: { song: string; name?: string; allowMismatch?: boolean }) => {
    try {
      // The y/N prompt is the interactive half of decision 5's
      // acknowledgement; scripts pass --allow-mismatch instead.
      const confirmMismatch = process.stdin.isTTY
        ? async (message: string): Promise<boolean> => {
            const { createInterface } = await import('node:readline/promises');
            const rl = createInterface({ input: process.stdin, output: process.stdout });
            try {
              const answer = await rl.question(`${message}\nimport anyway? [y/N] `);
              return answer.trim().toLowerCase() === 'y';
            } finally {
              rl.close();
            }
          }
        : undefined;
      const result = await importAsset(requireRoot(), opts.song, file, opts.name, {
        allowMismatch: opts.allowMismatch,
        confirmMismatch,
      });
      const facts =
        result.header !== undefined
          ? `, ${result.header.sampleRate} Hz ${result.header.bitsPerSample}-bit ` +
            `${result.header.channels}ch, ${result.header.frames} frames`
          : '';
      process.stdout.write(`imported ${result.name} (${result.file}, ${result.bytes} bytes${facts})\n`);
      process.stdout.write(`sha256 ${result.sha256}\n`);
      if (result.headerProblem !== undefined) {
        process.stdout.write(
          `note: WAV header unreadable, nothing recorded — ${result.headerProblem}\n`,
        );
      }
    } catch (err) {
      fail(err);
    }
  });

// What happened to a label, in one word: a committed source (an asset, a
// chosen variant) was never built at all, so saying `cached` about it
// claims a cache hit that never happened. Padded to a common width so the
// labels line up down the column.
function buildStatus(o: BuildOutcome): string {
  const status =
    o.committed === true ? 'source' : o.fetched === true ? 'fetched' : o.cached ? 'cached' : 'built';
  return status.padEnd(6);
}

program
  .command('build <patterns...>')
  .description('build labels (creek/track:drums, creek/..., or a bare song for its output track)')
  .option('--watch', 'rebuild on project changes until ctrl-c, reporting outputs that audibly moved')
  .option('--no-remote', 'skip the remote cache for this build (remote.md §3.4)')
  .action(async (patterns: string[], opts: { watch?: boolean; remote?: boolean }) => {
    try {
      const root = requireRoot();
      if (opts.watch !== true) {
        // A local miss asks the project's remote before rendering; a miss
        // there, or no remote at all, renders as before. Watch mode does
        // not read through: a rebuild loop that waits on a network every
        // edit is a different trade, not yet made.
        const outcomes = await buildLabels(
          root,
          patterns,
          undefined,
          (line) => process.stdout.write(`check: ${line}\n`),
          undefined,
          remoteReads(root, { noRemote: opts.remote === false }),
        );
        for (const o of outcomes) {
          const where = o.outputPath ? ` → ${projectRelative(root, o.outputPath)}` : '';
          process.stdout.write(`${buildStatus(o)}  ${o.label}${where}\n`);
        }
        return;
      }
      // Watch mode (watch.md): the first build is the baseline; every
      // settled change rebuilds and reports labels whose output hash
      // moved. A red project prints its diagnostics and keeps the last
      // good outputs (§1.2) — so unlike a plain build, watch starts fine
      // on a project that doesn't currently check.
      const abort = new AbortController();
      process.once('SIGINT', () => abort.abort());
      let first = true;
      await import('./commands/watch.js').then(({ watchBuild }) =>
        watchBuild(root, patterns, { signal: abort.signal }, {
          onDiagnostics: (lines) => {
            for (const line of lines) process.stdout.write(`check: ${line}\n`);
          },
          onOutcomes: (outcomes, changed) => {
            if (first) {
              first = false;
              for (const o of outcomes) {
                process.stdout.write(`${buildStatus(o)}  ${o.label}\n`);
              }
              process.stdout.write('watching for changes (ctrl-c stops)\n');
              return;
            }
            if (changed.length === 0) {
              process.stdout.write('· no audible change\n');
              return;
            }
            for (const o of changed) {
              process.stdout.write(`↻ ${o.label} ${o.sha256.slice(0, 12)}\n`);
            }
          },
          onError: (err, phase) => process.stdout.write(`${phase} failed: ${err.message}\n`),
        }),
      );
    } catch (err) {
      fail(err);
    }
  });

program
  .command('export <patterns...>')
  .description('build labels and copy the results to ~/Desktop as numbered versions')
  .option('--to <dir>', 'destination directory instead of ~/Desktop (must exist)')
  .option('--rate <hz>', "deliver at this sample rate (default: the source's)", parseExportRate)
  .option('--bit-depth <bits>', "deliver at this bit depth: 16, 24, or 32 (default: the source's; a float source must choose)", parseExportBitDepth)
  .action(async (patterns: string[], opts: { to?: string; rate?: number; bitDepth?: 16 | 24 | 32 }) => {
    try {
      const { exportLabels, homeRelative } = await import('./commands/export.js');
      const root = requireRoot();
      const results = await exportLabels(root, patterns, {
        to: opts.to,
        rate: opts.rate,
        bitDepth: opts.bitDepth,
        remote: remoteReads(root),
      });
      for (const r of results) {
        // Three outcomes, one column: a new version, nothing to do, and
        // the one worth stopping on — these bytes are an *older* version,
        // so a change was undone and the newest export is not what you
        // just built. All three words are 8 characters, so the labels
        // line up down the column.
        const reverted = r.unchanged && r.version < r.newest;
        const status = reverted ? 'reverted' : r.unchanged ? 'current ' : 'exported';
        const note = reverted ? ` (v${r.newest} is newer and different)` : '';
        process.stdout.write(`${status} ${r.label} → ${homeRelative(r.to)}${note}\n`);
      }
    } catch (err) {
      fail(err);
    }
  });

// The retiring fallback for machines without the built daemon: playback
// through afplay, no transport, no --from. macOS only, and deliberately
// not replaced anywhere else: since realtime.md, `field play` IS live
// evaluation in the daemon, and a second, worse playback path would be
// a liability, not a feature. Decided for Windows in
// windows-portability.md §2.2 and widened to every non-macOS platform
// with §2.2's own reasoning (recorded there as an amendment): afplay is
// dead code off macOS by definition, so the caller refuses before it
// gets here, and says so instead of announcing a fallback that cannot
// run (#162 review caught the docs describing the wide guard first).
async function playWithAfplay(items: Playable[]): Promise<void> {
  for (const item of items) {
    process.stdout.write(`playing ${item.label}\n`);
    const interrupted = await new Promise<boolean>((done, reject) => {
      const child = spawn('afplay', [item.path], { stdio: 'inherit' });
      child.on('error', (err) => reject(new Error(`afplay failed: ${err.message}`)));
      child.on('exit', (code, signal) => {
        if (signal !== null) return done(true); // ctrl-c: stop the queue
        if (code !== 0) return reject(new Error(`afplay exited ${code} for ${item.path}`));
        done(false);
      });
    });
    if (interrupted) break;
  }
}

program
  .command('play <patterns...>')
  .description('play a song live in the engine, or audition built artifacts in order (ctrl-c stops)')
  .option('--from <position>', 'start at bar[.beat[.tick]] (one song or one artifact)')
  .option('--device <name>', 'output device (field devices lists them)')
  .option('--loop', 'loop the song at its declared extent, or replay an artifact queue')
  .option('--click', "overlay a metronome, synthesized in the engine against the song's tempo map")
  .option('--watch', "follow the project: edits land mid-play (a song's live session)")
  .action(async (patterns: string[], opts: { from?: string; device?: string; loop?: boolean; click?: boolean; watch?: boolean }) => {
    try {
      const root = requireRoot();
      const project = loadProject(root);
      // A bare song name plays live (realtime.md decision 8: since the
      // freeze, live evaluation is what playing a song *is* — clean
      // subgraphs arrive as cached stems, only dirt costs). An explicit
      // label — `creek/track:main`, an asset, several patterns — stays
      // file playback of the built artifact.
      const liveSong =
        patterns.length === 1 && project.songs.find((s) => s.name === patterns[0])
          ? patterns[0]!
          : undefined;
      if (liveSong !== undefined) {
        const { playLiveSession } = await import('./commands/play.js');
        let interrupted = false;
        process.once('SIGINT', () => {
          interrupted = true;
        });
        let onLine = false;
        const liveAbort = new AbortController();
        process.once('SIGINT', () => liveAbort.abort());
        await playLiveSession(
          root,
          project,
          liveSong,
          {
            ...(opts.device !== undefined ? { device: opts.device } : {}),
            ...(opts.from !== undefined ? { from: opts.from } : {}),
            ...(opts.loop === true ? { loop: true } : {}),
            ...(opts.click === true ? { click: true } : {}),
            ...(opts.watch === true ? { watch: true, signal: liveAbort.signal } : {}),
          },
          {
            onItem: (label, note) =>
              process.stdout.write(`live    ${label}${note ? `  (${note})` : ''}\n`),
            onPosition: (line) => {
              process.stdout.write(`\r${line}   `);
              onLine = true;
            },
            onReloaded: (note) => {
              if (onLine) process.stdout.write('\n');
              onLine = false;
              process.stdout.write(`edit    ${note}\n`);
            },
            onWatchError: (message) => {
              if (onLine) process.stdout.write('\n');
              onLine = false;
              process.stderr.write(`watch   ${message}\n`);
            },
            interrupted: () => interrupted,
          },
        );
        if (onLine) process.stdout.write('\n');
        return;
      }
      let items = await resolvePlayables(root, patterns, undefined, remoteReads(root));
      const { AudiodClient, daemonBinary } = await import('./audiod/client.js');
      const { BUILD_DAEMON } = await import('./remedies.js');
      if (!daemonBinary()) {
        if (process.platform !== 'darwin') {
          // afplay is a macOS binary: anywhere else the fallback could only
          // die with ENOENT naming a tool this machine never had, so the
          // build hint is the whole answer.
          throw new Error(`field-audiod is not built, and the afplay fallback is macOS-only — run ${BUILD_DAEMON}`);
        }
        if (opts.from !== undefined || opts.device !== undefined || opts.loop === true || opts.click === true || opts.watch === true) {
          throw new Error(`--from, --device, --loop, --click, and --watch need field-audiod (${BUILD_DAEMON})`);
        }
        process.stderr.write(`field-audiod is not built; using afplay (${BUILD_DAEMON})\n`);
        await playWithAfplay(items);
        return;
      }
      if (opts.watch === true) {
        // The loop-wrap takeover retired with the live engine
        // (realtime.md chunk 3): edits land mid-play there, no wrap wait.
        throw new Error("play --watch follows a song's live session: field play <song> --watch");
      }

      const watchAbort = new AbortController();
      let interrupted = false;
      process.once('SIGINT', () => {
        // Stop the daemon's transport from a second connection — the
        // blocking play then sees 'stopped' and winds down the queue.
        interrupted = true;
        watchAbort.abort();
        void (async () => {
          try {
            const c = await AudiodClient.connect(root, { spawnIfNeeded: false });
            await c.stop();
            c.close();
          } catch {
            // daemon already gone
          }
        })();
      });

      const tty = process.stdout.isTTY === true;
      let onPositionLine = false;
      const say = (line: string): void => {
        if (onPositionLine) process.stdout.write('\n');
        onPositionLine = false;
        process.stdout.write(`${line}\n`);
      };



      await playThroughDaemon(
        root,
        project,
        items,
        opts,
        {
          onItem: (label, note) => say(`playing ${label}${note}`),
          onPosition: (line) => {
            if (tty) {
              process.stdout.write(`\r  ${line}   `);
              onPositionLine = true;
            }
          },
          onDevice: (name) => say(`→ output moved to ${name}`),
          interrupted: () => interrupted,
        },
      );
      if (onPositionLine) process.stdout.write('\n');
    } catch (err) {
      fail(err);
    }
  });

const transport = program
  .command('transport')
  .description('control the running daemon (field play starts it)');
transport
  .command('status')
  .description('state, position, file, and device')
  .action(async () => {
    try {
      const root = requireRoot();
      for (const line of await transportStatusLines(root, loadProject(root))) {
        process.stdout.write(`${line}\n`);
      }
    } catch (err) {
      fail(err);
    }
  });
transport
  .command('locate <position>')
  .description('jump to bar[.beat[.tick]] in the loaded file')
  .action(async (position: string) => {
    try {
      const root = requireRoot();
      process.stdout.write(`${await transportLocate(root, loadProject(root), position)}\n`);
    } catch (err) {
      fail(err);
    }
  });
for (const op of ['play', 'pause', 'stop', 'quit'] as const) {
  transport
    .command(op)
    .description(
      op === 'quit'
        ? 'shut the daemon down (it respawns on the next play — how to pick up a new build)'
        : `${op} the transport`,
    )
    .action(async () => {
      try {
        await transportCommand(requireRoot(), op);
      } catch (err) {
        fail(err);
      }
    });
}

program
  .command('ui <song>')
  .description('open the web face on a song: transport, lanes, levels, mute and solo (ctrl-c stops)')
  .option('--port <port>', 'bind this port instead of a random one', (v) => parseInt(v, 10))
  .option('--no-open', 'print the URL without opening anything')
  .option('--browser', 'open a browser tab instead of the app window')
  .action(async (song: string, opts: { port?: number; open?: boolean; browser?: boolean }) => {
    try {
      const root = requireRoot();
      const { runUi } = await import('./commands/ui.js');
      await runUi(root, song, { ...(opts.port !== undefined ? { port: opts.port } : {}), open: opts.open !== false, browser: opts.browser === true });
    } catch (err) {
      fail(err);
    }
  });

program
  .command('record [targets...]')
  .description('record a take on a track through field-audiod: arms an input, or MIDI when the track has an instrument, takes against what is playing, ctrl-c stops and finalizes')
  .option('--input <n,...>', 'input channel on the device, counting from 1, one per audio track in the order named (default 1, 2, ...); audio takes only', parseInputChannels)
  .option('--device <name>', 'input device (field devices lists them; default: the system input); audio takes only')
  .option('--at <position>', 'start at bar[.beat[.tick]] of the loaded song')
  .option('--click', 'a metronome through the take, synthesized in the engine against the song\'s map')
  .option('--count-in <bars>', 'pre-roll this many bars before --at, clicking; the take begins exactly at --at', parseCountIn)
  .option('--until <position>', 'punch out at bar[.beat[.tick]]: the take ends there exactly and lands while the mix plays on')
  .option('--loop', 'loop --at to --until, landing a take every pass until ctrl-c (needs a live song as the bed); audio takes only')
  .option('--monitoring <mode>', 'how you monitor the take, recorded on its row (default apollo-direct); host plays each audio input through its track')
  .option('--console-preset <name>', 'the Console preset the take expects, recorded on its row')
  .option('--list', 'list the transactions under .field/recording/ instead of recording')
  .option('--recover <id>', 'finalize a take a dead daemon left behind and land it, instead of recording')
  .option('--land <id>', 'land a finalized transaction nothing landed, instead of recording')
  .action(
    async (
      targets: string[],
      opts: {
        input?: number[];
        device?: string;
        at?: string;
        click?: boolean;
        countIn?: number;
        until?: string;
        loop?: boolean;
        monitoring?: string;
        consolePreset?: string;
        list?: boolean;
        recover?: string;
        land?: string;
      },
    ) => {
      try {
        const root = requireRoot();
        const { describeTake, landRecording, listRecordings, recordTake, recoverRecording } =
          await import('./commands/record.js');
        const landOptions = {
          monitoring: opts.monitoring ?? 'apollo-direct',
          ...(opts.consolePreset !== undefined ? { consolePreset: opts.consolePreset } : {}),
        };
        // What landing did, in one line: the take, where it sits on the
        // track, and where its bytes went.
        const landedLine = (landed: import('./commands/land.js').LandedTake): string => {
          const where =
            landed.row.musical_position !== undefined
              ? `bar ${landed.row.musical_position.join('.')}`
              : `sample ${landed.placedAt}`;
          const seconds = (landed.frames / landed.sampleRate).toFixed(1);
          const events = landed.events !== undefined ? `, ${landed.events} event${landed.events === 1 ? '' : 's'}` : '';
          const note =
            landed.placements > 1
              ? `  (${landed.track} is placed ${landed.placements} times; the take counts from the first)`
              : '';
          return `take    ${landed.song}/${landed.node} ← ${landed.asset} at ${where}, chosen (${landed.file}, ${seconds} s${events})${note}`;
        };
        if (opts.list === true) {
          const entries = await listRecordings(root);
          if (entries.length === 0) process.stdout.write('no transactions under .field/recording/\n');
          for (const entry of entries) process.stdout.write(`${describeTake(entry)}\n`);
          return;
        }
        if (opts.recover !== undefined) {
          const { landed } = await recoverRecording(root, opts.recover, landOptions);
          process.stdout.write(`${landedLine(landed)}\n`);
          return;
        }
        if (opts.land !== undefined) {
          const { landed } = await landRecording(root, opts.land, landOptions);
          process.stdout.write(`${landedLine(landed)}\n`);
          return;
        }
        if (targets.length === 0) {
          throw new Error(
            'record needs a track to record (creek/track:lead-vocal), or --list / --recover <id> / --land <id>',
          );
        }
        const project = loadProject(root);
        let interrupted = false;
        process.once('SIGINT', () => {
          // The loop in recordTake sees this on its next tick and sends
          // the stop itself — one connection, so the finalized take comes
          // back in the stop's response.
          interrupted = true;
        });
        const tty = process.stdout.isTTY === true;
        let onPositionLine = false;
        const say = (line: string): void => {
          if (onPositionLine) process.stdout.write('\n');
          onPositionLine = false;
          process.stdout.write(`${line}\n`);
        };
        const { takes, missed } = await recordTake(
          root,
          project,
          targets,
          {
            ...(opts.input !== undefined ? { input: opts.input } : {}),
            ...(opts.device !== undefined ? { device: opts.device } : {}),
            ...(opts.at !== undefined ? { at: opts.at } : {}),
            ...(opts.click === true ? { click: true } : {}),
            ...(opts.countIn !== undefined ? { countIn: opts.countIn } : {}),
            ...(opts.until !== undefined ? { until: opts.until } : {}),
            ...(opts.loop === true ? { loop: true } : {}),
            ...landOptions,
          },
          {
            onBed: say,
            onArmed: say,
            onCountIn: say,
            onStarted: say,
            onTake: (landed) => say(landedLine(landed)),
            onPosition: (line) => {
              if (tty) {
                process.stdout.write(`\r  ${line}   `);
                onPositionLine = true;
              }
            },
            interrupted: () => interrupted,
          },
        );
        // Each take printed as it landed (onTake); what is left to say is
        // the tally under a loop — passes lost included, so the count of
        // takes is never mistaken for the count of passes — and any gaps.
        if (takes.length > 1 || missed > 0) {
          const lost =
            missed > 0
              ? `, ${missed} pass${missed === 1 ? '' : 'es'} missed (the region is shorter than the daemon's tick)`
              : '';
          say(`${takes.length} take${takes.length === 1 ? '' : 's'} landed${lost}; ${takes.at(-1)!.landed.asset} is chosen`);
        }
        for (const { take } of takes) {
          if (take.dropped !== undefined && take.dropped > 0) {
            say(
              'kind' in take
                ? `warning: ${take.id}: ${take.dropped} MIDI messages were lost before they reached the take; notes may be missing, or held to the take's end`
                : `warning: ${take.id}: ${take.dropped} frames were dropped (the disk writer fell behind); the take has gaps`,
            );
          }
        }
      } catch (err) {
        fail(err);
      }
    },
  );

program
  .command('devices')
  .description('list output and input devices via field-audiod (spawns it if needed)')
  .action(async () => {
    try {
      const { AudiodClient } = await import('./audiod/client.js');
      const client = await AudiodClient.connect(requireRoot());
      const result = await client.devices();
      client.close();
      if (result.null_output) {
        process.stdout.write('daemon is in null-output mode (no devices)\n');
        return;
      }
      // Two lists now that the input side exists (recording.md §6); the
      // `*` marks the system default on each, which is what an unnamed
      // --device (play) or --device (record) uses.
      process.stdout.write('output:\n');
      for (const device of result.devices) {
        process.stdout.write(`${device.default ? '* ' : '  '}${device.name}\n`);
      }
      if (result.inputs.length > 0) {
        process.stdout.write('input:\n');
        for (const device of result.inputs) {
          const channels = `${device.channels} channel${device.channels === 1 ? '' : 's'}`;
          process.stdout.write(`${device.default ? '* ' : '  '}${device.name}  (${channels})\n`);
        }
      }
    } catch (err) {
      fail(err);
    }
  });

program
  .command('keys [targets...]')
  .description(
    'play the computer keyboard as the MIDI source "Field Keys", and SuperCollider instruments from it: name instruments, ' +
      'or tracks (creek/track:keys) to play the instrument each track names, all at once ' +
      '(needs a terminal with the kitty keyboard protocol; Ctrl-C quits)',
  )
  .option('--keymap <name or path>', 'a built-in keymap by name, or your own keymap file by path (default: $FIELD_KEYMAP, then musical)')
  .option(
    '--knobs <name or path>',
    "a knob file to show and turn, for any instrument listening to Field Keys: a bare name is the project's " +
      'shared/instruments/<name>.knobs.yaml, anything else a path (repeatable)',
    (value: string, previous: string[]) => [...previous, value],
    [] as string[],
  )
  .option('--device <name>', 'output device for the instrument (field devices lists them; default: the system output)')
  .option('--print', 'print the keymap as a keyboard diagram and exit')
  .action(async (targets: string[], opts: { keymap?: string; print?: boolean; device?: string; knobs?: string[] }) => {
    try {
      const { keysCommand } = await import('./commands/keys.js');
      await keysCommand(targets, opts);
    } catch (err) {
      fail(err);
    }
  });

program
  .command('query <expr>')
  .description("query the graph: a pattern, or deps(creek/track:drums)")
  .action((expr: string) => {
    try {
      for (const label of queryDeps(requireRoot(), expr)) {
        process.stdout.write(`${label}\n`);
      }
    } catch (err) {
      fail(err);
    }
  });

program
  .command('explain <label>')
  .description('show a label\'s type, inputs, action key, and cache status')
  .option('--no-remote', 'do not consult the remote cache')
  .option('--json', 'print the explanation as JSON')
  .action(async (label: string, opts: { remote?: boolean; json?: boolean }) => {
    try {
      const root = requireRoot();
      const e = await explainLabel(root, label, remoteReads(root, { noRemote: opts.remote === false }));
      if (opts.json === true) {
        process.stdout.write(`${explanationJson(e)}\n`);
        return;
      }
      process.stdout.write(`${e.label} (${e.kind})\n`);
      // The CLI speaks the format's language (project-layout.md §4):
      // type, not the engine's rule.
      if (e.rule) process.stdout.write(`type: ${e.rule} v${e.ruleVersion}\n`);
      // "Which variant are we using" is this command's question to
      // answer: the chosen line on the request's own label, the bare
      // file on a per-take audition label.
      if (e.choice) {
        process.stdout.write(
          `chosen: variant ${e.choice.chosen} of ${e.choice.takes} (${e.file})\n`,
        );
      } else if (e.file) {
        process.stdout.write(`file: ${e.file}\n`);
      }
      for (const input of e.inputs) {
        const sha = input.sha256 ? input.sha256.slice(0, 12) : '(not built)';
        process.stdout.write(`input: ${input.label} ${sha}\n`);
      }
      if (e.parameters && Object.keys(e.parameters).length > 0) {
        process.stdout.write(`parameters: ${JSON.stringify(e.parameters)}\n`);
      }
      if (e.actionKey) {
        const state = e.fetched ? 'fetched' : e.cached ? 'cached' : 'not cached';
        process.stdout.write(`action: ${e.actionKey.slice(0, 12)} (${state})\n`);
      }
      for (const out of e.outputs ?? []) {
        process.stdout.write(`output: ${out.sha256.slice(0, 12)} (${out.bytes} bytes)\n`);
      }
      // Where the signal goes, for a track. Last because it is the mix
      // question and everything above it is the build question — and
      // because it is the line someone came here for when a level
      // surprised them (nested-tracks.md §5).
      if (e.levels) {
        if (e.levels.reaches.length === 0) {
          process.stdout.write(`reaches: ${rootNote(e.levels.track)}\n`);
        }
        for (const reach of e.levels.reaches) {
          process.stdout.write(`reaches: ${formatReach(reach)}\n`);
        }
        // A cable appears when either end's level is questioned
        // (nested-tracks.md §19): the edge's gain is part of the answer
        // neither track file shows in full.
        for (const cable of e.levels.cables) {
          process.stdout.write(`cable: ${formatCable(cable, e.levels.track)}\n`);
        }
      }
    } catch (err) {
      fail(err);
    }
  });

program
  .command('check')
  .description('validate schemas, references, asset content, and formatting')
  .action(async () => {
    let result;
    try {
      result = await check(requireRoot());
    } catch (err) {
      fail(err);
    }
    for (const p of result.pinned) {
      process.stdout.write(
        `pinned ${p.plugin} → ${p.format} ${p.identifier} ${p.version} (${p.file})\n`,
      );
    }
    for (const d of result.diagnostics) {
      process.stdout.write(`${formatDiagnostic(d)}\n`);
    }
    for (const f of result.unformatted) {
      process.stdout.write(`${f}: not canonically formatted (run field fmt)\n`);
    }
    if (result.ok) process.stdout.write('ok\n');
    process.exit(result.ok ? 0 : 1);
  });

const plugins = program.command('plugins').description('hosted plugin inventory');
plugins
  .command('scan')
  .description('scan installed AU/VST3 plugins into .field/plugins.json')
  .action(async () => {
    const { scanCommand } = await import('./commands/plugins.js');
    try {
      scanCommand(requireRoot());
    } catch (err) {
      fail(err);
    }
  });
plugins
  .command('list')
  .description('print the scanned plugin inventory')
  .action(async () => {
    const { listCommand } = await import('./commands/plugins.js');
    listCommand(requireRoot());
  });
plugins
  .command('pin')
  .description('write plugin identities, versions and latency back into track files')
  .option('--au', 'prefer the AU when a name matches both formats')
  .option('--vst3', 'prefer the VST3 when a name matches both formats')
  .option('--update', 'accept installed versions over drifted pins (a deliberate re-render)')
  .action(async (options: { au?: boolean; vst3?: boolean; update?: boolean }) => {
    const { pinCommand } = await import('./commands/plugins.js');
    const prefer = options.au === true ? 'au' : options.vst3 === true ? 'vst3' : undefined;
    const ok = pinCommand(requireRoot(), {
      ...(prefer !== undefined ? { prefer } : {}),
      ...(options.update !== undefined ? { update: options.update } : {}),
    });
    if (!ok) process.exit(1);
  });

program
  .command('fmt')
  .description('rewrite project files to canonical formatting')
  .action(() => {
    const result = fmt(requireRoot());
    if (result.errors.length > 0) {
      for (const e of result.errors) process.stderr.write(`${e}\n`);
      process.stderr.write('fix validation errors before formatting\n');
      process.exit(1);
    }
    for (const f of result.formatted) process.stdout.write(`formatted ${f}\n`);
    if (result.formatted.length === 0) process.stdout.write('already canonical\n');
  });

program
  .command('arrangement <song>')
  .description("the song's structure, derived from its output track's placements")
  .option('--json', 'print the arrangement as JSON')
  .action(async (songName: string, opts: { json?: boolean }) => {
    try {
      const { arrangement, arrangementJson } = await import('./commands/arrangement.js');
      process.stdout.write(`${(opts.json === true ? arrangementJson : arrangement)(requireRoot(), songName)}\n`);
    } catch (err) {
      fail(err);
    }
  });
program
  .command('status')
  .description('summarize the project')
  .action(() => {
    const root = requireRoot();
    const project = loadProject(root);
    const name = project.manifest?.data.name ?? '(invalid manifest)';
    const rate = project.manifest?.data.sample_rate;
    process.stdout.write(`project ${name}${rate ? ` @ ${rate} Hz` : ''}\n`);
    for (const song of project.songs) {
      const inputs = song.tracks.reduce((n, t) => n + t.data.inputs.length, 0);
      process.stdout.write(`  ${song.name}: ${song.tracks.length} tracks, ${inputs} inputs\n`);
    }
    const problems = diagnosticErrors(project.diagnostics).length;
    const warned = project.diagnostics.length - problems;
    if (problems > 0) process.stdout.write(`${problems} problems (run field check)\n`);
    if (warned > 0) process.stdout.write(`${warned} warnings (run field check)\n`);
  });

// Positional: `argv[2]` is the only place this flag means the whole
// program. `includes()` matched it anywhere, so `field build --version`
// printed a version report and silently never built — a parser would have
// rejected an unknown option on `build`, where this substituted a
// different command (#70 review). Every other shape goes to commander,
// which already knows how to complain about it.
if (wantsVersion(process.argv)) {
  await printVersion().catch(fail);
} else {
  await program.parseAsync();
}
