#!/usr/bin/env bash
#
# Install Field: the `field` command, the audio daemon field-audiod, and
# the model-worker environments you have already set up.
#
#   curl -fsSL https://field.one/install.sh | bash
#   ./install.sh [all|cli|audiod|workers|status|uninstall]   from a checkout
#   field upgrade [all|cli|audiod|workers|status]            the same, from anywhere
#   field uninstall                                          ./install.sh uninstall, from anywhere
#
# Run from a checkout, it installs that checkout as it is. It never pulls;
# `status` says how far the checkout is behind its upstream instead.
# Without one -- piped from curl, or downloaded by `field upgrade` -- it
# installs a release: the version package.json names at the commit
# FIELD_REF (default v0) names in FIELD_REPO (default audiofield/field),
# from the source archive of that version's tag, built in a directory of
# its own under ~/.local/share/field and run through a shim in
# ~/.local/bin (install.md §3.2).

set -euo pipefail

# The directory holding this script, or nothing when bash reads it from stdin.
SCRIPT_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
fi
# A checkout is this script in a git work tree, with the CLI's source beside
# it. A source archive has the source and no .git, so a release version's
# own copy of this script is a release installer, like the copy
# `field upgrade` downloads and the one bash reads from curl (install.md
# §2.1, amended 2026-10-11). `.git` is a directory in a clone and a file in
# a worktree. pwd -P, so the path compares equal to the realpath of the
# checkout pnpm links.
CHECKOUT=""
if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/src/cli.ts" ] && [ -e "$SCRIPT_DIR/.git" ]; then
  CHECKOUT="$SCRIPT_DIR"
fi
# The tree the build steps run in: the checkout, or the release version
# being built or reported on.
REPO="$CHECKOUT"

NODE_MAJOR=24
# native/audiod/CMakeLists.txt's cmake_minimum_required.
CMAKE_MAJOR=3
CMAKE_MINOR=24
# Where src/audiod/client.ts looks for the daemon, under the package root.
AUDIOD_RELATIVE="native/audiod/build/field-audiod_artefacts/Release/field-audiod"

die() {
  echo "install.sh: $1" >&2
  exit "${2:-1}"
}

row() { printf '%-14s %s\n' "$1" "$2"; }

# A row the reader must not scroll past: a marker always, because a captured
# log has no color, and bold yellow when stdout is a terminal.
warn_row() {
  if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
    printf '\033[1;33m%-14s ⚠️  %s\033[0m\n' "$1" "$2"
  else
    printf '%-14s ⚠️  %s\n' "$1" "$2"
  fi
}

# Build output: install.md §2.8.
STEP_LINES=5
LOG=""

# Standard input is /dev/null: piped from curl, it is the script.
step() {
  local status=0 dir start
  if [ -n "${FIELD_VERBOSE:-}" ]; then
    "$@" </dev/null
    return
  fi
  if [ -z "$LOG" ]; then
    dir="${TMPDIR:-/tmp}"
    LOG="$(mktemp "${dir%/}/field-install.XXXXXX")" || die "could not make a log file in ${dir%/}"
  fi
  start="$(sed -n '$=' "$LOG")"
  printf '$ %s\n' "$*" >>"$LOG"
  if [ -t 1 ] && [ "${TERM:-dumb}" != dumb ]; then
    "$@" </dev/null 2>&1 | step_window "$(step_title "$@")" || status=$?
  else
    "$@" </dev/null >>"$LOG" 2>&1 || status=$?
  fi
  [ "$status" -eq 0 ] || step_failed "$(step_title "$@")" "$status" "$((${start:-0} + 2))"
  return "$status"
}

step_title() {
  local arg title=""
  for arg in "$@"; do title="$title${title:+ }$(tilde "$arg")"; done
  printf '%s' "$title"
}

terminal_width() {
  local size
  size="$(stty size </dev/tty 2>/dev/null)" || size=""
  size="${size##* }"
  case "$size" in "" | 0 | *[!0-9]*) size="${COLUMNS:-80}" ;; esac
  case "$size" in "" | *[!0-9]*) size=80 ;; esac
  [ "$size" -ge 20 ] || size=20
  printf '%s' "$size"
}

# Every line drawn is ASCII without control characters, so its length is
# the columns it takes, and cutting it short of the terminal's width means
# it never wraps: the redraw moves up one row per line. A character that
# may be two columns wide, such as CJK, shows as ?.
step_window() {
  local title="$1" width line drawn=0 n=0 i dim="" plain=""
  local lines=()
  width=$(($(terminal_width) - 5))
  title="${title//[^[:ascii:]]/?}"
  title="${title//[[:cntrl:]]/}"
  [ -n "${NO_COLOR:-}" ] || { dim=$'\033[2m'; plain=$'\033[0m'; }
  while IFS= read -r line || [ -n "$line" ]; do
    printf '%s\n' "$line" >&3
    # A progress bar's last state follows its last carriage return.
    line="${line##*$'\r'}"
    line="${line//$'\t'/  }"
    line="${line//[^[:ascii:]]/?}"
    line="${line//[[:cntrl:]]/}"
    if [ "$n" -lt "$STEP_LINES" ]; then n=$((n + 1)); else lines=("${lines[@]:1}"); fi
    lines[n - 1]="$line"
    [ "$drawn" -eq 0 ] || printf '\033[%dA' "$drawn"
    printf '\r\033[2K%s  $ %s%s\n' "$dim" "${title:0:width}" "$plain"
    for ((i = 0; i < n; i++)); do
      printf '\r\033[2K%s  %s%s\n' "$dim" "${lines[i]:0:width}" "$plain"
    done
    drawn=$((n + 1))
  done 3>>"$LOG"
  [ "$drawn" -eq 0 ] || printf '\033[%dA\r\033[J' "$drawn"
}

# $3 is the line of LOG where the failed step's own output begins.
step_failed() {
  {
    printf 'install.sh: %s exited with status %s. The end of its output:\n\n' "$1" "$2"
    sed -n "$3,\$p" "$LOG" | tail -n 20 | sed 's/^/  /'
    printf '\nThe whole log is in %s\n' "$LOG"
  } >&2
}

commits() {
  if [ "$1" -eq 1 ]; then printf '1 commit'; else printf '%s commits' "$1"; fi
}

