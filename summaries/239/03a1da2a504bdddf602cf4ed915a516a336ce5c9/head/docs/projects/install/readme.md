---
status: in-progress
priority: now
---

# Install and upgrade

**Goal:** one command installs Field and another keeps it current, the
way Projector's `install.sh` and `project upgrade` do. `./install.sh`
installs a checkout today, and `field upgrade` runs it from any
directory. Field can cut releases now, and once the release installer
exists, `curl -fsSL https://field.one/install.sh | bash` installs one
with no clone, building it as the checkout installer does, and
`field upgrade` moves it to the next release.

## 1 The problem

Installing Field from a checkout is four commands from the README, each
of which has to be run from the checkout:

```sh
pnpm install
pnpm build
pnpm add -g .
pnpm build:native
```

Nothing tells you when the result goes stale. After a `git pull`, the
linked `field` runs the old `dist/` until someone runs `pnpm build`, the
daemon stays the old build until someone runs `pnpm build:native`, and a
worker environment keeps the old packages until someone runs
`field setup`. `field --version` catches the first of those, and only
when someone thinks to ask. The second and third have each cost a
debugging round: `src/commands/version.ts` records a `field-voiced`
that silently dropped a flag it predated, and a venv that held a stale
copy of `field_worker` while the CLI read the new source.

The remedies are also in the wrong place. Eight error messages told you
to run `pnpm build:native`, and every one of them fires while you are
inside a song project, where `build:native` is not a script.

And there is no way to install Field without a clone at all.
`okamnesiac/field` is about to become public, and `field.one` should be
able to offer the one-line install that <https://projector.bot> offers
for Projector.

## 2 The solution

### 2.1 One installer, two modes

`install.sh` at the root of the repository is the only installer. It is
a checkout's installer when `src/cli.ts` and a `.git` sit beside it, and
a release installer otherwise: piped from curl, bash reads it from stdin
with nothing beside it, the copy `field upgrade` downloads sits alone in
a temporary directory, and a release version's own copy has the source
beside it but no `.git`. Chunk 1 built the checkout mode, and chunk 3
the release mode (§3.2). Until chunk 3, the release mode said to clone
and stopped.

The test asks for `.git` beside the installer, a directory or a
worktree's file, rather than asking `git rev-parse`, which needs git
installed and answers yes for a directory inside some other repository.
The whole script defines functions and calls `main "$@"` on its last
line, so a `curl | bash` cut short by a dropped connection runs nothing.

### 2.2 The targets

`./install.sh [target]` takes one target, and `all` when given none:

| Target | Runs |
| --- | --- |
| `cli` | `pnpm install --frozen-lockfile`, `pnpm run build`, `pnpm run build:ui`, and `pnpm add -g <checkout>` unless pnpm's global `field` already links this checkout. |
| `audiod` | `pnpm run build:native`. |
| `workers` | `field setup --existing` (§2.4). |
| `all` | `cli`, `audiod`, `workers`. |
| `status` | One row per fact, changing nothing (§2.6). |

Every target except `status` ends by fetching the checkout's upstream
and warning when the checkout is behind it. The installer never pulls.

Each prerequisite is checked before anything changes, and a missing one
stops the installer with exit status 69 and a message that names the
fix: Node 24 or newer, pnpm, a pnpm global bin directory on PATH
(`pnpm setup`), and for `audiod` and `all` CMake 3.24 or newer, a C++
compiler, git, and on Linux make and JUCE's development headers. Every
check runs before the installer stops, so one run names all that is
missing (§3.4). An unknown target exits 64.

### 2.3 The CLI is a link to the checkout

`pnpm add -g <checkout>` makes pnpm's global `node_modules/field` a
symlink into the checkout, and its bin directory gets a `field` shim
that runs `dist/cli.js` through it. The installer keeps that, which is
what the README already documented and what every existing install is.
`pnpm ls -g --json` names the global package's path, and its realpath is
the checkout it links, so the installer can tell an install of this
checkout from one of another.

A link that already points here is left alone. One that points at
another checkout moves, with a `moved` row naming both, because running
the installer in a checkout means "make `field` this one".

### 2.4 Worker environments re-sync, and none is set up

