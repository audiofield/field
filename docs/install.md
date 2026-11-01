# Install and upgrade

You install Field one of two ways: as a release, with no clone, or from
a checkout you build yourself. Either way, one installer, `install.sh`,
does the work: it builds Field, puts `field` on your PATH, builds the
audio daemon `field-audiod`, and keeps any model worker environment you
have set up. `field upgrade` runs the installer again from any
directory, and `field upgrade status` reports what is installed and what
is out of date.

To install the newest release, pipe the installer to bash:

```sh
curl -fsSL https://field.one/install.sh | bash
```

field.one serves `install.sh` from the `v0` tag, so this is the same
installer as
`https://raw.githubusercontent.com/audiofield/field/v0/install.sh`, which
`field upgrade` downloads.

To install a checkout, clone it and run the installer in it:

```sh
git clone https://github.com/audiofield/field
cd field
./install.sh
```

The installer tells the two apart by where it runs. In a git work tree
with Field's source beside it, it installs that checkout. Anywhere else,
piped from curl or downloaded by `field upgrade`, it installs a release.

The installer is bash and does not support Windows yet. A release
install refuses in a Windows shell such as Git Bash, and `field upgrade`
refuses on Windows. On Windows, install from a checkout and run the
steps by hand in it:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm build:ui
pnpm build:native
pnpm add -g .
```

## Before you install

Before it changes anything, the installer checks for every tool the
target needs. When any is missing or too old, it lists them all, prints
the commands that install them, and stops with exit status 69:

```console
$ curl -fsSL https://raw.githubusercontent.com/audiofield/field/v0/install.sh | bash
install.sh: this machine is missing what Field needs to build:

  node-missing       Field needs Node 24 or newer
  pnpm-missing       Field builds with pnpm
  cmake-missing      building field-audiod needs CMake 3.24 or newer

Install what is missing:

  # Homebrew first, from https://brew.sh
  brew install node pnpm cmake