# A path for a message, with the home directory as ~.
tilde() {
  case "$1" in
    "$HOME"/*) printf '~%s' "${1#"$HOME"}" ;;
    *) printf '%s' "$1" ;;
  esac
}

# The checkout pnpm's global `field` links, or nothing. pnpm keeps each
# global package in a directory of its own and reports where; that path is a
# symlink into the checkout `pnpm add -g` was given.
linked_checkout() {
  local path
  command -v pnpm >/dev/null 2>&1 && command -v node >/dev/null 2>&1 || return 0
  path="$(pnpm ls -g --json 2>/dev/null | node -e '
let text = "";
process.stdin.on("data", (chunk) => (text += chunk)).on("end", () => {
  try {
    for (const entry of JSON.parse(text)) {
      const field = entry.dependencies && entry.dependencies.field;
      if (field && field.path) console.log(field.path);
    }
  } catch {}
});' 2>/dev/null)" || return 0
  path="${path%%$'\n'*}"
  [ -n "$path" ] && [ -d "$path" ] || return 0
  (CDPATH='' cd -- "$path" && pwd -P)
}

LINKED=""
refresh_linked() { LINKED="$(linked_checkout)"; }

# The command that runs a target again: `field upgrade` when the `field`
# pnpm links is this checkout, because that is the installer it runs, and
# this script's own path otherwise. A release install names `field upgrade`
# once there is one to upgrade, and the download that installs one before.
rerun() {
  if [ -z "$CHECKOUT" ]; then
    if [ -n "$(current_version)" ] && is_release_shim "$BIN_DIR/field"; then
      printf 'field upgrade %s' "$1"
    else
      printf 'curl -fsSL %s | bash' "$RAW_URL/$RELEASE_REPO/$RELEASE_REF/install.sh"
      [ "$1" = all ] || printf ' -s -- %s' "$1"
    fi
  elif [ -n "$LINKED" ] && [ "$LINKED" = "$CHECKOUT" ]; then
    printf 'field upgrade %s' "$1"
  else
    printf '%s/install.sh %s' "$(tilde "$CHECKOUT")" "$1"
  fi
}

# --- What the build needs (install.md "Before you install") ---
#
# One run names everything the machine lacks before anything downloads or
# builds, rather than one tool a run or a failure minutes into the
# daemon's build.

OS="$(uname -s)"
NEEDS=""
BREW=""
APT=""
STEPS=""

# need LABEL WHAT [BREW [APT [STEP]]]: one missing tool and what supplies
# it. BREW is a Homebrew formula, APT the Debian and Ubuntu packages, and
# STEP what to do on this platform when neither applies, a command or a
# line starting with #.
need() {
  NEEDS="$NEEDS$(printf '  %-18s %s' "$1" "$2")"$'\n'
  if [ "$OS" = Darwin ] && [ -n "${3:-}" ]; then
    BREW="$BREW $3"
  elif [ "$OS" != Darwin ] && [ -n "${4:-}" ]; then
    APT="$APT $4"
  elif [ -n "${5:-}" ]; then
    STEPS="$STEPS$5"$'\n'
  fi
}

check_node() {
  local version
  if ! version="$(node --version 2>/dev/null)"; then
    need node-missing "Field needs Node $NODE_MAJOR or newer" node "" "# Node $NODE_MAJOR or newer, from https://nodejs.org/en/download"
    return 0
  fi
  version="${version#v}"
  [ "${version%%.*}" -ge "$NODE_MAJOR" ] 2>/dev/null ||
    need node-old "Field needs Node $NODE_MAJOR or newer, and node is $version" node "" "# Node $NODE_MAJOR or newer, from https://nodejs.org/en/download"
}

# Node 25 and newer ship without corepack, so `corepack enable pnpm` is the
# step only where corepack is on PATH.
check_pnpm() {
  local step="# pnpm, from https://pnpm.io/installation"
  command -v pnpm >/dev/null 2>&1 && return 0
  if command -v corepack >/dev/null 2>&1; then step="corepack enable pnpm"; fi
  need pnpm-missing "Field builds with pnpm" pnpm "" "$step"
}

# The CMake version apt-get would install, or nothing without apt-cache or
# a candidate. LC_ALL=C, because apt-cache translates "Candidate".
apt_cmake() {
  local candidate
  command -v apt-cache >/dev/null 2>&1 || return 0
  candidate="$(LC_ALL=C apt-cache policy cmake 2>/dev/null | sed -n 's/^ *Candidate: *//p')" || return 0
  candidate="${candidate#*:}"
  case "$candidate" in [0-9]*) printf '%s' "${candidate%%-*}" ;; esac
}

# Ubuntu 22.04 packages CMake 3.22 and Debian 11 3.18, so where apt-get
# would install one too old, a missing CMake gets the step an old one does.
check_cmake() {
  local version packaged=""
  if ! version="$(cmake_version)"; then
    [ "$OS" = Darwin ] || packaged="$(apt_cmake)"
    if [ -n "$packaged" ] && ! cmake_new_enough "$packaged"; then
      need cmake-missing "building field-audiod needs CMake $CMAKE_MAJOR.$CMAKE_MINOR or newer, and apt-get would install $packaged" "" "" "# CMake $CMAKE_MAJOR.$CMAKE_MINOR or newer, from https://cmake.org/download/"
    else
      need cmake-missing "building field-audiod needs CMake $CMAKE_MAJOR.$CMAKE_MINOR or newer" cmake cmake
    fi
  elif ! cmake_new_enough "$version"; then
    need cmake-old "building field-audiod needs CMake $CMAKE_MAJOR.$CMAKE_MINOR or newer, and cmake is $version" cmake "" "# CMake $CMAKE_MAJOR.$CMAKE_MINOR or newer, from https://cmake.org/download/"
  fi
}

# On macOS, Xcode's command line tools hold the compiler and git, and
# /usr/bin/c++ and /usr/bin/git are stand-ins that offer to install them,
# so the check asks xcode-select rather than running either.
check_compiler() {
  local dir
  if [ "$OS" = Darwin ]; then
    { dir="$(xcode-select -p 2>/dev/null)" && [ -d "$dir" ]; } ||
      need xcode-missing "building field-audiod needs Xcode's command line tools, which hold the C++ compiler and git" "" "" "xcode-select --install"
    return 0
  fi
  command -v c++ >/dev/null 2>&1 || command -v g++ >/dev/null 2>&1 || command -v clang++ >/dev/null 2>&1 ||
    need compiler-missing "building field-audiod needs a C++20 compiler" "" build-essential
  # build:native names no generator, so CMake takes CMAKE_GENERATOR's, or
  # else Unix Makefiles, which runs make. A compiler installs without it.
  [ -n "${CMAKE_GENERATOR:-}" ] || command -v make >/dev/null 2>&1 ||
    need make-missing "building field-audiod runs make, CMake's default build tool on Linux" "" make
}

# CMake clones JUCE with git. On macOS, check_compiler covers it.
check_git() {
  [ "$OS" = Darwin ] || command -v git >/dev/null 2>&1 ||
    need git-missing "building field-audiod clones JUCE with git" "" git
}

# JUCE's build helper links its GUI module whatever the daemon links, so a
# console daemon still needs these headers on Linux. The packages are the
# ones .github/workflows/ci.yml installs on Ubuntu, and each one installs
# one of the pkg-config modules.
HEADER_MODULES="alsa freetype2 fontconfig x11 xext xrandr xinerama xcursor xcomposite xrender glu"
HEADER_PACKAGES="libasound2-dev libfreetype-dev libfontconfig1-dev libx11-dev libxext-dev libxrandr-dev libxinerama-dev libxcursor-dev libxcomposite-dev libxrender-dev libglu1-mesa-dev"

check_headers() {
  local module absent=""
  [ "$OS" = Linux ] || return 0
  if ! command -v pkg-config >/dev/null 2>&1; then
    need pkg-config-missing "building field-audiod finds JUCE's libraries with pkg-config" "" pkg-config
    need headers-unchecked "without pkg-config, the installer cannot look for the ALSA, X11, and freetype development headers JUCE needs" "" "$HEADER_PACKAGES"
    return 0
  fi
  for module in $HEADER_MODULES; do
    pkg-config --exists "$module" 2>/dev/null || absent="$absent $module"
  done
  [ -z "$absent" ] ||
    need headers-missing "JUCE needs the ALSA, X11, and freetype development headers, and pkg-config finds no$absent" "" "$HEADER_PACKAGES"
}

check_fetch() {
  command -v curl >/dev/null 2>&1 || need curl-missing "installing a release downloads it with curl" curl curl
  command -v tar >/dev/null 2>&1 || need tar-missing "installing a release unpacks it with tar" "" tar "# tar"
}

