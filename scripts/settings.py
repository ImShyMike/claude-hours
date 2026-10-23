"""Adds or removes the mod in ~/.claude/settings.json, for install.sh.

Claude Code loads it from env.CLAUDE_CODE_PLUGIN_DIRS, a ':' separated list
of folders, so this edits that one entry and leaves the rest alone. Plain
python3 so installing needs nothing extra.

  python3 scripts/settings.py add <mod dir>
  python3 scripts/settings.py remove <mod dir>
"""

import json
import os
import sys

KEY = "CLAUDE_CODE_PLUGIN_DIRS"
# its name, and the name it had before, so an old copy is dropped too
MOD_NAMES = ("time-track", "hook-analytics")


def expand(path):
    return os.path.normpath(os.path.abspath(os.path.expanduser(path)))


def is_our_mod(path):
    """Another copy of this mod, which would log every event twice."""
    try:
        with open(os.path.join(expand(path), ".claude-plugin", "plugin.json")) as f:
            return json.load(f).get("name") in MOD_NAMES
    except (OSError, ValueError, AttributeError):
        return False


def with_dirs(settings, dirs):
    env = dict(settings.get("env") or {})
    if dirs:
        env[KEY] = ":".join(dirs)
    else:
        env.pop(KEY, None)
    out = dict(settings)
    if env:
        out["env"] = env
    else:
        out.pop("env", None)
    return out


def dirs_of(settings):
    return [d for d in ((settings.get("env") or {}).get(KEY) or "").split(":") if d]


def add_mod(settings, mod_dir):
    """Puts mod_dir in the list once, dropping other copies of the mod."""
    target = expand(mod_dir)
    kept = [d for d in dirs_of(settings) if expand(d) != target and not is_our_mod(d)]
    return with_dirs(settings, kept + [target])


def remove_mod(settings, mod_dir):
    target = expand(mod_dir)
    return with_dirs(settings, [d for d in dirs_of(settings) if expand(d) != target])


def main(argv):
    if len(argv) != 3 or argv[1] not in ("add", "remove"):
        print("usage: python3 scripts/settings.py add|remove <mod dir>", file=sys.stderr)
        return 2
    action, mod_dir = argv[1], argv[2]
    path = os.path.join(os.path.expanduser("~"), ".claude", "settings.json")
    before = None
    if os.path.exists(path):
        with open(path) as f:
            before = f.read()
    settings = json.loads(before) if before and before.strip() else {}
    after = add_mod(settings, mod_dir) if action == "add" else remove_mod(settings, mod_dir)

    if after == settings:
        print("  settings.json already %s the mod" % ("has" if action == "add" else "lacks"))
        return 0
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if before is not None:
        with open(path + ".bak", "w") as f:
            f.write(before)
    with open(path, "w") as f:
        f.write(json.dumps(after, indent=2, ensure_ascii=False) + "\n")
    verb = "added the mod to" if action == "add" else "removed the mod from"
    print("  %s %s%s" % (verb, path, " (old copy in settings.json.bak)" if before is not None else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