Then open a new shell and run curl -fsSL https://raw.githubusercontent.com/audiofield/field/v0/install.sh | bash again.
```

On macOS the commands use Homebrew. On Linux they use `apt-get` and the
Debian and Ubuntu package names; on another distribution, install the
same packages with its package manager. `all` needs everything below,
`audiod` everything but Node and curl and tar, `cli` Node and pnpm, and
`workers` Node alone.

- **Node 24 or newer.** The version in `.nvmrc`. On Linux, install it
  from [nodejs.org](https://nodejs.org/en/download), because Debian and
  Ubuntu package an older one.
- **pnpm.** On Linux, `corepack enable pnpm` installs the version
  `package.json` names. Node 25 and newer ship without Corepack, so
  where `corepack` is not on your PATH, the installer points at
  [pnpm's installation page](https://pnpm.io/installation) instead.
  For a checkout, also run `pnpm setup` once, then open a new shell, so
  pnpm has a global bin directory on your PATH to link `field` into.
- **CMake 3.24 or newer**, for `field-audiod`. Ubuntu 22.04 and Debian
  11 package an older one, so where `apt-cache` says `apt-get` would
  install one older than 3.24, the installer points at
  [cmake.org](https://cmake.org/download/) instead of the `cmake`
  package.
- **A C++20 compiler, git, and make**, for `field-audiod`, whose build
  clones JUCE with git and runs make, the build tool CMake uses unless
  `CMAKE_GENERATOR` names another. On macOS, Xcode's command line tools
  hold all three, and `xcode-select --install` installs them. The build
  uses the SDK that comes with the toolchain `xcode-select -p` names,
  which its linker can read, even when a macOS update has installed
  newer command line tools beside an older Xcode. Set `SDKROOT` to build
  against another. On Linux, `build-essential` holds the compiler and
  make.
- **The ALSA, X11, and freetype development headers**, on Linux, which
  JUCE builds against. The installer looks for them with `pkg-config`,
  and the packages it names are the ones `.github/workflows/ci.yml`
  installs on Ubuntu.
- **curl and tar**, for a release install, which downloads the release's
  source.

`field build` also needs [SuperCollider](https://supercollider.github.io/),
and `field generate` needs [uv](https://docs.astral.sh/uv/). The
installer installs neither.

## Install a release

A Field release is a version tag, `vX.Y.Z`, and a major tag, `v0`, that
moves to each new release ([release.md](release.md)). Field publishes no
binaries, so the installer builds the release on your machine, the same
way it builds a checkout. It runs these steps, and stops at the first
one that fails:

1. It asks GitHub's git server which commit `v0` names, and reads the
   version from `package.json` at that commit. A file read at `v0`
   itself can be up to five minutes old, because
   `raw.githubusercontent.com` caches it, and would name the release
   before a new one. Without git, or when git cannot reach the
   repository, the installer reads at `v0` instead.
2. It downloads GitHub's source archive of that version's tag, such as
   `v0.2.0`, and unpacks it into `~/.local/share/field/0.2.0/`.
3. It runs `pnpm install --frozen-lockfile`, `pnpm run build`,
   `pnpm run build:ui`, and `pnpm run build:native` in that directory.
4. It sets up again, in the new version, each model worker you had set
   up in the version it replaces.
5. It switches `~/.local/share/field/current` to the new version, writes
   the `field` shim, and removes older versions.

Until step 5, nothing touches the version you have installed, so a
failed download, build, or worker setup leaves it current and working,
and the error says so:

```console
install.sh: 0.3.0 did not install, so 0.2.0 stays current and field still runs it
```

The installer then removes what it built of the version that failed, so
the next run starts that version from its download again.

The first install downloads and compiles JUCE, which takes a few
minutes. Every later version compiles JUCE's modules again, but none
downloads JUCE again: the download stays in
`~/.local/share/field/cache/fetchcontent`, which
`native/audiod/CMakeLists.txt` reads from `FIELD_FETCHCONTENT_BASE_DIR`.
On a Mac, an upgrade took about a minute, against about four minutes
for the first install.

### Where a release install lives

```text
~/.local/share/field/
  0.3.0/                  the installed version, built where it unpacked
  0.2.0/                  the version 0.3.0 replaced, kept so you can switch back
  current -> 0.3.0        the version field runs
  cache/fetchcontent/     JUCE's download, which every version shares
  release.conf            the repository, ref, and bin directory this install follows