require_tools() {
  local check
  for check in "$@"; do "check_$check"; done
  [ -n "$NEEDS" ] || return 0
  {
    echo "install.sh: this machine is missing what Field needs to build:"
    echo
    printf '%s' "$NEEDS"
    echo
    echo "Install what is missing:"
    echo
    if [ "$OS" = Darwin ]; then
      printf '%s' "$STEPS" | sed 's/^/  /'
      if [ -n "$BREW" ]; then
        command -v brew >/dev/null 2>&1 || echo "  # Homebrew first, from https://brew.sh"
        echo "  brew install$BREW"
      fi
    else
      if [ -n "$APT" ]; then
        command -v apt-get >/dev/null 2>&1 ||
          echo "  # These are the Debian and Ubuntu packages; install the same with your distribution's package manager"
        echo "  sudo apt-get install -y$APT"
      fi
      printf '%s' "$STEPS" | sed 's/^/  /'
    fi
    echo
    echo "Then open a new shell and run $(rerun "$TARGET") again."
  } >&2
  exit 69
}

# pnpm refuses to link into a global bin directory that is not on PATH, so
# the installer checks first and its message names the command to run again.
GLOBAL_BIN=""
require_global_bin() {
  GLOBAL_BIN="$(pnpm bin -g 2>/dev/null)" ||
    die "pnpm has no global bin directory — run pnpm setup, open a new shell, and run $(rerun "$TARGET") again" 69
  if [ "$LINKED" != "$REPO" ]; then
    case ":$PATH:" in
      *":$GLOBAL_BIN:"*) ;;
      *) die "pnpm's global bin directory $GLOBAL_BIN is not on PATH — run pnpm setup, open a new shell, and run $(rerun "$TARGET") again" 69 ;;
    esac
  fi
}

cmake_version() { cmake --version 2>/dev/null | sed -n '1s/.* //p'; }

cmake_new_enough() {
  local major="${1%%.*}" minor="${1#*.}"
  minor="${minor%%.*}"
  [ "$major" -gt "$CMAKE_MAJOR" ] 2>/dev/null ||
    { [ "$major" -eq "$CMAKE_MAJOR" ] && [ "$minor" -ge "$CMAKE_MINOR" ]; } 2>/dev/null
}

install_cli() {
  build_cli
  link_cli
}

# The same steps for a checkout and for a release version, in whichever
# tree REPO names.
build_cli() {
  # --frozen-lockfile, because an installer has no business rewriting the
  # checkout's lockfile; a checkout whose package.json moved ahead of it
  # gets pnpm's own error saying so.
  step pnpm --dir "$REPO" install --frozen-lockfile
  # `pnpm install` builds the CLI through `prepare` only when it installed
  # something, so both builds run here, every time: a checkout edited
  # without a commit is as stale as one that moved. The UI builds with the
  # CLI because it bundles code from src/.
  step pnpm --dir "$REPO" run build
  step pnpm --dir "$REPO" run build:ui
}

# pnpm links the checkout rather than copying it, so a later build takes
# effect with no relinking. A link that already points here is left alone,
# and one that points at another checkout moves, with a row saying so.
link_cli() {
  local found
  if [ "$LINKED" != "$REPO" ]; then
    step pnpm add -g "$REPO"
    [ -z "$LINKED" ] || row moved "field $(tilde "$LINKED") -> $(tilde "$REPO")"
    refresh_linked
  fi
  row linked "$(tilde "$GLOBAL_BIN/field") -> $(tilde "$REPO")"
  hash -r
  found="$(command -v field 2>/dev/null)" || found=""
  if [ -n "$found" ] && [ "$found" != "$GLOBAL_BIN/field" ]; then
    warn_row cli-shadowed "field on PATH is $(describe_field "$found"), ahead of pnpm's $(tilde "$GLOBAL_BIN/field")"
  fi
}

# A `field` found on PATH, for a cli-shadowed row: its path, and what it is
# when it is a release install's shim, which is the other `field` a machine
# with a checkout is likely to have.
describe_field() {
  if is_release_shim "$1"; then
    printf "%s, a release install's shim" "$(tilde "$1")"
  else
    tilde "$1"
  fi
}

# A release install builds each version in a directory of its own, and
# FIELD_FETCHCONTENT_BASE_DIR, which native/audiod/CMakeLists.txt reads,
# keeps JUCE's download outside all of them, so only the first version
# downloads it (install.md §3.2).
install_audiod() {
  [ -x "$REPO/$AUDIOD_RELATIVE" ] || row building "field-audiod, takes a while"
  if ! step pnpm --dir "$REPO" run build:native; then
    [ "$(uname -s)" != Linux ] ||
      echo "install.sh: on Linux, JUCE needs the ALSA, X11, and freetype development headers; .github/workflows/ci.yml installs the packages it needs on Ubuntu" >&2
    exit 1
  fi
  # CMake relinks field-audiod only when its own inputs change, and this
  # project builds other targets too. Dating the binary to this build lets
  # audiod-stale clear once the build it asks for has run.
  touch -c "$REPO/$AUDIOD_RELATIVE"
  row built "$(tilde "$REPO/$AUDIOD_RELATIVE")"
}

# Re-syncs the worker environments already set up and sets up no new one,
# because setting one up is explicit (ace-generation.md §3.4): the first
# generate after it downloads gigabytes of weights. The CLI decides which
# are set up, since it owns the list of workers.
install_workers() {
  [ -f "$REPO/dist/cli.js" ] ||
    die "the field CLI sets up worker environments, and it is not built — run $(rerun cli) first" 69
  step node "$REPO/dist/cli.js" setup --existing
}

report_checkout_row() {
  local branch head
  head="$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null)" || {
    row checkout "$(tilde "$REPO") (not a git checkout)"
    return 0
  }
  if branch="$(git -C "$REPO" symbolic-ref --quiet --short HEAD 2>/dev/null)"; then
    row checkout "$(tilde "$REPO") ($branch at $head)"
  else
    row checkout "$(tilde "$REPO") (detached at $head)"
  fi
}

# A checkout nobody pulled installs an old field, and nothing else says so.
# Fetch the checkout's upstream and say how far behind it is. FIELD_OFFLINE=1
# skips the fetch and compares against the last one. The fetch gives up
# after fifteen seconds of a stalled HTTP transfer, so a bad network delays
# the row rather than hanging the installer on it.
report_checkout() {
  local branch upstream remote behind ahead note=""
  git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1 || return 0
  if ! branch="$(git -C "$REPO" symbolic-ref --quiet --short HEAD 2>/dev/null)"; then
    row repo-untracked "detached HEAD has no upstream to compare against"
    return 0
  fi
  if ! upstream="$(git -C "$REPO" rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null)"; then
    row repo-untracked "$branch has no upstream to compare against"
    return 0
  fi
  remote="${upstream%%/*}"
  if [ -n "${FIELD_OFFLINE:-}" ]; then
    note=" (offline; compared against the last fetch of $remote)"
  elif ! GIT_TERMINAL_PROMPT=0 git -C "$REPO" -c http.lowSpeedLimit=1 -c http.lowSpeedTime=15 \
      fetch --quiet "$remote" 2>/dev/null; then
    note=" (could not fetch $remote; compared against its last fetch)"
  fi
  if ! behind="$(git -C "$REPO" rev-list --count "HEAD..$upstream" 2>/dev/null)"; then
    row repo-untracked "$branch tracks $upstream, which no longer exists$note"
    return 0
  fi
  ahead="$(git -C "$REPO" rev-list --count "$upstream..HEAD" 2>/dev/null)" || ahead=0
  if [ "$behind" -gt 0 ]; then
    warn_row repo-behind "$branch is $(commits "$behind") behind $upstream — run git pull in $(tilde "$REPO"), then $(rerun all)$note"
  elif [ "$ahead" -gt 0 ]; then
    row repo-ahead "$branch is $(commits "$ahead") ahead of $upstream$note"
  else
    row repo-current "$branch matches $upstream$note"
  fi
}

