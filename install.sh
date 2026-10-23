#!/usr/bin/env sh
# Installs (or removes) claude-hours on macOS and Linux.
#
#   curl -fsSL https://<hub>/install.sh | sh                    from a hub, no clone needed
#   curl -fsSL https://<hub>/install.sh | sh -s uninstall [--purge]
#   ./install.sh                                                from a clone, loads its mod
#   ./install.sh uninstall           stop loading it (your data stays)
#   ./install.sh uninstall --purge   ...and delete ~/.claude/analytics too
#
# From a hub, rerunning it updates the mod to the hub's copy
set -eu

# filled in by the hub that serves this script, empty in a clone
hub=''
data="$HOME/.claude/analytics"
home="$HOME/.claude/claude-hours"

case "$(uname -s)" in
  Darwin | Linux) ;;
  *) echo "only macOS and Linux for now (on Windows, run Claude Code in WSL)" >&2; exit 1 ;;
esac

# only to edit settings.json; the mod itself runs inside Claude Code
if ! command -v python3 >/dev/null 2>&1; then
  echo "the installer needs python3 to edit ~/.claude/settings.json." >&2
  echo "on macOS: xcode-select --install   on Linux: your package manager's python3" >&2
  exit 1
fi

if [ -z "$hub" ]; then
  repo=$(cd "$(dirname "$0")" && pwd)
  if [ ! -f "$repo/mod/.claude-plugin/plugin.json" ]; then
    echo "run this from a claude-hours clone, or straight from your hub: curl -fsSL https://<hub>/install.sh | sh" >&2
    exit 1
  fi
  mod="$repo/mod"
  settings="$repo/scripts/settings.py"
  again="./install.sh"
else
  if ! command -v curl >/dev/null 2>&1; then
    echo "the installer needs curl to download the mod from $hub" >&2
    exit 1
  fi
  mod="$home/mod"
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  fetch() {
    mkdir -p "$tmp/$(dirname "$1")"
    curl -fsSL "$hub/install/$1" -o "$tmp/$1"
  }
  fetch settings.py
  settings="$tmp/settings.py"
  again="curl -fsSL $hub/install.sh | sh -s"
fi

case "${1:-install}" in
  install)
    echo "installing claude-hours"
    mkdir -p "$HOME/.claude"
    if [ -n "$hub" ]; then
      # the same files the hub's /install route hands out
      # (release.json names this build, for /time-track update)
      for file in .claude-plugin/plugin.json hooks/hooks.json hooks/register.ts types/index.d.ts tsconfig.json .claude-plugin/release.json; do
        fetch "mod/$file"
      done
      rm -rf "$mod"
      mkdir -p "$home"
      mv "$tmp/mod" "$mod"
      echo "  downloaded the mod from $hub to $mod"
    fi
    python3 "$settings" add "$mod"
    command -v claude >/dev/null 2>&1 || echo "  (Claude Code isn't on your PATH yet, the mod loads once it is)"
    echo
    echo "done! start a new Claude Code session and it starts recording to $data"
    if [ -n "$hub" ]; then
      echo "to send it to $hub, copy a login command from $hub/settings and paste it into Claude Code to start tracking your stats!"
    else
      echo "keep this folder where it is: Claude Code loads the mod from $mod"
    fi
    ;;
  uninstall)
    echo "uninstalling claude-hours"
    python3 "$settings" remove "$mod"
    if [ -n "$hub" ]; then
      rm -rf "$home"
      echo "  deleted $home"
    fi
    if [ "${2:-}" = "--purge" ]; then
      rm -rf "$data"
      echo "  deleted $data"
    else
      echo "  your data is still in $data (run $again uninstall --purge to delete it)"
    fi
    echo
    echo "done! new Claude Code sessions won't load the mod. sessions already open keep it until they exit"
    ;;
  *)
    echo "usage: $again [install | uninstall [--purge]]" >&2
    exit 2
    ;;
esac