`field setup --existing` re-syncs each worker environment that is
already set up and sets up no new one. Setting a worker up stays explicit
([ace-generation.md](../ace-generation/readme.md) §3.4), because the
first `field generate` after it downloads gigabytes of weights;
re-syncing one that exists downloads none. Set up means the worker's
console script is installed in `python/<worker>/.venv`, the same test
`field generate` gates on, not that a `.venv` exists: a dev-only
`uv sync` makes one with no worker in it (#61).

`field setup --check` prints one row per worker in the installer's row
format, from `probeEnvironment`, the side-effect-free probe
`field generate` refuses on. `install.sh status` passes those rows
through. The CLI answers both questions, rather than the installer
listing `python/*/`, because `SETUP_SPECS` is the one list of workers
(#67).

### 2.5 `field upgrade` runs the installer

`field upgrade [target]` runs the `install.sh` beside the package it was
loaded from, with the same target, and returns its exit status. It
prints the command first, as Projector's does:

```console
$ field upgrade status
+ /Users/you/field/install.sh status
checkout       ~/field (main at f80efb6)
...
```

For a linked checkout, the package it was loaded from is the checkout,
so `field upgrade` reaches the right installer from any directory with
no record of where it was installed from. Projector reads pip's
`direct_url.json` for the same answer; a link carries it. It runs the
installer through `bash`, not through its execute bit, which a checkout
with `core.fileMode` off does not keep.

The installer's own messages name `field upgrade <target>` as the way
back when pnpm's `field` links this checkout, and the script's path
otherwise. The CLI's own remedies come from `src/remedies.ts`, so they
name the upgrade rather than a pnpm script that is not a script inside a
song project. The eight daemon error messages name `BUILD_DAEMON`, which
is `field upgrade audiod`. `field --version` names `BUILD_CLI` for a
stale build, and `field ui` names `BUILD_UI` for a missing client and
`INSTALL_UI` for a missing app shell, each of which is
`field upgrade cli`. On Windows each names its pnpm script in the
checkout instead, because `field upgrade` refuses there (§7.6).

### 2.6 `status` compares what is installed with its source

| Piece | Current when | Compared by |
| --- | --- | --- |
| Checkout | it is not behind its upstream after a fetch | `git rev-list --count HEAD..@{upstream}`, as Projector's installer does, and `@{upstream}..HEAD` for `repo-ahead` |
| CLI | `dist/` was built from `HEAD` with the same number of uncommitted changes | `dist/build-info.json`, which `pnpm build` stamps and `field --version` already reads |
| UI | no tracked file it may bundle is newer than `ui/dist/index.html`: anything under `ui/` or `src/` but a test, and `pnpm-lock.yaml` | file mtimes, because Vite rewrites `index.html` on every build (§8.1) |
| Daemon | no tracked file under `native/audiod` is newer than the binary | file mtimes, with the binary touched after each build (§8.1) |
| Workers | each one set up passes `uv sync --check --locked` | `field setup --check` |

`docs/install.md` lists every row.

### 2.7 Files

| File | Change |
| --- | --- |
| `install.sh` | New. The installer. |
| `src/commands/upgrade.ts` | New. `field upgrade`. |
| `src/commands/generate.ts` | `selectWorkers`, `partitionExisting`, and `checkWorkers`; `setupWorker` takes `existing`. |
| `src/cli.ts` | `field upgrade`, and `--existing` and `--check` on `field setup`. |
| `scripts/gen-plan-limits.ts` | Writes the header only when it changes (§8.1). |
| `src/remedies.ts` | New. `BUILD_CLI`, `BUILD_UI`, `INSTALL_UI`, and `BUILD_DAEMON`, the commands the CLI's messages name (§2.5). |
| `src/audiod/client.ts`, `src/audio/plugins.ts`, `src/audio/render-daemon.ts`, `src/keys/helper.ts` | The daemon error messages name `BUILD_DAEMON`. |
| `src/commands/version.ts`, `src/commands/ui.ts` | A stale build, a missing client, and a missing app shell name `field upgrade cli`. |
| `docs/install.md` | New. How install and upgrade work, and every status row. |
| `docs/cli.md` | The install section, `field upgrade`, and the new `field setup` options. |
| `README.md`, `examples/bloom/README.md` | Lead with `./install.sh`. |

### 2.8 Output fits on one screen

An install prints its rows and nothing else that stays on screen. Until
2026-10-12 every build step streamed its output, and the upgrade to
0.3.1 printed screen after screen of it, almost all compiler warnings
from JUCE's modules, HarfBuzz, and the VST3 SDK. `field-audiod` links
`juce::juce_recommended_warning_flags`, and JUCE compiles its modules
inside the target, so the strict warnings meant for Field's code hit
JUCE's too.

Each command a target runs to build, link, or set up, which `step` in
`install.sh` wraps, writes its output to one log per run, made with
`mktemp` in `$TMPDIR`. On a terminal, the command and its last five
lines show dimmed under the rows as they arrive, redrawn in place and
cut short of the terminal's width so no line wraps, and erased when the
command ends, as Docker shows a build. The redraw moves up one row per
line, so a line that wrapped would leave output behind. Bash cannot
measure a character's width, so each line drawn is ASCII: a character
outside it, such as CJK, which a terminal draws two columns wide, shows
as `?`, and control characters are dropped. The width comes from `stty
size`, then `COLUMNS`, then 80. Off a terminal, such as in a log
or CI, nothing shows. A command that fails prints the end of its own
output and the log's path, and the log stays. A target that succeeds
removes it. `FIELD_VERBOSE=1` streams every line instead, and makes no
log. The rows a target prints, such as `building`, `built`, and
`switched`, are unchanged.

## 3 Releases and the one-line install

These are chunks 2 to 4. They are designed far enough to show that
chunk 1 does not paint them into a corner, and the open questions in §7
decide the rest.

### 3.1 Releases (chunk 2)

A release is a version tag and a GitHub release, as Projector's are,
and publishes no files. Whoever installs it builds it from the tag's
source, the daemon included, because Field publishes no daemon binary
(§7.1). `docs/release.md` describes how to cut one.

The version is `package.json`'s, the one `field --version` prints.
`scripts/release.ts`, modeled on Projector's `.github/scripts/release.py`,
has four commands:

| Command | Does |
| --- | --- |
| `bump patch\|minor\|major` | Raises one part of the version, writes it to `package.json`, and prints it. |
| `set X.Y.Z` | Writes an exact version. Both refuse a version that does not go up. |
| `released` | Exits 0 when `origin` has a tag for the version on `origin/main`, and 3 when it does not. With `--since COMMIT`, it also exits 0 when that version is not above `COMMIT`'s. |
| `tag` | Tags that version `vX.Y.Z`, force-moves the major tag `v0` to the same commit, pushes both in one atomic push, and creates the GitHub release with generated notes. `--no-release` skips the GitHub release. |

`.github/workflows/release.yml` runs them as Projector's Release
workflow does. Started by hand with `patch`, `minor`, or `major`, its
propose job runs `bump` on a `release/vX.Y.Z` branch and opens the
release pull request. When a change to `package.json` reaches `main`,
its publish job runs `released --since` with the commit `main` held
before the push, and `tag` when that exits 3. So only a push that raises
the version releases, even while the version has no tag, as 0.1.0, the
version `main` starts at, has none (§9.1). Node 24 runs the script
directly by stripping its types, and the script imports only Node's own
modules, so neither job installs a dependency.

`field-audiod` (`native/audiod/src/version.h`) and the model workers
(`DAEMON_VERSION`) keep versions of their own. They report them in
`hello`, the daemon stamps its version into take manifests, and they
move with what each process does, so a release leaves them alone.

### 3.2 The release installer (chunk 3)

Without a checkout, `install.sh` installs a release by building it.
`docs/install.md` describes it for users; this is the design.

1. It asks GitHub's git server, with `git ls-remote`, which commit
   `FIELD_REF` (default `v0`) names in `FIELD_REPO` (default
   `audiofield/field`), and reads the version from `package.json` at
   that commit, which is how Projector's installer learns the version
   it is installing. It accepts only `X.Y.Z`. When git cannot answer, it
   reads `package.json` at the ref instead (§10.1).
2. It downloads GitHub's source archive of the immutable tag for that
   version, `vX.Y.Z` rather than `v0`, checks that the archive holds one
   top-level directory whatever its name, that its `package.json`
   names the version, and that its `install.sh` writes the shim, and
   moves it to `<data>/<version>/`. A version whose installer writes no
   shim is from before release installs, and its `field upgrade` could
   never upgrade it (§4). A version directory that is not current is
   never trusted: it is deleted and downloaded again.
3. It runs the same steps a checkout install runs, with the same
   prerequisite checks, plus curl and tar: `pnpm install
   --frozen-lockfile`, the CLI and UI builds, and the daemon build. It
   never runs `pnpm add -g`.
4. It sets up, in the new version, each worker set up in the version it
   replaces (§7.5).
5. It switches `<data>/current`, a relative symlink, to the new version
   atomically, writes the `field` shim, records `release.conf`, and
   removes every version but the new one and the one it replaced.
   `FIELD_DATA_DIR` can name a directory that holds other things, so the
   installer lists, replaces, and removes only what it can show it made:
   a directory named `X.Y.Z` whose `install.sh` carries the shim's
   marker, which step 2 requires of every version, and the
   `.download-X.Y.Z` directory it unpacks a version in. Any other
   directory where it would put the version stops it with exit status
   69 before anything changes.

Steps 1 to 4 leave the installed version alone, so a failed download,
build, or worker setup leaves it current, and an exit trap says so and
removes the new version's directory and its download. This
moves the worker setup ahead of the switch, where the first draft of
this section put it after.

The data directory is `FIELD_DATA_DIR`, then `$XDG_DATA_HOME/field` when
that is an absolute path, then `~/.local/share/field`. A version's own
`install.sh` infers it from the `current` link beside the version's
directory, and `field upgrade` does the same from its package's real
path, but only when that directory is named `X.Y.Z`. A `current` link
beside any other directory, such as the `field-0.2.0` that GitHub's
archive unpacks to, belongs to another program, so the default applies.

**The shim.** `field` is a two-line script in `FIELD_BIN_DIR` (default
`~/.local/bin`) that runs `exec node '<data>/current/dist/cli.js' "$@"`,
with a marker comment that identifies it. Switching `current` moves
`field` with nothing to relink, and a release install needs no pnpm
global bin directory. The installer refuses, with exit status 69, to
replace a `field` there that is not its shim, and to start when it
cannot write the bin directory, because the shim is written after the
switch. A bin directory missing from PATH is a `not-on-path` warning
that names the line to add, not a stop, and `cli-shadowed` reports a
`field` that comes first on PATH in either direction.

**JUCE's download.** `native/audiod/CMakeLists.txt` reads
`$ENV{FIELD_FETCHCONTENT_BASE_DIR}` into CMake's cache as
`FETCHCONTENT_BASE_DIR` before `include(FetchContent)`, and the
installer exports it, in release mode only, as
`<data>/cache/fetchcontent`. An environment variable, because
`pnpm build:native` passes no `-D` and a `${VAR:+-D…}` in the script
would break under Windows' `cmd.exe`. JUCE's helper build lands in that
directory too, so an upgrade skips the download and the helper, and
compiles JUCE's modules again as part of `field-audiod` (§10.1).

**`field upgrade`.** `src/commands/upgrade.ts` tells the two installs
apart by the same test as the installer. In a release install it reads
`release.conf` beside the real path of its package root, with
`FIELD_REPO` and `FIELD_REF` ahead of the record and the defaults last.
It downloads `install.sh` from `raw.githubusercontent.com` at the
commit that ref names, found as the installer finds it, prints `+ curl
-fsSL <url> | bash -s -- <target>`, and runs it with `FIELD_DATA_DIR`
set. It never asks
`field.one`, which serves only the upstream's `v0`, and a fork must
upgrade from the fork. Under `FIELD_OFFLINE` it downloads nothing, and
runs the installed version's own `install.sh` instead.

**The targets in a release install.** `all` installs the release the ref
names, or, when that version is installed, builds any missing piece,
runs `field setup --existing`, and rewrites the shim. `cli`, `audiod`,
and `workers` rebuild that piece of the installed version in place, as
they rebuild a checkout without pulling, so a command the CLI names,
such as `field upgrade audiod`, works in either install. `status`
compares the installed version with the release and checks each piece
is built. `FIELD_OFFLINE` makes `all` refuse and `status` compare
nothing.

**Tokens.** `GITHUB_TOKEN` goes only to `github.com`,
`raw.githubusercontent.com`, `api.github.com`, and
`codeload.github.com`, over HTTPS, in curl's configuration on standard
input, never on a command line where any process could read it. With
the repository public, it matters only for a private fork.

### 3.3 The one-line install (chunk 4)

```sh
curl -fsSL https://field.one/install.sh | bash
```

`apps/field-one` in `okamnesiac/audiofield` rewrites `/install.sh` to
`https://raw.githubusercontent.com/audiofield/field/v0/install.sh`, as
`projector.bot` does for Projector, so the URL always serves the newest
release's installer rather than `main`'s. The rewrite proxies rather
than redirects, so the command is one request to `field.one`. It needs
the repository to be public: `raw.githubusercontent.com` answers 404 for
a private one. The website and the README then lead with this command.

### 3.4 Missing dependencies (chunks 5 and 6)

A release builds from source, so a first install on a new machine needs
a toolchain, and the one-line install is where most people meet that.
Before chunk 5 the installer stopped at the first missing tool, one tool
a run, and never checked for a compiler, git, or the Linux headers, so a
machine without them failed minutes into compiling JUCE. field.one
listed the requirements under the command instead, which read as a
reason not to run it.

**Chunk 5 names everything missing.** Every check the target needs runs
before the installer stops, and the message lists each missing or old
tool with the commands that install them all: `xcode-select --install`
and one `brew install` on macOS, and one `sudo apt-get install` with the
Debian and Ubuntu package names on Linux, plus a line for what no
package covers, such as Node 24, which Debian and Ubuntu package too
old. For pnpm on Linux that line is `corepack enable pnpm` only where
`corepack` is on PATH, because Node 25 and newer ship without Corepack
(nodejs/node#57617), and pnpm's installation page otherwise. A missing
CMake gets the `cmake` package, unless `apt-cache` says apt-get would
install one older than 3.24, as Ubuntu 22.04 and Debian 11 would. Then
it gets the cmake.org line an old CMake gets, so the next run does not
reject what the first one installed. It checks Xcode's command line
tools on macOS through `xcode-select -p`, never by running
`/usr/bin/c++` or `/usr/bin/git`, which open an install dialog when the
tools are absent. On Linux it checks for a C++ compiler, git, make
unless `CMAKE_GENERATOR` names another generator, and through
`pkg-config` the modules of the headers `ci.yml` installs. It installs
nothing itself.

**Chunk 6 offers to install them.** On macOS with Homebrew, the
installer asks whether to run the `brew install` it would print, and
runs it on a yes, then carries on with the install. Piped from curl,
bash reads the script from stdin, so the question reads its answer from
`/dev/tty`, and with no terminal the installer prints the commands as
chunk 5 does. `xcode-select --install` opens a dialog and returns before
the tools are in place, so it stays a printed step. Not started.

### 3.5 Uninstall (chunk 7)

```sh
field uninstall
curl -fsSL https://field.one/uninstall.sh | bash
```

`install.sh` has an `uninstall` target, and `field uninstall` runs it the
way `field upgrade` runs the installer: a checkout's own `install.sh`,
or the newest release's. Nothing else decides what an uninstall
removes.

- **A release install.** The target removes the shim, but only when it
  carries the installer's marker and runs this data directory's
  `current`; every version and download that the installer can show it
  made, by the same tests `prune` uses; `current`; `release.conf`; and
  JUCE's download in `cache/fetchcontent`. Then it removes the data
  directory if nothing else is left in it. Anything else, in the data
  directory or in the bin directory, stays, with a `kept` row. The shim
  goes first, so `field` never runs a version half removed.
- **A shim that runs another data directory stays.** It is the one
  record of where that install lives, so its `kept` row names the
  directory and says to uninstall again with `FIELD_DATA_DIR` set to
  it. The shim's exec line holds the path it was installed through, and
  `field uninstall` names the data directory by its real path, so the
  two compare as files when their text differs.
- **The model weights stay.** field-aced keeps ACE-Step's in
  `FIELD_ACE_MODELS`, or `~/.field/models/acestep`, which every Field
  install on the machine uses (`models_root` in `python/aced`).
  field-voiced's Chatterbox keeps its weights in the Hugging Face cache
  (`HF_HUB_CACHE`, `HF_HOME`, or `~/.cache/huggingface`), which other
  tools share. For each worker that was set up, the target names the
  directory its weights are in rather than removing it.
- **A checkout install.** The target runs `pnpm remove -g field` when
  pnpm's global `field` links this checkout, leaves a link to another
  checkout alone, and never deletes the checkout, which someone cloned
  and which may hold work in progress.
- **`field.one/uninstall.sh`.** A static file in `apps/field-one/public`
  that runs `curl -fsSL https://field.one/install.sh | bash -s --
  uninstall`. It works when `field` itself no longer does, and keeps the
  logic in the one installer, versioned and tested with it. It shipped
  in okamnesiac/audiofield#43 ahead of the release that carries the
  target, so until that release it runs 0.3.0's installer, which
  rejects `uninstall` with a usage error and exit status 64, changing
  nothing. The page does not advertise it; the README and
  `docs/install.md` do.

## 4 Why this design (DECIDED, 2026-10-11)

- **A bash installer, as Projector has.** A Node script cannot run
  before Node is installed, and a missing or old Node is the first thing
  a fresh machine lacks, so checking for it is the installer's first
  job. `curl | bash` needs bash anyway. Bash 3.2 is what macOS ships, so
  the script uses nothing newer, and the tests run it under 3.2 locally
  and bash 5 in CI.
- **One installer, two modes**, from Projector. One file to maintain,
  and `field upgrade` always runs an `install.sh`, whichever kind of
  install it is.
- **The checkout install stays a pnpm link**, over two alternatives:
  - Copying the checkout into `~/.local/share`, as pipx does for
    Projector. A checkout that moves on then leaves the command behind
    with nothing saying so; Projector's installer diffs every installed
    file against the checkout to notice. A link reduces staleness to
    "is `dist/` built from `HEAD`", which `field --version` already
    answers.
  - A shim in `~/.local/bin` that runs `node <checkout>/dist/cli.js`.
    It would spare newcomers `pnpm setup`, but every existing install is
    a pnpm link and moving them means migrating each one. Release
    installs (chunk 3) were to use `~/.local/bin` because they would not
    need pnpm. Since §7.1 they build with pnpm too, and chunk 3 settled
    it the original way for another reason: the shim moves with
    `current` (the bullet on linking a release install through a shim).
    `status` reports `cli-shadowed` when two `field` commands exist and
    the wrong one is first on PATH.
- **Never pull, never switch branches.** The checkout may hold work in
  progress. `status` reports how far behind it is, which is Projector's
  choice too.
- **Build every time.** `pnpm install` builds through `prepare` only
  when it installed a dependency, so a second run after a `git pull`
  would build nothing. The CLI build takes about three seconds, and the
  UI build about two.
- **`--frozen-lockfile`.** An installer has no business rewriting the
  checkout's lockfile, and pnpm's error says which `package.json` moved
  ahead of it.
- **Workers re-sync; none is set up.** Leaving them out keeps the stale
  venv §1 describes. Setting every worker up starts a 12 GB download
  nobody asked for.
- **The daemon is compared by mtime, not by a stamp.** A commit stamped
  into the binary, as `dist/` has, would need the daemon to report it,
  and would miss uncommitted edits. Mtimes are the build's own test,
  and the installer touches the binary after each build, so
  `audiod-stale` means a source changed since the installer last built
  the daemon, and the build it asks for clears it (§8.1).
- **Releases are tags, and whoever installs one builds it** (§3.1,
  amended 2026-10-11). This first said releases ship built artifacts, a
  CLI tarball and a daemon per platform, so that a release install would
  need no pnpm and no compiler. What changed is §7.1: a published daemon
  binary is a distribution of JUCE and the VST3 SDK under copyleft
  terms, and a user who builds the daemon from the release's source
  distributes nothing. Once every user needs a compiler for the daemon,
  a prebuilt CLI saves only the three seconds `tsc` takes, so it went
  too, and with it the checksums and the per-platform builds. A release
  install runs the steps a checkout install runs. Prebuilt binaries
  remain the optimization to make if the toolchain turns out to be the
  barrier (§7.3).
- **The UI builds with the CLI.** `field ui` serves `ui/dist`, which
  bundles code from `src/`, so a CLI built without its UI leaves
  `field ui` stale or refusing. The `cli` target builds both rather than
  growing a `ui` target, because `field upgrade cli` is then the one
  remedy for either.
- **A release install links `field` through a shim, not `pnpm add -g`**
  (§3.2). A shim in `~/.local/bin` that runs `current/dist/cli.js` moves
  with `current`, so an upgrade relinks nothing, and it needs no pnpm
  global bin directory on PATH. `pnpm add -g` lost because each version
  is a directory of its own, so every upgrade would relink, and because
  it would compete with a checkout's link for the one global `field`.
- **Everything the new version needs happens before the switch** (§3.2).
  Download, build, and worker setup all run while the old version is
  still current, so the only step that changes what `field` runs is one
  atomic rename. Switching first and setting workers up after, as the
  first draft of §3.2 had it, could leave a current version whose
  workers did not set up.
- **The release installer keeps two versions.** The new one, and the one
  it replaced, so going back is one `ln -sfn`. Keeping every version
  lost to disk use: each holds its own `node_modules`, JUCE build, and
  worker environments.
- **An exact tag pins a release install, and the installer refuses a
  version from before release installs** (§3.2). `release.conf` records
  `FIELD_REF` whatever it names, so `FIELD_REF=v0.3.0` keeps repairing
  0.3.0 until `FIELD_REF=v0 field upgrade` records `v0` again. Two
  alternatives lost. Projector's `project upgrade` takes only the
  repository from what pip recorded, so `PROJECTOR_REF` holds for one
  command and the next upgrade returns to `v0`. Here that would make a
  fork that follows its `main` name `FIELD_REF` on every upgrade.
  Treating an exact tag apart from a branch lost because the
  installer cannot tell them apart by name. The way back works only
  for a version whose `field upgrade` reads `FIELD_REF`, and 0.2.0's
  runs its own `install.sh` as a checkout's, so the installer refuses
  any version whose `install.sh` writes no shim.
- **Uninstall is a target of the one installer** (§3.5, decided
  2026-10-11). A separate `uninstall.sh` in this repository lost because
  it would need its own copy of the data directory's resolution and of
  the tests for what the installer made, and the two would drift. A
  `field uninstall` that removes files from TypeScript lost for the same
  reason, and because it cannot help when `field` itself no longer runs.
  `field.one/uninstall.sh` is a static file that runs the installer's
  target, so the curl path needs nothing of its own. Removing the model
  weights lost: other tools share the Hugging Face cache, and every
  Field install on the machine, checkouts included, shares ACE-Step's
  directory.

## 5 Acceptance criteria

Chunk 1:

- In a clone with Node 24, pnpm set up, and CMake, `./install.sh` puts
  `field` on PATH and builds `field-audiod`, and `field --version` in
  `examples/bloom` reports that build.
- A second run does not relink, and the daemon build compiles only what
  changed.
- `field upgrade [target]`, from any directory, runs the linked
  checkout's `install.sh` with the same output and exit status.
- `field upgrade status` reports each state in `docs/install.md` with
  the command that fixes it.
- A missing prerequisite stops the installer before anything changes,
  with exit status 69 and the fix.
- `field upgrade workers` re-syncs the worker environments that are set
  up and creates none.

Chunk 2:

- Running the Release workflow with `patch`, `minor`, or `major` opens a
  pull request that changes only the version in `package.json`.
- Merging it tags `vX.Y.Z`, moves `v0` to the same commit, and creates
  the GitHub release. A `package.json` change that leaves the version
  alone releases nothing.
- A release publishes no files.

Chunk 3:

- On a machine with the checkout installer's prerequisites and no
  checkout, piping `install.sh` at `v0` to bash installs the release
  `v0` names: `field` on PATH through the shim, `field-audiod` built, and
  `field --version` reporting that version.
- Run again for a newer release, it installs that one beside the old,
  switches `current`, keeps the version it replaced, and removes older
  ones, without downloading JUCE again.
- A failed download, build, or worker setup leaves the installed version
  current and working, and says so.
- `field upgrade [target]` in a release install downloads the newest
  installer and runs it with the same target and exit status, and
  `field upgrade status` reports the rows in `docs/install.md`.

Chunk 4:

- `curl -fsSL https://field.one/install.sh | bash` does what chunk 3's
  first criterion says, and field.one leads with that command.

Chunk 5:

- On a machine missing several prerequisites, one run of any target
  names every one its target needs, prints the commands that install
  them for the platform, and exits 69 having changed nothing.
- A missing compiler, git, or Linux header module stops the installer
  before the daemon build rather than inside it.

Chunk 6:

- On macOS with Homebrew and a terminal, a run missing formulae asks to
  install them, installs them on a yes, and goes on to install Field.
- With no terminal, or on a no, it prints the commands as chunk 5 does.

Chunk 7:

- `field uninstall` in a release install removes the shim, every
  version, `current`, `release.conf`, and the JUCE cache, then the data
  directory, and leaves anything the installer did not make.
- In a checkout install it removes pnpm's link to that checkout, and
  never the checkout.
- `curl -fsSL https://field.one/uninstall.sh | bash` does the same once
  a release carries the target.

## 6 Chunks

1. **The checkout installer and `field upgrade`.** §2. Shipped in #185.
2. **Releases.** §3.1. Shipped in #205.
3. **The release installer.** §3.2. Shipped in #214.
4. **The one-line install.** §3.3, in `okamnesiac/audiofield`. Shipped
   in okamnesiac/audiofield#40.
5. **Name everything missing.** §3.4. Shipped in #218.
6. **Offer to install it with Homebrew.** §3.4. Not started.
7. **Uninstall.** §3.5. This change. `field.one/uninstall.sh` shipped
   early, in okamnesiac/audiofield#43, and works once this is released.

## 7 Open questions

### 7.1 The daemon binary's license (DECIDED, 2026-10-11)

Field's code is under the MIT License (#184). The daemon carries more
than Field's code: `field-audiod` links JUCE, which is AGPLv3 or
commercial, and compiles in Steinberg's VST3 SDK, which JUCE 8.0.4
bundles under GPLv3 or Steinberg's proprietary VST3 license. A
commercial JUCE license does not cover the SDK.
[README.md](../../../README.md) "License" and
[architecture.md](../../architecture.md) "Licensing" record these terms.

So a daemon binary that a release published would be a distribution
under AGPLv3 and GPLv3, unless the publisher held both commercial
licenses.

**Decided: Field publishes no daemon binary, and whoever installs Field
builds it.** What a release distributes is Field's MIT source. JUCE is
not in the repository either: `native/audiod/CMakeLists.txt` fetches it
from JUCE's own repository at build time. A user's build is under the
copyleft terms for that user's own use, and those terms attach only to
someone who distributes it. The two options this beat:

- **Publish under the copyleft terms**, with the license notices in the
  daemon's archive and the repository at the release tag as its source.
  It would make the one-line install need no compiler, at the price of
  building, signing, and hosting a binary per platform (§7.3), and of a
  source obligation on every release.
- **Hold both commercial licenses**: a commercial JUCE license and
  Steinberg's proprietary VST3 license. It costs money every month to
  remove an obligation that publishing nothing removes for free.

One obligation remains outside this plan: if audiofield.io ever runs
`field-audiod` on its servers to render for users, AGPLv3 §13 asks it to
offer those users the daemon's source. The source is public, so that is
easy to meet, but it is an obligation.

If prebuilt binaries become worth making, a newer JUCE narrows the
choice they need. Steinberg released VST3 SDK 3.8.0 under the MIT
License
([announcement](https://forums.steinberg.net/t/vst-3-8-0-sdk-released/1011988),
and `LICENSE.txt` at the SDK's `v3.8.0_build_66` tag), and JUCE 8.0.11
is the first JUCE release that bundles it: its
[change list](https://github.com/juce-framework/JUCE/blob/master/CHANGE_LIST.md)
reads "Updated the VST3 SDK to 3.8.0 (MIT license)", and every
`LICENSE.txt` in its `VST3_SDK` directory is MIT. With JUCE 8.0.11 or
later, the SDK asks only that its notice ship with the binary, and the
choice left is JUCE's own: AGPLv3, or a commercial JUCE license. JUCE
8.0.11 also bundles the ASIO SDK under GPLv3, which the daemon does not
enable. Moving the daemon's pin off 8.0.4 is a change of its own.

### 7.2 Platforms

Answered by §7.1. A release has no per-platform files, so it installs
wherever the checkout installer builds: macOS and Linux, on any
architecture CMake and JUCE support. Windows is §7.6.

### 7.3 Where the macOS daemon builds (DECIDED, 2026-10-11)

Nowhere, for now: after §7.1 a release builds nothing that depends on
the platform, so the release workflow runs on Linux in seconds.

If prebuilt binaries come later, they build locally, on a maintainer's
Mac, and `gh release upload` attaches them to the release. GitHub bills
a macOS runner at ten times the Linux rate, a cold JUCE build takes
minutes, and this account caps Actions spending at $40 a month. Building
in the release workflow with a warm cache lost to that cost, and the
price of the local build, a release that depends on one machine, is one
to pay only once binaries exist.

### 7.4 Which domain serves the installer (DECIDED, 2026-10-11)

**Decided: `field.one` serves it.** `field.one` is Field's marketing
site (`apps/field-one` in `okamnesiac/audiofield`), where people looking
for Field arrive, and it held the source-access waitlist that the
install command replaced. Chunk 4 shipped it in
okamnesiac/audiofield#40: the site rewrites `/install.sh` to the
installer at `v0` (§3.3) and leads with
`curl -fsSL https://field.one/install.sh | bash`. The alternative was
`field.amnes.ac`, the repository's GitHub homepage, which serves the
repository's Projector site of plans and reviews, a page for people
working on Field rather than for people installing it.

`install.sh` and `docs/install.md` name the `raw.githubusercontent.com`
URL that `field.one` proxies, so no code depends on the domain.

### 7.5 Worker environments across release versions (DECIDED, 2026-10-11)

In a checkout, a worker's venv lives in `python/<worker>/.venv` and
survives every upgrade. In a release install, each version unpacks into
a directory of its own, so the venv would be left behind with the old
version.

**Decided: an upgrade sets each worker up again in the new version,
before it switches to it.** The old version's `field setup --check`
says which workers are set up; the new version's `field setup <name>`
sets up each one. Nothing large downloads again: the model weights live
outside every version, ACE-Step's in `~/.field/models/acestep` and
Chatterbox's in the Hugging Face cache, and the packages live in uv's
cache. A worker whose uv is gone is skipped with a `worker-skipped` row,
because it could not run in the old version either, and any other
failure stops the upgrade with the old version still current. The
alternative, pointing `UV_PROJECT_ENVIRONMENT` at a directory outside
the version, lost because `workerScriptInstalled` in
`src/workers/client.ts` looks for each worker's console script in
`python/<worker>/.venv`, and one environment shared across versions
would hold the old version's packages while the new one ran.

### 7.6 Windows (DECIDED, 2026-10-11)

`install.sh` is bash, and Field's Windows support is
[windows-portability.md](../windows-portability/readme.md). Windows
installs from a checkout by hand for now, `field upgrade` refuses there
with the steps, a release install refuses in a Windows shell such as Git
Bash, and the installer's tests skip there.

**Decided: this plan builds no `install.ps1`.** A checkout on Windows
installs with the four commands in `docs/install.md`, but a release
install has no checkout to run them in, and the release installer is
bash. An `install.ps1` that downloads and builds a release, with the
daemon under MSVC, is a design that wants a Windows machine to try it
on, so this change hands it to windows-portability.md §7.2, "Installing
and upgrading on Windows", which owns it from here.

## 8 Chunk 1 as built (2026-10-11)

### 8.1 What implementation settled

- **A generated header made the daemon look stale.**
  `src/schema/plan-limits.test.ts` runs `pnpm gen:limits` on every
  `pnpm test`, and the generator rewrote
  `native/audiod/src/plan-limits.h` with identical bytes. The new mtime
  made `audiod-stale` true after every test run, and it made the next
  daemon build recompile every file that includes the header, which the
  stale row was correctly reporting. `scripts/gen-plan-limits.ts` now
  writes only when the content changes, which fixes both.
- **CMake relinks `field-audiod` only when its own inputs change.**
  `native/audiod` also builds `field-dsp-check` and `field-fixture`, and
  an edit to `CMakeLists.txt` may only reconfigure. Comparing the sources
  with the binary alone would leave `audiod-stale` standing after the
  rebuild it asks for, so `install_audiod` touches the binary after each
  successful build.
- **`pnpm install` builds only when it installs.** Verified against pnpm
  11.15.1: a repeat `pnpm install` prints "Already up to date" and skips
  `prepare`. Hence §4's "build every time".
- **The UI needs no install step of its own.** `ui/` is a pnpm
  workspace member, so the root `pnpm install` already installs its
  dependencies, the `electron` package included, and `build:ui` runs
  `tsc --noEmit` and `vite build` in about two seconds. The installer
  runs `build:ui` without checking for `ui/`: `package.json` names the
  script and `pnpm-workspace.yaml` names the directory in the same commit
  as the installer, so a checkout without `ui/` is broken, and the failed
  build says so. The `status` row compares mtimes as the daemon's does,
  over `ui/`, `src/`, and `pnpm-lock.yaml`, because the bundle imports
  from `src/` and nothing cheaper names which files.
- **pnpm refuses to link without its bin directory on PATH**, with
  "Run pnpm setup". The installer checks first, so its own message names
  the command to run again.
- **Worker rows come from the CLI in the installer's format**, so the
  installer passes them through and marks `worker-stale` and
  `worker-no-uv` as warnings. A worker nobody set up is not a problem,
  so `field setup --check` exits 1 only for those two.

### 8.2 What was verified, and how

- `src/install.test.ts` runs the real `install.sh` under real bash
  against a temporary clone, with stand-ins for pnpm, cmake, and the CLI
  and a PATH that holds nothing else. It covers each target, each
  prerequisite failure, the link left alone and moved, and every status
  row, including a checkout behind its upstream, online and offline.
- `src/commands/upgrade.test.ts` runs real bash against a stand-in
  installer: the target, the exit status, the printed command, and a
  missing installer.
- `src/workers/setup.test.ts` covers `--existing` and `--check` against
  a temporary worker, asserting the probe asks uv nothing about a worker
  nobody set up.
- By hand, in a fresh worktree: `./install.sh audiod` built
  `field-audiod` from cold in 3 minutes 8 seconds. With a throwaway
  `PNPM_HOME`, `install.sh cli` run from `/tmp` linked the worktree, a
  second run did not relink, and `field upgrade status` from `/tmp` ran
  the worktree's installer.

### 8.3 What is still owed

- Chunks 2 to 4, and the decisions in §7 that gate them.

## 9 Chunk 2 as built (2026-10-11)

### 9.1 What implementation settled

- **The script is TypeScript that Node runs directly.** Projector's
  release script is Python, its own language; Field's is
  `scripts/release.ts`. Node 24 strips its types, verified on 24.19.0
  with no warning, and it imports only Node's modules, so the workflow
  sets up Node and runs it with no `pnpm install`. `src/release.test.ts`
  imports it, which is what puts it under `pnpm typecheck`.
- **One version file.** Projector's script checks that three version
  files agree. Field releases only `package.json`'s version, because the
  daemon's and the workers' versions describe their protocols (§3.1).
- **The GitHub repository comes from the configured remote URL.**
  `git remote get-url` applies `insteadOf` rewrites, which can turn a
  GitHub URL into a mirror's, so the script reads
  `remote.<name>.url` instead.
- **The remote says what is released.** Projector's script reads its
  local tags. `tag` makes both tags locally before it pushes them, so a
  push the remote refused would leave local tags that the remote never
  got, and every later run in that checkout would call the version
  released. `released` and `tag` ask the remote with `git ls-remote`
  instead, fetch the branch without tags, and `tag` replaces a stale
  local tag of either name. Running `tag` again after a refused push
  releases.
- **Both tags go in one atomic push.** Projector pushes them one at a
  time. A failure between the two would leave `vX.Y.Z` on the remote
  without `v0`, and `released` would then report the version released,
  so no later run would move `v0` or create the GitHub release.
- **Only a push that raises the version releases.** Projector's publish
  job asks only whether the merged version is tagged, which holds there
  because its version was tagged when its workflow landed. Field's
  `main` starts at 0.1.0 with no tag, so that check alone would release
  0.1.0 on the first change to `package.json` of any kind, such as a new
  script. The job passes `github.event.before` to `released --since`,
  which exits 0 unless the push raised the version. A revert of a
  release pull request lowers the version, so it releases nothing
  either. Tagging 0.1.0 as a baseline would also stop it, but that tag
  would name a version nobody released.
- **GitHub Actions may open pull requests only where the enterprise
  allows it.** The first release run (38167355504) pushed
  `release/v0.2.0` and then could not open its pull request, because the
  `amnesiac` enterprise's policy forbade it, and an enterprise policy
  overrides the organization's and the repository's settings. On
  2026-10-11 the enterprise allowed it, the `okamnesiac` organization and
  this repository were set to allow it, and a re-run opened #207.
  `docs/release.md` names all three levels.
- **A pull request the workflow opens gets no CI until someone approves
  it.** For an event that a workflow's own token caused, GitHub creates
  the `pull_request` run but holds it as `action_required`. #207's CI
  run 38167745651 was held that way, and ran, and passed, only when
  Justin approved it. `workflow_dispatch` and `repository_dispatch` are
  exempt, so the propose job dispatches `ci.yml` on the release branch
  after opening the pull request, and `ci.yml` accepts
  `workflow_dispatch`. The checks land on the branch's commit, the pull
  request's head. The held run still appears, and `docs/release.md` tells
  the release's reviewer to leave it unapproved: its concurrency group,
  `CI-refs/pull/<n>/merge`, differs from the dispatched run's
  `CI-refs/heads/release/vX.Y.Z`, so approving it runs every job again.
  Two alternatives lost. Approving the held run by hand needs no workflow
  change, and lost because it is a click on every release, and Justin
  asked for CI to run by itself. A token from a GitHub App would avoid
  the hold, and lost because it needs an App and two secrets to do what
  one extra trigger does.

### 9.2 What was verified, and how

- `src/release.test.ts` runs the script's functions against a temporary
  repository whose `origin` is the path of a bare repository beside it,
  never a GitHub URL. Every git process the file starts, the script's
  included, ignores the user's and the system's git config and any
  repository the environment names, so a `pushInsteadOf` rule in
  `~/.gitconfig` cannot send the suite's pushes to GitHub. A test puts
  such rules in a stand-in home directory and checks that the pushes
  still reach `origin` and never the decoy the rules point at. The file
  also covers each `bump` part, `set` refusing a version that does not
  go up, `tag` pushing both tags and moving `v0` on the next release,
  a remote that refuses one tag receiving neither, a run after a refused
  push releasing, tagging what `origin/main` holds rather than an
  unpushed bump, `released` reading the remote's tags rather than local
  ones, refusing a tagged version, a remote that is not GitHub, the GitHub
  repository read from a remote's configured URL, a failed GitHub
  release naming the command that finishes it, `released`'s exit codes,
  `released --since` releasing nothing unless the version went up, and
  plain `node` running the file.
- Before the merge, the publish step ran verbatim against a local bare
  remote, with `tag --no-release` in place of `tag`. After a push that
  changed only a script in `package.json`, it released nothing, and
  after one that raised the version to 0.2.0, it tagged `v0.2.0` and
  created `v0`.
- After the merge, on GitHub: a push to `main` that changed
  `package.json` without raising the version (878cdbc) released nothing,
  printing "v0.1.0 is not above v0.1.0". The first release, 0.2.0, went
  out through the workflow: #207, opened by the propose job, merged as
  5f7cd66, and publish run 38167947880 tagged `v0.2.0`, created `v0`, and
  published the GitHub release on 2026-10-11.

### 9.3 What is still owed

- Chunks 3 and 4.

## 10 Chunk 3 as built (2026-10-11)

### 10.1 What implementation settled

§3.2 records the design as built. What this section adds is what
building it found.

- **A version directory that is not current is never trusted.** A
  half-unpacked or half-built directory from an interrupted install is
  deleted and downloaded again, rather than resumed, because nothing
  records how far it got. A failed install deletes its own on the way
  out, so `status` does not list it as a `previous` version to switch
  back to. A run killed outright runs no exit trap, so its directory
  stays, and `status` lists it, until the next install deletes it.
- **The archive's top-level directory is taken whatever its name.**
  GitHub names it `<repo>-<version>`, and a fork's differs, so the
  installer checks that there is exactly one and that its
  `package.json` names the version, and moves it into place. macOS `tar`
  adds `._` entries unless `COPYFILE_DISABLE=1` is set, which that check
  rejects, so a stand-in archive made on a Mac needs it.
- **The shared directory holds JUCE's helper build too.**
  `FETCHCONTENT_BASE_DIR` holds `juce-build` beside `juce-src`, so
  CMake builds JUCE's helper tool once. JUCE's modules compile as part
  of `field-audiod`, in each version's own build directory, so an
  upgrade compiles them again. Together, the skipped clone and helper
  build took an upgrade to 58 seconds here, against 258 for the first
  install (§10.2).
- **The first install's clone of JUCE is the slow step.** CMake clones
  JUCE with `--depth 1 --no-single-branch`, which fetches every branch's
  tip, and it took minutes here.
- **The ref is read at its commit, because raw caches it.**
  `raw.githubusercontent.com` serves a file at a tag or branch with
  `cache-control: max-age=300`. A minute after 0.3.1's release moved
  `v0`, `field upgrade` still read 0.3.0 from `v0/package.json`, a
  cache hit, while the same file at `v0.3.1` read 0.3.1. Both the
  installer and `field upgrade` now ask GitHub's git server with `git
  ls-remote` which commit the ref names, which it answers from the
  repository, and read at that commit, whose files never change. They
  name `refs/tags/<ref>^{}` too, because `v0` is an annotated tag and
  `refs/tags/v0` alone names the tag object rather than its commit. When
  git is missing or cannot answer, as for a private fork it has no
  credentials for, they read at the ref as before. Projector's installer
  never meets the lag when it installs: it hands pipx
  `archive/v0.tar.gz`, which `github.com` resolves on each request, and
  reads its manifest from raw only to compare versions in `status`.
- **The native builds use the selected toolchain's SDK.** After a macOS
  27 update, the upgrade to 0.3.4 stopped at CMake's first compiler
  check: `libSystem.tbd` in `MacOSX27.0.sdk` names an architecture,
  `arm64e.x1`, that the linker did not know. `xcode-select` named Xcode
  26.6, whose linker is `ld-1267` and whose newest SDK is 26.5, but the
  update had installed Command Line Tools 27.0, and `xcrun
  --show-sdk-path`, which CMake asks when nothing names an SDK, answered
  with theirs. `xcrun --sdk macosx --show-sdk-path` answers within the
  selected developer directory. `native/macos-sdk.cmake`, which both
  native builds include before `project()`, sets `CMAKE_OSX_SYSROOT` to
  that answer and exports it as `SDKROOT`, because JUCE configures
  `juceaide` in a CMake of its own that is given no sysroot. A
  `CMAKE_OSX_SYSROOT` someone set wins, and then `SDKROOT`, which `xcrun`
  resolves whether it is a path or an SDK's name. The SDK is resolved
  at every configure, so a build directory follows `SDKROOT` or a later
  Xcode update: CMake passes the cached value as `-isysroot`, which the
  compiler prefers to `SDKROOT`, so a cache that kept the first answer
  would ignore both.

### 10.2 What was verified, and how

- `src/install.test.ts` runs the real `install.sh` under real bash with
  stand-ins for pnpm, cmake, curl's targets, and the CLI, for both
  modes: the release version read from `package.json`, the archive's
  checks, the switch, the shim and its refusal to replace another
  `field` or to start in a bin directory it cannot write, `release.conf`,
  pruning, which in a data directory that holds other things removes
  only what the installer made and replaces nothing else, the workers
  set up again, a failure at each step leaving the old version current
  and removing the new one, the refusals of a version from before
  release installs and of a Windows shell, and every status row in each
  mode.
  `src/commands/upgrade.test.ts` covers `field upgrade` downloading the
  installer at the recorded ref, `FIELD_REPO` and `FIELD_REF` ahead of
  the record, running the installed version's own installer under
  `FIELD_OFFLINE`, and `GITHUB_TOKEN` going only to GitHub in curl's
  configuration.
- By hand, on macOS with stand-in releases cut from this branch and
  served from `file://` URLs through `FIELD_RAW_URL` and
  `FIELD_ARCHIVE_URL`, into throwaway data and bin directories:
  - A first install of 0.90.0 took 258 seconds, cloning and compiling
    JUCE, and left `current -> 0.90.0`, the shim, and `release.conf`.
    `field --version` through the shim printed `field 0.90.0`.
  - `field upgrade`, run through that shim, downloaded the newest
    installer, installed 0.91.0 beside 0.90.0 in 58 seconds with no
    clone of JUCE, switched `current`, and kept 0.90.0.
  - Run again with 0.91.0 current, it finished in a second: workers
    re-synced and the shim rewritten.
  - With `v0` naming a 0.92.0 that had no archive, it exited 1 with
    "0.92.0 did not install, so 0.91.0 stays current and field still
    runs it", and `field --version` still printed 0.91.0.
  - `field upgrade status` reported `release-behind` against 0.92.0 and
    `previous` for 0.90.0.
- Not verified: Linux, a real install from GitHub, and pruning a third
  version by hand. The first real one is the release that carries this
  change.

### 10.3 What is still owed

- Nothing. 0.3.0 released this change (#216), and the first real
  install, `curl -fsSL https://raw.githubusercontent.com/okamnesiac/field/v0/install.sh | bash`
  on a Mac into throwaway data and bin directories, took 255 s,
  compiling JUCE from scratch. `field --version` printed `field 0.3.0`
  and `field upgrade status` reported `release-latest 0.3.0 is
  installed`. Chunk 4 shipped in okamnesiac/audiofield#40, and
  `field.one/install.sh` serves the same installer.

## 11 The move to `audiofield/field` (2026-11-01)

Field's repository moved from `okamnesiac/field` to `audiofield/field`,
which holds the open source code from now on. `okamnesiac/fyra` then
takes the old name, as the home of the private code, and that ends
GitHub's redirect from it.

- **The record moves, not only the default.** `release.conf` comes ahead
  of the default, so changing the default alone would leave every
  existing install asking for the old name. `install.sh` and `field
  upgrade` each read a recorded `okamnesiac/field` as `audiofield/field`,
  and the installer writes the new name when it next installs. Only that
  exact name changes: a fork's record stays, and `FIELD_REPO` still wins.
- **`field` 0.3.5 and older can't move themselves after the rename.** They
  download the installer from the recorded name. Before the rename, the
  redirect gives them the new installer, and it moves them. After the
  rename, the download fails, and running
  `curl -fsSL https://field.one/install.sh | bash` moves them instead.
- **The order is website, release, rename.** okamnesiac/audiofield#46
  pointed field.one at the new name. This change reaches installs in the
  release after it, and the rename waits for that release.

§1 and §10.3 keep the old name, because they record what was true then.