report_tools() {
  local version
  if version="$(node --version 2>/dev/null)"; then
    version="${version#v}"
    if [ "${version%%.*}" -ge "$NODE_MAJOR" ] 2>/dev/null; then
      row node "$version"
    else
      warn_row node-old "$version — Field needs Node $NODE_MAJOR or newer"
    fi
  else
    warn_row node-missing "Field needs Node $NODE_MAJOR or newer"
  fi
  if version="$(pnpm --version 2>/dev/null)"; then
    row pnpm "$version"
  else
    warn_row pnpm-missing "run corepack enable pnpm, or see https://pnpm.io/installation"
  fi
  if ! version="$(cmake_version)"; then
    row cmake-missing "needed to build field-audiod — brew install cmake on macOS"
  elif cmake_new_enough "$version"; then
    row cmake "$version"
  else
    row cmake-old "$version — building field-audiod needs CMake $CMAKE_MAJOR.$CMAKE_MINOR or newer"
  fi
}

report_cli() {
  local bin found
  bin="$(pnpm bin -g 2>/dev/null)" || bin=""
  found="$(command -v field 2>/dev/null)" || found=""
  if [ -z "$LINKED" ]; then
    warn_row cli-missing "pnpm links no field — run $(rerun cli)"
  elif [ "$LINKED" != "$REPO" ]; then
    warn_row cli-elsewhere "field links $(tilde "$LINKED"), not this checkout — run $(rerun cli) to link this one"
  else
    row cli "$(tilde "$bin/field") -> $(tilde "$REPO")"
  fi
  if [ -n "$found" ] && [ "$found" != "$bin/field" ]; then
    warn_row cli-shadowed "field on PATH is $(describe_field "$found"), ahead of pnpm's $(tilde "$bin/field")"
  elif [ -z "$found" ] && [ -n "$LINKED" ]; then
    warn_row not-on-path "pnpm's global bin directory $(tilde "$bin") is not on PATH — run pnpm setup"
  fi
  report_build
}

# Whether dist/ is the checkout as it stands. `pnpm build` stamps the commit
# it built and the number of uncommitted changes it saw
# (scripts/stamp-build.mjs), and `field --version` makes the same comparison.
report_build() {
  local info built built_dirty head dirty
  info="$REPO/dist/build-info.json"
  if [ ! -f "$info" ]; then
    warn_row cli-unbuilt "dist/ holds no build — run $(rerun cli)"
    return 0
  fi
  read -r built built_dirty < <(INFO="$info" node -e '
const info = JSON.parse(require("fs").readFileSync(process.env.INFO, "utf8"));
console.log(`${info.commit ?? "-"} ${info.dirtyFiles ?? 0}`);' 2>/dev/null) || true
  head="$(git -C "$REPO" rev-parse HEAD 2>/dev/null)" || head=""
  if [ -z "${built:-}" ] || [ "$built" = "-" ] || [ -z "$head" ]; then
    row cli-built "dist/ has a build, and no commit to compare it against"
    return 0
  fi
  if [ "$built" != "$head" ]; then
    warn_row cli-stale "dist/ was built from ${built:0:7}, and the checkout is at ${head:0:7} — run $(rerun cli)"
    return 0
  fi
  dirty="$(git -C "$REPO" status --porcelain 2>/dev/null | grep -c . || true)"
  if [ "${dirty:-0}" -ne "${built_dirty:-0}" ]; then
    warn_row cli-stale "dist/ was built with $built_dirty uncommitted changes, and the checkout has $dirty — run $(rerun cli)"
    return 0
  fi
  row cli-current "built from ${head:0:7}"
}

# The first tracked file under the given paths that is newer than the
# build output $1, leaving out tests, which no build reads.
newer_than() {
  local built="$1" file
  shift
  while IFS= read -r -d '' file; do
    case "$file" in *.test.*) continue ;; esac
    if [ "$REPO/$file" -nt "$built" ]; then
      printf '%s\n' "$file"
      return 0
    fi
  done < <(git -C "$REPO" ls-files -z -- "$@" 2>/dev/null)
  return 1
}

# Vite rewrites ui/dist/index.html on every build. The UI bundles its own
# sources, code it imports from src/, and the packages pnpm-lock.yaml
# pins. Which files under src/ it imports is the bundler's to know, so
# the comparison takes them all.
report_ui() {
  local index="$REPO/ui/dist/index.html" changed
  if [ ! -f "$index" ]; then
    warn_row ui-missing "ui/dist holds no build, so field ui cannot open — run $(rerun cli)"
  elif changed="$(newer_than "$index" ui src pnpm-lock.yaml)"; then
    warn_row ui-stale "$changed changed since the UI was built — run $(rerun cli)"
  else
    row ui-current "$(tilde "$REPO/ui/dist")"
  fi
}

# install_audiod touches the binary after each build, so a source newer
# than it changed since the installer last built the daemon. The same
# build compiles the ring header the daemon includes and the FieldOut
# plugin, so their sources count too.
report_audiod() {
  local binary="$REPO/$AUDIOD_RELATIVE" changed
  [ -z "${FIELD_AUDIOD:-}" ] ||
    row audiod-override "FIELD_AUDIOD is set, so field runs $(tilde "$FIELD_AUDIOD") instead of this build"
  if [ ! -x "$binary" ]; then
    warn_row audiod-missing "field-audiod is not built — run $(rerun audiod)"
  elif changed="$(newer_than "$binary" native/audiod native/ring native/sc-fieldout native/macos-sdk.cmake)"; then
    warn_row audiod-stale "$changed changed since field-audiod was built — run $(rerun audiod)"
  else
    row audiod-current "$(tilde "$binary")"
  fi
}

# `field setup --check` prints one row per worker in this format. A worker
# that is set up and out of date, or set up with uv gone, is a warning.
report_workers() {
  local label rest
  if [ ! -f "$REPO/dist/cli.js" ] || ! command -v node >/dev/null 2>&1; then
    row workers "unknown until the CLI is built"
    return 0
  fi
  while read -r label rest; do
    case "$label" in
      worker-stale|worker-no-uv) warn_row "$label" "$rest" ;;
      *) row "$label" "$rest" ;;
    esac
  done < <(node "$REPO/dist/cli.js" setup --check 2>&1 || true)
}

show_status() {
  report_checkout_row
  report_checkout
  report_tools
  report_cli
  report_ui
  report_audiod
  report_workers
}

# --- Release installs (install.md §3.2) ---
#
# ~/.local/share/field/        DATA_DIR: FIELD_DATA_DIR, or under XDG_DATA_HOME
#   0.3.0/                     one built source tree per version
#   0.2.0/                     the version it replaced, kept to switch back to
#   current -> 0.3.0           the version `field` runs, switched last
#   cache/fetchcontent/        JUCE's download, shared by every version
#   release.conf               the repository, ref, and bin directory followed
# ~/.local/bin/field           BIN_DIR: the shim, which runs current

DEFAULT_REPO=audiofield/field
DEFAULT_REF=v0
# Field's repository before it moved to DEFAULT_REPO. GitHub's redirect from
# the old name ends when another repository takes it, so an install that
# recorded it follows DEFAULT_REPO (install.md §11).
MOVED_REPO=okamnesiac/field
RAW_URL="${FIELD_RAW_URL:-https://raw.githubusercontent.com}"
ARCHIVE_URL="${FIELD_ARCHIVE_URL:-https://github.com}"
SHIM_MARKER="# Field's release shim, written by install.sh."
# The versions this installer installs, and so the only directory names
# in the data directory it lists or removes as versions.
VERSION_PATTERN='^[0-9]+\.[0-9]+\.[0-9]+$'
DATA_DIR=""
RECORD=""
RELEASE_REPO=""
RELEASE_REF=""
BIN_DIR=""
FETCH_CACHE=""
INSTALLING=""
REPLACING=""

# What release.conf records for a key, or nothing.
recorded() {
  local value=""
  [ ! -f "$RECORD" ] || value="$(sed -n "s/^$1=//p" "$RECORD")"
  printf '%s' "${value%%$'\n'*}"
}