~/.local/bin/field        the shim, which runs current/dist/cli.js
```

`XDG_DATA_HOME` moves `~/.local/share`, and `FIELD_DATA_DIR` and
`FIELD_BIN_DIR` name either directory outright. The installer records
the bin directory in `release.conf`, so `field upgrade` rewrites the
same shim.

Give `FIELD_DATA_DIR` a directory of Field's own, because the installer
writes `current`, `release.conf`, and `cache/` there. It removes only
the versions and downloads it can show it installed, and stops before
changing anything when another directory has the name of the version it
is about to install.

The shim is a two-line script that runs
`node ~/.local/share/field/current/dist/cli.js`. Switching `current`
moves `field` to the new version with nothing to relink, and a release
install needs no pnpm global bin directory. It does need
`~/.local/bin` on your PATH. If it is not there, the install ends with a
`not-on-path` row that names the line to add to your shell's profile:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

The installer replaces only its own shim. If `~/.local/bin/field` is
something else, or you cannot write to `~/.local/bin`, it stops before
changing anything.

### Upgrade a release

`field upgrade` downloads the newest installer, `install.sh` at the
commit the ref the install recorded names now, and runs it. When `v0` names a newer version, that
installs it as above. When it names the version you have, nothing
downloads or builds: the installer builds any piece that is missing,
re-syncs your workers, and rewrites the shim.

An install from before Field moved to `audiofield/field` recorded
`okamnesiac/field`. The installer follows `audiofield/field` instead and
records that name. `field` 0.3.5 and older download the installer from the
recorded name themselves, so once GitHub stops redirecting it, their
`field upgrade` fails. To upgrade one of those installs, run the install
command again:

```sh
curl -fsSL https://field.one/install.sh | bash
```

Here is what a normal upgrade prints:

```console
$ field upgrade
+ curl -fsSL https://raw.githubusercontent.com/audiofield/field/6f28530dc4b06a162b38e66c14428754e070a25f/install.sh | bash
release        audiofield/field v0 is at 0.3.0
downloading    https://github.com/audiofield/field/archive/refs/tags/v0.3.0.tar.gz
...
setting-up     field-aced in 0.3.0, as it was in 0.2.0
switched       ~/.local/share/field/current -> 0.3.0
linked         ~/.local/bin/field -> ~/.local/share/field/current
removed        0.1.0
cli            ~/.local/bin/field -> ~/.local/share/field/current
```

The installer keeps the version an upgrade replaced and removes every
older one. To go back to it, switch `current` by hand:

```sh
ln -sfn 0.2.0 ~/.local/share/field/current
```

A kept version runs as it was built. The next `field upgrade` installs
the release `v0` names again.

### Worker environments in a release install

Each version keeps its worker environments in its own
`python/<worker>/.venv`, so an upgrade sets up again, in the new version,
each worker you set up in the old one, before it switches. The model
weights live outside every version, ACE-Step's in
`~/.field/models/acestep` and Chatterbox's in the Hugging Face cache,
and the packages live in uv's cache, so nothing large downloads again.
A worker whose uv is gone is skipped with a `worker-skipped` row that
names the fix, because it could not run in the old version either.

### What each target does in a release install

| Target | What it does |
| --- | --- |
| `all` | Installs the release `v0` names, as above, or, when that version is installed, builds any missing piece, re-syncs its workers, and rewrites the shim. |
| `cli` | Rebuilds the CLI and the UI of the installed version where it is. |
| `audiod` | Rebuilds `field-audiod` and FieldOut of the installed version where it is. |
| `workers` | Runs the installed version's `field setup --existing`. |
| `status` | Reports what is installed, changing nothing. |
| `uninstall` | Removes the install, as [Remove a release install](#remove-a-release-install) describes. `field uninstall` runs it. |

`cli`, `audiod`, and `workers` repair the installed version rather than
move it, as they rebuild a checkout without pulling, so a command the
CLI names, such as `field upgrade audiod`, works in either kind of
install. Each ends by saying whether a newer release is out.

### Follow a fork or another ref

`FIELD_REPO` and `FIELD_REF` choose where a release comes from, and the
installer records both in `release.conf`, so `field upgrade` keeps
following them:

```sh
curl -fsSL https://raw.githubusercontent.com/you/field/main/install.sh | FIELD_REPO=you/field FIELD_REF=main bash
```

The installer reads the version from `package.json` at the commit
`FIELD_REF` names and downloads the archive of that version's tag, so the ref can be a branch,
`v0`, or an exact tag, `vX.Y.Z`, which pins the install to that
release. Each `field upgrade` then repairs that release instead of
moving to a newer one. To follow `v0` again, run
`FIELD_REF=v0 field upgrade`.

The installer refuses a release from before release installs, such as
0.2.0. That version's `field upgrade` runs its own `install.sh` as if
the version were a checkout, and never reads `FIELD_REF`, so an install
pinned to it could not move off it. To run such a version, clone the
repository and check out its tag.

### Remove a release install

```sh
field uninstall
```

If `field` itself no longer runs, use the uninstaller field.one serves,
which runs the newest installer's `uninstall` target:

```sh
curl -fsSL https://field.one/uninstall.sh | bash
```

Either way it removes the shim, every version and download the installer
made, `current`, `release.conf`, and JUCE's download, then the data
directory if nothing else is left in it. It leaves anything it did not
put there, in the data directory or in the bin directory, and says so.

The uninstall removes the shim only when it runs the data directory
being uninstalled. If you installed with `FIELD_DATA_DIR`, set it again
when you uninstall with curl. `field uninstall` finds the directory
itself. Without `FIELD_DATA_DIR`, the curl uninstall looks in the
default data directory, and it keeps a shim that runs another one, with
a `kept` row that names that directory.

The model workers' weights stay. For each worker you set up, the
uninstall prints a `models-kept` row that names the directory its
weights are in:

- **ACE-Step**, for `field-aced`: about 10 GB in
  `~/.field/models/acestep`, or in `FIELD_ACE_MODELS` when you set it.
  Every Field install on the machine uses that directory, checkouts
  included, so delete it only once none of them needs the weights.
- **Chatterbox**, for `field-voiced`: about 2 GB in the Hugging Face
  cache, `~/.cache/huggingface` unless `HF_HOME` or `HF_HUB_CACHE` moves
  it. Other tools share that cache, so remove only
  `hub/models--ResembleAI--chatterbox` from it.

## Install from a checkout

`./install.sh [target]` and `field upgrade [target]` take one target.
With none, they run `all`.

| Target | What it runs |
| --- | --- |
| `cli` | `pnpm install --frozen-lockfile`, then `pnpm run build` and `pnpm run build:ui`, then `pnpm add -g <checkout>` unless pnpm's global `field` already links this checkout. The install covers the `ui/` workspace, the `electron` package included, and `build:ui` builds the client `field ui` serves, which takes about two seconds. |
| `audiod` | `pnpm run build:native`, which builds `field-audiod` and the FieldOut plugin that carries `field keys`' voices into it. The first build fetches and compiles JUCE, which takes a few minutes; later builds compile only what changed. |
| `workers` | `field setup --existing`, which re-syncs each worker environment you set up with `field setup` and sets up no new one. |
| `all` | `cli`, then `audiod`, then `workers`. |
| `status` | Reports what is installed, changing nothing. |
| `uninstall` | `pnpm remove -g field` when pnpm's global `field` links this checkout, as [Remove a checkout install](#remove-a-checkout-install) describes. `field uninstall` runs it. |

Each target except `status` and `uninstall` ends by fetching the
checkout's upstream and warning if the checkout is behind it.

The installer installs the checkout as it is. It never pulls, and it
never switches branches, because the checkout may hold work in progress.
To pick up new commits, pull first:

```sh
git pull                 # in the checkout
field upgrade
```

### The link

`field` is a link to the checkout, not a copy. pnpm's global
`node_modules/field` is a symlink into the checkout, and `pnpm build`
rewrites the `dist/` it points at, so a build takes effect without
relinking. The link also decides which checkout `field upgrade` runs:
`field upgrade` runs the `install.sh` beside the package it was loaded
from.

If pnpm's global `field` links a different checkout, `./install.sh cli`
moves the link to this checkout and prints a `moved` row naming both.
Run it in whichever checkout you want `field` to be.

### Worker environments

Setting up a worker is explicit, because the first `field generate` of
each kind downloads that model's weights: about 10 GB for ACE-Step and
2 GB for Chatterbox. The `workers` target therefore re-syncs only the
environments that are already set up, so an upgrade keeps them current
with the checkout's lockfiles and never starts a download you did not
ask for. A worker counts as set up when its console script is installed
in `python/<worker>/.venv`, which is the same test `field generate`
applies before it starts one.

```console
$ field setup --existing
skipping field-voiced: not set up (field setup voiced)
syncing the field-aced environment (uv)…
```

### Remove a checkout install

`field uninstall`, or `./install.sh uninstall` in the checkout, runs
`pnpm remove -g field` when pnpm's global `field` links this checkout,
and leaves a link to another checkout alone. The checkout stays where it
is, with its builds and worker environments; delete it yourself if you
no longer want it.

```sh
field uninstall
```

## What the installer prints

The installer prints one row for each thing it does, such as
`downloading`, `built`, and `switched`, so an install fits on one
screen. The output of the commands it runs, such as `pnpm install` and
the compiler, goes to a log file in `$TMPDIR` instead. In a terminal,
the command that is running and its last five lines show dimmed below
the rows as they arrive, and disappear when the command finishes. The
window shows each character outside ASCII as `?`, so no line is wider
than the terminal; the log keeps them as they were.

When a command fails, the installer prints the end of that command's
output and where the whole log is, and keeps the log:

```console
install.sh: pnpm --dir ~/.local/share/field/0.3.2 run build:native exited with status 1. The end of its output:

  ...

