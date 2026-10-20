#!/usr/bin/env sh
# Installs (or removes) claude-hours on macOS and Linux.
#
#   ./install.sh               load the mod in every Claude Code session
#   ./install.sh uninstall     stop loading it (your data stays)
#   ./install.sh uninstall --purge   ...and delete ~/.claude/analytics too
set -eu

repo=$(cd "$(dirname "$0")" && pwd)
mod="$repo/mod"
data="$HOME/.claude/analytics"

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

case "${1:-install}" in
  install)
    echo "installing claude-hours"
    mkdir -p "$HOME/.claude"
    python3 "$repo/scripts/settings.py" add "$mod"
    command -v claude >/dev/null 2>&1 || echo "  (Claude Code isn't on your PATH yet, the mod loads once it is)"
    echo
    echo "done! start a new Claude Code session and it starts recording to $data"
    echo "keep this folder where it is: Claude Code loads the mod from $mod"
    ;;
  uninstall)
    echo "uninstalling claude-hours"
    python3 "$repo/scripts/settings.py" remove "$mod"
    if [ "${2:-}" = "--purge" ]; then
      rm -rf "$data"
      echo "  deleted $data"
    else
      echo "  your data is still in $data (run with --purge to delete it)"
    fi
    echo
    echo "done! new Claude Code sessions won't load the mod. sessions already open keep it until they exit"
    ;;
  *)
    echo "usage: ./install.sh [install | uninstall [--purge]]" >&2
    exit 2
    ;;
esac