# Where release installs live, and what they follow. FIELD_DATA_DIR names
# the directory; without it, a version's own copy of this script, in a
# directory named X.Y.Z with a `current` link beside it, finds the
# directory it was unpacked into, and anything else uses the XDG data
# directory. A `current` link beside any other directory, such as the
# field-0.2.0 GitHub's archive unpacks to, is another program's.
# FIELD_REPO, FIELD_REF, and FIELD_BIN_DIR come ahead of what
# release.conf recorded, which comes ahead of the defaults, so an install
# from a fork keeps upgrading from that fork.
release_init() {
  if [ -n "${FIELD_DATA_DIR:-}" ]; then
    DATA_DIR="$FIELD_DATA_DIR"
  elif [ -n "$SCRIPT_DIR" ] && is_version "${SCRIPT_DIR##*/}" && [ -L "$(dirname -- "$SCRIPT_DIR")/current" ]; then
    DATA_DIR="$(dirname -- "$SCRIPT_DIR")"
  else
    case "${XDG_DATA_HOME:-}" in
      /*) DATA_DIR="$XDG_DATA_HOME/field" ;;
      *) DATA_DIR="$HOME/.local/share/field" ;;
    esac
  fi
  case "$DATA_DIR" in /*) ;; *) DATA_DIR="$PWD/$DATA_DIR" ;; esac
  DATA_DIR="${DATA_DIR%/}"
  RECORD="$DATA_DIR/release.conf"
  FETCH_CACHE="$DATA_DIR/cache/fetchcontent"
  RELEASE_REPO="$(recorded repo)"
  [ "$RELEASE_REPO" != "$MOVED_REPO" ] || RELEASE_REPO="$DEFAULT_REPO"
  RELEASE_REPO="${FIELD_REPO:-${RELEASE_REPO:-$DEFAULT_REPO}}"
  RELEASE_REF="${FIELD_REF:-$(recorded ref)}"
  RELEASE_REF="${RELEASE_REF:-$DEFAULT_REF}"
  BIN_DIR="${FIELD_BIN_DIR:-$(recorded bin)}"
  BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"
  case "$BIN_DIR" in /*) ;; *) BIN_DIR="$PWD/$BIN_DIR" ;; esac
  BIN_DIR="${BIN_DIR%/}"
  # Both go into URLs, so each is held to the characters GitHub allows.
  case "$RELEASE_REPO" in
    *[!A-Za-z0-9._/-]* | *..* | /* | */ | */*/*) die "FIELD_REPO is owner/repository, and is $RELEASE_REPO" 64 ;;
    */*) ;;
    *) die "FIELD_REPO is owner/repository, and is $RELEASE_REPO" 64 ;;
  esac
  case "$RELEASE_REF" in
    "" | *[!A-Za-z0-9._/-]* | *..* | /* | */) die "FIELD_REF is a tag or branch name, and is $RELEASE_REF" 64 ;;
  esac
}

# curl, sending GITHUB_TOKEN to GitHub's hosts when it is set, which
# matters only for a private fork. The token travels in curl's config on
# stdin rather than on its command line, where any process on the machine
# could read it, and never to a host FIELD_RAW_URL or FIELD_ARCHIVE_URL
# names.
fetch() {
  local url="$1"
  shift
  case "$url" in
    https://github.com/* | https://raw.githubusercontent.com/* | https://api.github.com/* | https://codeload.github.com/*)
      if [ -n "${GITHUB_TOKEN:-}" ]; then
        printf 'header = "Authorization: Bearer %s"\n' "$GITHUB_TOKEN" |
          curl -fsSL --retry 2 --config - "$@" "$url"
        return
      fi
      ;;
  esac
  curl -fsSL --retry 2 "$@" "$url"
}

# What to try when GitHub will not answer: a private fork answers 404
# without a token.
token_hint() {
  [ -n "${GITHUB_TOKEN:-}" ] || printf ' — for a private repository, set GITHUB_TOKEN'
}

# The "version" field of a package.json, read with sed, as Projector's
# installer reads its manifest, so nothing runs that the download wrote.
package_version() {
  local version
  version="$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
  printf '%s' "${version%%$'\n'*}"
}

# The commit FIELD_REF names, asked of the repository's git server, which
# answers from the repository itself. raw.githubusercontent.com caches a
# file at a tag or branch for up to five minutes, so package.json read at
# v0 just after a release can name the release before it; a file read at
# a commit never changes. A tag wins over a branch of the same name, and
# an annotated tag gives the commit it points at. Nothing when git is
# missing or cannot answer, as for a private fork it has no credentials
# for, and the version is read at the ref as before.
ref_commit() {
  local refs name commit ref
  command -v git >/dev/null 2>&1 || return 0
  refs="$(GIT_TERMINAL_PROMPT=0 git ls-remote "$ARCHIVE_URL/$RELEASE_REPO.git" \
    "refs/tags/$RELEASE_REF^{}" "refs/tags/$RELEASE_REF" "refs/heads/$RELEASE_REF" 2>/dev/null)" || return 0
  for name in "refs/tags/$RELEASE_REF^{}" "refs/tags/$RELEASE_REF" "refs/heads/$RELEASE_REF"; do
    while IFS=$'\t' read -r commit ref; do
      [ "$ref" = "$name" ] && [ "${#commit}" -ge 40 ] || continue
      case "$commit" in *[!0-9a-f]*) continue ;; esac
      printf '%s' "$commit"
      return 0
    done <<<"$refs"
  done
}

# The version FIELD_REF names, from package.json at the commit it names,
# which is how Projector's installer learns the version it installs. The
# version becomes a directory name, so anything but X.Y.Z is refused.
release_version() {
  local text version at
  at="$(ref_commit)"
  text="$(fetch "$RAW_URL/$RELEASE_REPO/${at:-$RELEASE_REF}/package.json")" || return 1
  version="$(printf '%s\n' "$text" | package_version)"
  if ! is_version "$version"; then
    echo "install.sh: $RELEASE_REPO at $RELEASE_REF names version '$version', which is not X.Y.Z" >&2
    return 1
  fi
  printf '%s\n' "$version"
}

# The version `current` names, or nothing when there is none.
current_version() {
  local target
  target="$(readlink "$DATA_DIR/current" 2>/dev/null)" || return 0
  target="${target%/}"
  target="${target##*/}"
  if [ -n "$target" ] && [ -d "$DATA_DIR/$target" ]; then printf '%s\n' "$target"; fi
}

is_version() { [[ $1 =~ $VERSION_PATTERN ]]; }

# FIELD_DATA_DIR can name a directory that holds other things, so the
# installer lists, replaces, and removes only what it can show it made: a
# version, named X.Y.Z, whose install.sh carries the marker download_release
# requires of every version, and the download it unpacks a version in.
is_field_version() {
  is_version "${1##*/}" && [ -d "$1" ] && [ ! -L "$1" ] && grep -qF "$SHIM_MARKER" "$1/install.sh" 2>/dev/null
}

is_field_download() {
  local name="${1##*/}"
  case "$name" in .download-*) ;; *) return 1 ;; esac
  is_version "${name#.download-}" && [ -d "$1/unpacked" ] && [ ! -L "$1" ]
}

# The versions installed beside current, which prune has kept.
kept_versions() {
  local entry name current="$1"
  for entry in "$DATA_DIR"/*; do
    name="${entry##*/}"
    [ "$name" != "$current" ] && is_field_version "$entry" || continue
    printf '%s\n' "$name"
  done
}