The whole log is in /var/folders/5d/2spqnw8d17sf5/T/field-install.Xa81Qz
```

When the installer succeeds, it removes the log. To see every line as it
arrives instead, set `FIELD_VERBOSE`:

```sh
FIELD_VERBOSE=1 field upgrade
```

## Read the status

`field upgrade status` prints one row per fact. A row marked ⚠️ needs
you to do something, and it names the command.

```console
$ field upgrade status
+ /Users/you/field/install.sh status
checkout       ~/field (main at f80efb6)
repo-behind    ⚠️  main is 2 commits behind origin/main — run git pull in ~/field, then field upgrade all
node           24.19.0
pnpm           11.15.1
cmake          4.4.0
cli            ~/Library/pnpm/bin/field -> ~/field
cli-current    built from f80efb6
ui-current     ~/field/ui/dist
audiod-stale   ⚠️  native/audiod/src/player.cpp changed since field-audiod was built — run field upgrade audiod
worker-current field-aced
worker-absent  field-voiced is not set up — field setup voiced sets it up
```

| Row | Meaning |
| --- | --- |
| `checkout` | The checkout this installer belongs to, its branch, and its commit. |
| `repo-current`, `repo-ahead`, `repo-behind` | Whether the branch matches its upstream after a fetch, has commits the upstream lacks, or lacks commits the upstream has. A branch that is both ahead and behind reports `repo-behind`. |
| `repo-untracked` | The branch has no upstream, or HEAD is detached, so there is nothing to compare against. |
| `node`, `pnpm`, `cmake` | The versions found. `node-old`, `node-missing`, `pnpm-missing`, `cmake-old`, and `cmake-missing` say what to install. |
| `cli` | pnpm's global `field` links this checkout. |
| `cli-missing`, `cli-elsewhere` | pnpm links no `field`, or links another checkout. Run `./install.sh cli` here to link this one. |
| `cli-shadowed` | Another `field` comes before pnpm's on your PATH, so that one runs. |
| `not-on-path` | pnpm's global bin directory is not on your PATH. Run `pnpm setup`. |
| `cli-current`, `cli-stale`, `cli-unbuilt` | Whether `dist/` was built from the checkout as it stands: the same commit, and the same number of uncommitted changes. `field --version` makes the same comparison. |
| `ui-current`, `ui-stale`, `ui-missing` | Whether `ui/dist` holds a build, and whether any tracked file it may bundle is newer than that build: anything under `ui/` or `src/` other than a test, and `pnpm-lock.yaml`. The UI imports some of `src/`, and the check does not know which files, so an edit to a file it does not import also reads as stale. `field upgrade cli` rebuilds the UI and clears the row. |
| `audiod-current`, `audiod-stale`, `audiod-missing` | Whether `field-audiod` is built, and whether any tracked file under `native/audiod`, `native/ring`, or `native/sc-fieldout`, or `native/macos-sdk.cmake`, which both native builds read, is newer than it. The installer touches `field-audiod` after each build, because CMake relinks it only when its own sources change, so `field upgrade audiod` clears `audiod-stale`. |
| `audiod-override` | `FIELD_AUDIOD` is set, so `field` runs that binary instead of this build. |
| `worker-current`, `worker-stale`, `worker-absent`, `worker-no-uv` | Each worker environment, from `field setup --check`. |

### In a release install

A release install has no checkout to compare, so its status compares
the installed version with the release its ref names, and checks that
each piece of the installed version is built:

```console
$ field upgrade status
+ curl -fsSL https://raw.githubusercontent.com/audiofield/field/6f28530dc4b06a162b38e66c14428754e070a25f/install.sh | bash -s -- status
installed      0.3.0 in ~/.local/share/field/0.3.0
release        audiofield/field v0 is at 0.3.0
release-latest 0.3.0 is installed
previous       0.2.0 in ~/.local/share/field/0.2.0, kept to switch back to by hand
node           24.19.0
pnpm           11.15.1
cmake          4.4.0
cli            ~/.local/bin/field -> ~/.local/share/field/current
ui-current     ~/.local/share/field/0.3.0/ui/dist
audiod-current ~/.local/share/field/0.3.0/native/audiod/build/field-audiod_artefacts/Release/field-audiod
worker-absent  field-aced is not set up — field setup aced sets it up
```

| Row | Meaning |
| --- | --- |
| `installed`, `not-installed` | The version `current` names, or that no release is installed in the data directory. |
| `release` | The repository and ref this install follows, and the version `package.json` names there. |
| `release-latest`, `release-behind`, `release-ahead` | Whether the installed version is that version, older, or newer, as after following a branch and switching back. Run `field upgrade` for `release-behind`. |
| `previous` | A version an upgrade replaced, kept so you can switch `current` back to it. |
| `node`, `pnpm`, `cmake` | As in a checkout. |
| `cli`, `cli-missing` | Whether the shim in the bin directory is the installer's. |
| `cli-shadowed` | Another `field` comes before the shim on your PATH, so that one runs. |
| `not-on-path` | The bin directory is not on your PATH. The row names the line to add to your shell's profile. |
| `cli-unbuilt`, `ui-current`, `ui-missing`, `audiod-current`, `audiod-missing` | Whether the installed version's CLI, UI, and daemon are built. A release never changes in place, so there is no stale row. `field upgrade cli` or `field upgrade audiod` rebuilds a missing piece. |
| `worker-…` | Each worker environment in the installed version, as in a checkout. |

## Environment variables

| Variable | Effect |
| --- | --- |
| `FIELD_OFFLINE=1` | In a checkout, skips the fetch and compares the checkout against the last fetch of its upstream. In a release install, `field upgrade` runs the installed version's own `install.sh` instead of downloading the newest one, `status` compares nothing, and `all` refuses, because it has nothing to download from. |
| `FIELD_REPO`, `FIELD_REF` | The repository and ref a release install follows: `audiofield/field` and `v0` unless set. The installer records both in `release.conf`. |
| `FIELD_VERBOSE=1` | Prints every line the installer's commands print, as it arrives, instead of the dimmed five-line window, and keeps no log. |
| `FIELD_DATA_DIR` | Where release installs live. The default is `$XDG_DATA_HOME/field` when `XDG_DATA_HOME` is an absolute path, and `~/.local/share/field` otherwise. |
| `FIELD_BIN_DIR` | Where the release install's shim goes: `~/.local/bin` unless set. The installer records it in `release.conf`. |
| `GITHUB_TOKEN` | Sent to GitHub's own hosts, and only over HTTPS, so a release install can follow a private fork. The installer passes it in curl's configuration on standard input, never on a command line. `git ls-remote` does not use it: git asks with your own git credentials, and without them the installer reads the private fork at the ref rather than at its commit. |
| `FIELD_RAW_URL`, `FIELD_ARCHIVE_URL` | The bases the installer downloads `package.json`, `install.sh`, and the source archive from: `https://raw.githubusercontent.com` and `https://github.com` unless set. `git ls-remote` asks `<FIELD_ARCHIVE_URL>/<repo>.git` which commit the ref names. Tests point them at local files. |
| `NO_COLOR` | Prints warning rows without color. The ⚠️ marker stays. |
| `FIELD_AUDIOD` | Not read by the installer. `status` reports it, because `field` runs that binary instead of the one the installer builds. |