# True when dotted version $1 is older than $2, by each number in turn.
version_older() {
  local a="$1" b="$2" x y
  while [ -n "$a" ] || [ -n "$b" ]; do
    x="${a%%.*}"
    y="${b%%.*}"
    [ "${x:-0}" -ge "${y:-0}" ] || return 0
    [ "${x:-0}" -le "${y:-0}" ] || return 1
    case "$a" in *.*) a="${a#*.}" ;; *) a="" ;; esac
    case "$b" in *.*) b="${b#*.}" ;; *) b="" ;; esac
  done
  return 1
}

is_release_shim() { [ -f "$1" ] && grep -qF "$SHIM_MARKER" "$1" 2>/dev/null; }

# The data directory a release shim runs: the path write_shim quoted on its
# exec line, less /current/dist/cli.js, or nothing when the line is not in
# that shape.
shim_data_dir() {
  local path quote="'\\''" tick="'" tail="/current/dist/cli.js' \"\$@\""
  path="$(sed -n 's/^exec node //p' "$1")"
  path="${path%%$'\n'*}"
  case "$path" in "$tick"*"$tail") ;; *) return 0 ;; esac
  path="${path#"$tick"}"
  path="${path%"$tail"}"
  printf '%s' "${path//"$quote"/$tick}"
}

# True when the shim runs this data directory's current. `field uninstall`
# names the data directory by its real path, and the shim by the path it
# was installed through, so the two compare as files when they differ.
shim_runs_here() {
  local dir
  is_release_shim "$1" || return 1
  dir="$(shim_data_dir "$1")"
  [ -n "$dir" ] && { [ "$dir" = "$DATA_DIR" ] || [ "$dir" -ef "$DATA_DIR" ]; }
}

# The shim replaces only itself: a `field` someone else put in the bin
# directory stops the installer before anything changes. So does a bin
# directory it cannot write, because the shim is written after the switch.
require_shim_free() {
  local shim="$BIN_DIR/field" dir="$BIN_DIR"
  if [ -e "$shim" ] || [ -L "$shim" ]; then
    is_release_shim "$shim" ||
      die "$(tilde "$shim") exists and is not Field's release shim — move it aside, or set FIELD_BIN_DIR to install the shim somewhere else" 69
  fi
  while [ ! -d "$dir" ]; do dir="$(dirname -- "$dir")"; done
  [ -w "$dir" ] ||
    die "the shim goes in $(tilde "$BIN_DIR"), and you cannot write to $(tilde "$dir") — set FIELD_BIN_DIR to a directory you can write" 69
}

# download_release replaces the version's directory and its download, so
# either one that the installer did not make stops it before anything
# changes.
require_version_free() {
  local path
  for path in "$DATA_DIR/$1" "$DATA_DIR/.download-$1"; do
    if [ -e "$path" ] || [ -L "$path" ]; then
      is_field_version "$path" || is_field_download "$path" ||
        die "$(tilde "$path") is in the way, and it is not a version Field installed — move it aside, or set FIELD_DATA_DIR to a directory of Field's own" 69
    fi
  done
}

require_installed() {
  [ -n "$(current_version)" ] ||
    die "no release of Field is installed in $(tilde "$DATA_DIR") — run $(rerun all)" 69
  REPO="$DATA_DIR/$(current_version)"
}

# GitHub's source archive of the version's immutable tag, unpacked into
# DATA_DIR/<version>. GitHub names the archive's one top-level directory
# <repository>-<version>, and its API names it <owner>-<repository>-<sha>,
# so whichever single directory is there is the source. It unpacks beside
# the versions and moves into place whole, so a version directory never
# holds half an archive.
download_release() {
  local version="$1" url staging entry top="" count=0
  url="$ARCHIVE_URL/$RELEASE_REPO/archive/refs/tags/v$version.tar.gz"
  staging="$DATA_DIR/.download-$version"
  rm -rf "$staging" "${DATA_DIR:?}/$version"
  mkdir -p "$staging/unpacked"
  row downloading "$url"
  fetch "$url" -o "$staging/source.tar.gz" || die "could not download $url$(token_hint)"
  tar -xzf "$staging/source.tar.gz" -C "$staging/unpacked" || die "could not unpack $url"
  for entry in "$staging/unpacked"/* "$staging/unpacked"/.[!.]*; do
    [ -e "$entry" ] || continue
    count=$((count + 1))
    top="$entry"
  done
  if [ "$count" -ne 1 ] || [ ! -f "$top/package.json" ] || [ ! -f "$top/install.sh" ]; then
    die "$url does not hold a single directory of Field's source"
  fi
  [ "$(package_version < "$top/package.json")" = "$version" ] ||
    die "$url holds version $(package_version < "$top/package.json"), not $version"
  # A version from before release installs has a `field upgrade` that runs
  # its own install.sh as a checkout's, never reads FIELD_REF, and so could
  # never move off it. Its installer writes no shim.
  grep -qF "$SHIM_MARKER" "$top/install.sh" ||
    die "$version predates release installs, so its field upgrade could not upgrade it — install a newer release, or clone the repository and check out v$version"
  mv "$top" "$DATA_DIR/$version"
  rm -rf "$staging"
}

# The workers set up in a version, by the names `field setup` takes: each
# row of that version's `field setup --check` but worker-absent, from the
# version's own CLI, which owns the list of workers (install.md §2.4).
workers_set_up_in() {
  local label name rest
  [ -f "$1/dist/cli.js" ] || return 0
  { node "$1/dist/cli.js" setup --check 2>/dev/null </dev/null || true; } |
    while read -r label name rest; do
      case "$label" in worker-current | worker-stale | worker-no-uv) printf '%s %s\n' "$label" "$name" ;; esac
    done
}

# A worker's environment lives in python/<worker>/.venv inside the version,
# so each worker set up in the version being replaced is set up again in
# the new one, with the new one's CLI, before the switch (install.md §7.5).
# Its weights are outside the version, where ace_models and
# huggingface_cache say, and its packages in uv's cache, so nothing large
# downloads again. One whose uv is gone could not run in the old version
# either, so it is skipped with a row rather than failing the upgrade.
setup_workers_again() {
  local old="$1" list label name
  list="$(workers_set_up_in "$DATA_DIR/$old")"
  [ -n "$list" ] || return 0
  while read -r label name; do
    [ -n "$name" ] || continue
    if [ "$label" = worker-no-uv ]; then
      warn_row worker-skipped "$name was set up in $old, and uv is not installed, so $INSTALLING does not set it up — brew install uv, then field setup $name"
      continue
    fi
    row setting-up "$name in $INSTALLING, as it was in $old"
    step node "$REPO/dist/cli.js" setup "$name"
  done <<EOF
$list
EOF
}

# rename(2) swaps the link in one step: `ln -sfn` removes the old one first,
# and `mv` would move the new link into the directory the old one names.
switch_to() {
  rm -f "$DATA_DIR/.current.new"
  ln -s "$1" "$DATA_DIR/.current.new"
  node -e 'require("fs").renameSync(process.argv[1], process.argv[2])' "$DATA_DIR/.current.new" "$DATA_DIR/current"
  row switched "$(tilde "$DATA_DIR/current") -> $1"
}

# A path as a single-quoted word for the shim.
shell_quote() {
  local quote="'\\''"
  printf "'%s'" "${1//\'/$quote}"
}

# The shim runs whatever `current` names, so a switch moves `field` with no
# relinking, and it needs no pnpm global bin directory on PATH.
write_shim() {
  local shim="$BIN_DIR/field"
  mkdir -p "$BIN_DIR"
  {
    printf '#!/bin/sh\n'
    printf '%s It runs the version that\n' "$SHIM_MARKER"
    printf '# %s names, so an upgrade moves it (docs/install.md).\n' "$(tilde "$DATA_DIR/current")"
    printf 'exec node %s "$@"\n' "$(shell_quote "$DATA_DIR/current/dist/cli.js")"
  } >"$shim.new"
  chmod 755 "$shim.new"
  mv -f "$shim.new" "$shim"
  row linked "$(tilde "$shim") -> $(tilde "$DATA_DIR/current")"
}

write_record() {
  printf 'repo=%s\nref=%s\nbin=%s\n' "$RELEASE_REPO" "$RELEASE_REF" "$BIN_DIR" >"$RECORD.new"
  mv -f "$RECORD.new" "$RECORD"
}

# Keeps the version just installed and the one it replaced, so a broken
# release can be switched back from by hand, and removes every other
# version and any download a killed run left behind.
prune() {
  local entry name
  for entry in "$DATA_DIR"/* "$DATA_DIR"/.download-*; do
    name="${entry##*/}"
    case "$name" in "$1" | "${2:-$1}") continue ;; esac
    if is_field_download "$entry"; then
      rm -rf "$entry"
    elif is_field_version "$entry"; then
      rm -rf "$entry"
      row removed "$name"
    fi
  done
}

# Where to add the bin directory, for the shell this is likely to be.
profile_hint() {
  case "${SHELL:-}" in
    */zsh) printf '~/.zshrc' ;;
    */bash) if [ "$(uname -s)" = Darwin ]; then printf '~/.bash_profile'; else printf '~/.bashrc'; fi ;;
    *) printf "your shell's profile" ;;
  esac
}

# The shim works from anywhere once its directory is on PATH. Nothing
# refuses to install it when the directory is not, as pnpm refuses to
# link, so this is a row after the install rather than a stop before it.
report_shim() {
  local shim="$BIN_DIR/field" found entry
  hash -r
  found="$(command -v field 2>/dev/null)" || found=""
  if is_release_shim "$shim"; then
    row cli "$(tilde "$shim") -> $(tilde "$DATA_DIR/current")"
  else
    warn_row cli-missing "no field shim in $(tilde "$BIN_DIR") — run $(rerun all)"
  fi
  case ":$PATH:" in
    *":$BIN_DIR:"*)
      if [ -n "$found" ] && [ "$found" != "$shim" ]; then
        warn_row cli-shadowed "field on PATH is $(tilde "$found"), ahead of the release's $(tilde "$shim")"
      fi
      ;;
    *)
      entry="$BIN_DIR"
      case "$entry" in "$HOME"/*) entry="\$HOME${entry#"$HOME"}" ;; esac
      warn_row not-on-path "$(tilde "$BIN_DIR") is not on PATH, so your shell does not find the shim — add export PATH=\"$entry:\$PATH\" to $(profile_hint), then open a new shell"
      ;;
  esac
}

# The installed version against the one FIELD_REF names now.
report_release() {
  local installed="$1" latest
  if [ -n "${FIELD_OFFLINE:-}" ]; then
    row release "$RELEASE_REPO $RELEASE_REF (offline; not compared)"
    return 0
  fi
  if ! latest="$(release_version 2>/dev/null)"; then
    row release "$RELEASE_REPO $RELEASE_REF (could not read its version from $RAW_URL$(token_hint))"
    return 0
  fi
  row release "$RELEASE_REPO $RELEASE_REF is at $latest"
  [ -n "$installed" ] || return 0
  if [ "$installed" = "$latest" ]; then
    row release-latest "$installed is installed"
  elif version_older "$installed" "$latest"; then
    warn_row release-behind "$installed is installed, and $RELEASE_REF is at $latest — run $(rerun all)"
  else
    row release-ahead "$installed is installed, newer than $latest at $RELEASE_REF"
  fi
}

show_release_status() {
  local current kept
  current="$(current_version)"
  if [ -n "$current" ]; then
    row installed "$current in $(tilde "$DATA_DIR/$current")"
  else
    warn_row not-installed "no release of Field is installed in $(tilde "$DATA_DIR") — run $(rerun all)"
  fi
  report_release "$current"
  for kept in $(kept_versions "$current"); do
    row previous "$kept in $(tilde "$DATA_DIR/$kept"), kept to switch back to by hand"
  done
  report_tools
  [ -n "$current" ] || return 0
  REPO="$DATA_DIR/$current"
  report_shim
  if [ ! -f "$REPO/dist/cli.js" ]; then
    warn_row cli-unbuilt "$(tilde "$REPO/dist") holds no build — run $(rerun cli)"
  fi
  if [ -f "$REPO/ui/dist/index.html" ]; then
    row ui-current "$(tilde "$REPO/ui/dist")"
  else
    warn_row ui-missing "ui/dist holds no build, so field ui cannot open — run $(rerun cli)"
  fi
  [ -z "${FIELD_AUDIOD:-}" ] ||
    row audiod-override "FIELD_AUDIOD is set, so field runs $(tilde "$FIELD_AUDIOD") instead of this build"
  if [ -x "$REPO/$AUDIOD_RELATIVE" ]; then
    row audiod-current "$(tilde "$REPO/$AUDIOD_RELATIVE")"
  else
    warn_row audiod-missing "field-audiod is not built — run $(rerun audiod)"
  fi
  report_workers
}

# Why a run that started installing a version stopped, and what still runs.
# What it built of that version goes, because a version directory that is
# not current is never trusted, and `status` would offer it as one to
# switch back to.
release_failed() {
  [ "$1" -ne 0 ] || return 0
  # Never the version current names, should a run stop after the switch.
  if [ "$(current_version)" != "$INSTALLING" ] && is_field_version "$DATA_DIR/$INSTALLING"; then
    rm -rf "${DATA_DIR:?}/${INSTALLING:?}"
  fi
  if is_field_download "$DATA_DIR/.download-$INSTALLING"; then rm -rf "$DATA_DIR/.download-$INSTALLING"; fi
  if [ -n "$REPLACING" ]; then
    echo "install.sh: $INSTALLING did not install, so $REPLACING stays current and field still runs it" >&2
  else
    echo "install.sh: $INSTALLING did not install, and nothing was switched to it" >&2
  fi
}

# The release FIELD_REF names. A new version downloads, builds, and sets up
# again each worker the current one has, all in a directory of its own,
# and only then becomes current, so a failure at any step leaves the
# installed version as it was. The version that is already current gets
# whatever piece is missing built, its workers re-synced, and its shim
# rewritten.
install_release() {
  local current version
  [ -z "${FIELD_OFFLINE:-}" ] || die "FIELD_OFFLINE is set, and installing a release downloads it" 69
  current="$(current_version)"
  version="$(release_version)" ||
    die "could not read the version of $RELEASE_REPO at $RELEASE_REF from $RAW_URL$(token_hint)"
  row release "$RELEASE_REPO $RELEASE_REF is at $version"
  export FIELD_FETCHCONTENT_BASE_DIR="$FETCH_CACHE"
  if [ "$version" = "$current" ]; then
    REPO="$DATA_DIR/$version"
    row installed "$version is installed"
    if [ ! -f "$REPO/dist/cli.js" ] || [ ! -f "$REPO/ui/dist/index.html" ]; then build_cli; fi
    [ -x "$REPO/$AUDIOD_RELATIVE" ] || install_audiod
    install_workers
  else
    require_version_free "$version"
    INSTALLING="$version"
    REPLACING="$current"
    mkdir -p "$DATA_DIR"
    trap 'release_failed $?' EXIT
    download_release "$version"
    REPO="$DATA_DIR/$version"
    build_cli
    install_audiod
    [ -z "$current" ] || setup_workers_again "$current"
    switch_to "$version"
    trap - EXIT
  fi
  write_shim
  write_record
  [ "$version" = "$current" ] || prune "$version" "$current"
  report_shim
}

# Where the model workers' weights live, which an uninstall names rather
# than removes. field-aced downloads ACE-Step's into a directory of Field's
# own that every install on the machine uses (models_root in python/aced).
# field-voiced's Chatterbox downloads into the Hugging Face cache, which
# other tools share.
ace_models() { printf '%s' "${FIELD_ACE_MODELS:-$HOME/.field/models/acestep}"; }

huggingface_cache() {
  if [ -n "${HF_HUB_CACHE:-}" ]; then
    printf '%s' "$HF_HUB_CACHE"
  elif [ -n "${HF_HOME:-}" ]; then
    printf '%s' "$HF_HOME"
  else
    printf '%s/huggingface' "${XDG_CACHE_HOME:-$HOME/.cache}"
  fi
}

# The row for a `field` in the bin directory that the uninstall leaves. A
# release shim that runs another data directory is the one record of where
# that install lives, so the row names it.
keep_shim() {
  local other
  if is_release_shim "$1"; then
    other="$(shim_data_dir "$1")"
    if [ -n "$other" ]; then
      row kept "$(tilde "$1"), which runs the install in $(tilde "$other") — to remove that install, uninstall again with FIELD_DATA_DIR=$(tilde "$other")"
    else
      row kept "$(tilde "$1"), which does not run $(tilde "$DATA_DIR/current")"
    fi
  elif [ -e "$1" ] || [ -L "$1" ]; then
    row kept "$(tilde "$1"), which is not Field's release shim"
  fi
}

# Removes a release install (install.md §3.5): the shim, when it is the
# installer's and runs this data directory, every version and download the
# installer can show it made, `current`, release.conf, and JUCE's download,
# then the data directory if nothing else is left in it. FIELD_DATA_DIR can
# name a directory that holds other things, so those stay, as does any
# other `field` in the bin directory. The shim goes first, so `field` never
# runs a version half removed.
uninstall_release() {
  local shim="$BIN_DIR/field" entry name aced="" voiced="" models
  if [ -z "$(current_version)" ] && [ -z "$(kept_versions "")" ] && ! shim_runs_here "$shim"; then
    row not-installed "no release of Field is installed in $(tilde "$DATA_DIR")"
    ! is_release_shim "$shim" || keep_shim "$shim"
    return 0
  fi
  if shim_runs_here "$shim"; then
    rm -f "$shim"
    row removed "$(tilde "$shim")"
  else
    keep_shim "$shim"
  fi
  for entry in "$DATA_DIR"/* "$DATA_DIR"/.download-*; do
    name="${entry##*/}"
    if is_field_version "$entry"; then
      [ ! -d "$entry/python/aced/.venv" ] || aced=1
      [ ! -d "$entry/python/voiced/.venv" ] || voiced=1
      rm -rf "$entry"
      row removed "$name"
    elif is_field_download "$entry"; then
      rm -rf "$entry"
    fi
  done
  if [ -L "$DATA_DIR/current" ]; then rm -f "$DATA_DIR/current"; fi
  rm -f "$RECORD"
  rm -rf "$FETCH_CACHE"
  rmdir "$DATA_DIR/cache" 2>/dev/null || true
  if rmdir "$DATA_DIR" 2>/dev/null; then
    row removed "$(tilde "$DATA_DIR")"
  elif [ -d "$DATA_DIR" ]; then
    row kept "$(tilde "$DATA_DIR"), which holds things Field did not put there"
  fi
  models="$(ace_models)"
  if [ -n "$aced" ] && [ -d "$models" ]; then
    row models-kept "ACE-Step's weights stay in $(tilde "$models"), which every Field install on this machine uses — delete it once none of them needs the weights"
  fi
  models="$(huggingface_cache)"
  if [ -n "$voiced" ] && [ -d "$models" ]; then
    row models-kept "Chatterbox's weights stay in the Hugging Face cache, $(tilde "$models"), which other tools share — remove the models you no longer want from there"
  fi
  # release_init read release.conf before it went, so a fork's install
  # names the fork's installer.
  if [ "$RELEASE_REPO/$RELEASE_REF" = "$DEFAULT_REPO/$DEFAULT_REF" ]; then
    row uninstalled "to install again: curl -fsSL https://field.one/install.sh | bash"
  else
    row uninstalled "to install again: curl -fsSL $RAW_URL/$RELEASE_REPO/$RELEASE_REF/install.sh | bash"
  fi
}

# A Windows installer belongs to windows-portability.md (install.md §7.6),
# so a Windows shell such as Git Bash stops here, as `field upgrade` stops
# on Windows, rather than trying a release install nobody has run there.
require_not_windows() {
  case "$(uname -s)" in
    MINGW* | MSYS* | CYGWIN*)
      die "installing a release does not support Windows yet — clone Field, and in the checkout run pnpm install --frozen-lockfile, pnpm build, pnpm build:ui, pnpm build:native, and pnpm add -g ." 69
      ;;
  esac
}

release_main() {
  require_not_windows
  release_init
  case "$TARGET" in
    all)
      require_tools node pnpm compiler git cmake headers fetch
      require_shim_free
      install_release
      ;;
    # The other targets rebuild a piece of the installed version where it
    # is, as they rebuild a checkout, and say whether a newer release is out.
    cli) require_tools node pnpm; require_installed; build_cli; report_release "$(current_version)" ;;
    audiod)
      require_tools pnpm compiler git cmake headers
      require_installed
      export FIELD_FETCHCONTENT_BASE_DIR="$FETCH_CACHE"
      install_audiod
      report_release "$(current_version)"
      ;;
    workers) require_tools node; require_installed; install_workers; report_release "$(current_version)" ;;
    status) show_release_status ;;
    uninstall) uninstall_release ;;
  esac
}

# A checkout install is pnpm's global link to the checkout, so uninstalling
# it removes that link. The checkout stays, with its builds and worker
# environments: it is a clone someone made, and may hold work in progress.
uninstall_checkout() {
  if [ -n "$LINKED" ] && [ "$LINKED" = "$CHECKOUT" ]; then
    step pnpm remove -g field
    row unlinked "pnpm's global field no longer links $(tilde "$CHECKOUT")"
  elif [ -n "$LINKED" ]; then
    row kept "pnpm's global field links $(tilde "$LINKED"), not this checkout — run the install.sh there with uninstall to remove it"
  else
    row not-installed "pnpm links no field"
  fi
  row kept "$(tilde "$CHECKOUT"), the checkout itself, with its builds and worker environments — delete it yourself if you no longer want it"
}

checkout_main() {
  refresh_linked
  # Each target checks every prerequisite it needs before its first command,
  # so a missing one stops it with nothing changed.
  case "$TARGET" in
    all)
      require_tools node pnpm compiler git cmake headers
      require_global_bin
      install_cli
      install_audiod
      install_workers
      report_checkout
      ;;
    cli) require_tools node pnpm; require_global_bin; install_cli; report_checkout ;;
    audiod) require_tools pnpm compiler git cmake headers; install_audiod; report_checkout ;;
    workers) require_tools node; install_workers; report_checkout ;;
    status) show_status ;;
    uninstall) uninstall_checkout ;;
  esac
}

# Everything runs from here, on the last line, so bash has read the whole
# script before the first command runs: piped from curl, a download cut
# short runs nothing, and no command can read the rest of the script as
# its input.
main() {
  [ $# -le 1 ] || die "usage: install.sh [all|cli|audiod|workers|status|uninstall]" 64
  TARGET="${1:-all}"
  case "$TARGET" in
    all | cli | audiod | workers | status | uninstall) ;;
    *) die "usage: install.sh [all|cli|audiod|workers|status|uninstall]" 64 ;;
  esac
  if [ -n "$CHECKOUT" ]; then checkout_main; else release_main; fi
  [ -z "$LOG" ] || rm -f "$LOG"
}

main "$@"
