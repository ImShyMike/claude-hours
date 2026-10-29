#!/usr/bin/env python3
"""Rebuilds sessions from before time-track was installed out of Claude Code's
own transcripts, as the session files the mod would have written.

/time-track backfill runs it (python3, which the installer needs anyway) and
sends what it wrote with `send`. It only writes files, to
~/.claude/analytics/backfill/events/<session>.jsonl (or the folder given),
and prints a JSON summary; it never sends anything itself.

Most of a session is in its transcript (<config>/projects/<dir>/<id>.jsonl,
and a subagent's in <id>/subagents/agent-<agent>.jsonl): each turn's
durationMs (a turn_duration line), tool calls from their tool_use to their
tool_result, compactions, interrupts, the permission mode, the model and
tokens. What isn't: typing (no drafts, so no typingMs), when the session was
opened and closed, permission dialogs inside a call, and files a Bash command
changed. As in the mod, config.json's ignore list and file globs apply, and
only counts come out, never a prompt's text, a command or a file's contents.

A session the mod logged too is cut where the mod's log begins, so nothing
counts twice, and every run says "backfill": 1 on its header. Claude Code
deletes transcripts after cleanupPeriodDays (30 by default), so this reaches
back that far; a file already written stays once its transcript is gone. The
same transcripts give the same rows, so it's safe to run again.

    python3 backfill.py [out]
"""

import calendar
import gzip
import json
import os
import re
import subprocess
import sys
import time

FORMAT = 1
EDIT_TOOLS = {"Edit", "Write", "NotebookEdit"}
FILE_TOOLS = {"Read"} | EDIT_TOOLS
INTERRUPTED = "[Request interrupted by user"
# what a local command (/model, /time-track) prints, never a prompt
LOCAL_OUTPUT = re.compile(r"^<local-command-(stdout|stderr|caveat)>")
# the hub's longest idle cap: a gap past it is idle at any setting
SILENCE_MS = 15 * 60_000
# a transcript written to this recently may still be going
LIVE_MS = 10 * 60_000
# a mod loaded mid-session opens its log with the prompt that woke it, which
# the transcript stamped a moment before
OVERLAP_MS = 2_000
# for the summary's rough hours; the hub has the real ones
IDLE_CAP_MS = 5 * 60_000
SESSION_ID = re.compile(r"^[\w-]{1,128}$", re.ASCII)
AGENT_FILE = re.compile(r"^agent-[\w-]+\.jsonl$", re.ASCII)

# fields at their usual value are left out, as the mod does (its DEFAULTS)
DEFAULTS = {
    "tool": {"outcome": "ok"},
    "turn_end": {"reason": "answer"},
    "file_changed": {"via": "tool"},
    "prompt": {"origin": "composer", "isMeta": False},
    "session_start": {"isInteractive": True},
    "compact": {"outcome": "compacted"},
}


class Undefined:
    """A field the transcript doesn't have, left out"""


UNDEFINED = Undefined()


def field(d, key):
    return d[key] if isinstance(d, dict) and key in d else UNDEFINED


def child(d, key):
    v = d.get(key) if isinstance(d, dict) else None
    return v if isinstance(v, dict) else {}


# JavaScript's \s, so words count as they do in the mod
JS_SPACE = "\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
JS_SPACES = re.compile("[" + JS_SPACE + "]+")
JS_EDGES = re.compile("^[" + JS_SPACE + "]+|[" + JS_SPACE + "]+$")


def js_trim(text):
    return JS_EDGES.sub("", text)


def count_words(text):
    return len([w for w in JS_SPACES.split(js_trim(text)) if w])


PASTE_BLOCK = re.compile(r'<pasted_content id="([^"]*)">\n*([\s\S]*?)\n*</pasted_content id="\1">')


def folded_paste_chars(text):
    return sum(len(m.group(2)) for m in PASTE_BLOCK.finditer(text))


# a string's length as JavaScript counts it, in UTF-16 units
def utf16_length(text):
    return len(text.encode("utf-16-le", "surrogatepass")) // 2


def parse_ms(stamp):
    """epoch ms of an ISO time, or None"""
    if not isinstance(stamp, str):
        return None
    m = re.match(r"^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.(\d+))?(Z|[+-]\d\d:\d\d)$", stamp)
    if not m:
        return None
    year, month, day, hour, minute, second, fraction, zone = m.groups()
    try:
        seconds = calendar.timegm((int(year), int(month), int(day), int(hour), int(minute), int(second), 0, 0, 0))
    except (ValueError, OverflowError):
        return None
    ms = seconds * 1000 + int((fraction or "0")[:3].ljust(3, "0"))
    if zone != "Z":
        sign = 1 if zone[0] == "+" else -1
        ms -= sign * (int(zone[1:3]) * 60 + int(zone[4:6])) * 60_000
    return ms


# The mod's path helpers, kept in step with its copies


def resolve_path(base, path):
    parts = []
    for part in (path if path.startswith("/") else base + "/" + path).split("/"):
        if part == "..":
            if parts:
                parts.pop()
        elif part and part != ".":
            parts.append(part)
    return "/" + "/".join(parts)


def cd_target(command, cwd, home):
    m = re.match(r"""^\s*cd\s+(?:"([^"]*)"|'([^']*)'|([^\s;&|]+))""", command)
    to = m and next((g for g in m.groups() if g is not None), None)
    if not to:
        return None
    return resolve_path(cwd, home if to == "~" else home + to[1:] if to.startswith("~/") else to)


def glob_to_regex(glob):
    out = ""
    i = 0
    while i < len(glob):
        c = glob[i]
        if c == "*" and glob[i + 1 : i + 2] == "*":
            slash = glob[i + 2 : i + 3] == "/"
            out += "(?:.*/)?" if slash else ".*"
            i += 3 if slash else 2
            continue
        if c == "*":
            out += "[^/]*"
        elif c == "?":
            out += "[^/]"
        else:
            out += "\\" + c if c in ".+^${}()|[]\\" else c
        i += 1
    return re.compile("^" + out + "$")


def glob_matches(glob, path, cwd, home):
    pattern = glob_to_regex(re.sub(r"/$", "", home + "/" + glob[2:] if glob.startswith("~/") else glob))
    if "/" not in glob:
        return any(pattern.match(name) for name in path.split("/"))
    if glob.startswith("/") or glob.startswith("~/"):
        target = path
    elif path.startswith(cwd + "/"):
        target = path[len(cwd) + 1 :]
    else:
        return False
    parts = target.split("/")
    return any(pattern.match("/".join(parts[: i + 1])) for i in range(len(parts)))


# excluded always loses; with any includes, only those are logged
def allowed(rules, path, cwd):
    home = rules["home"]
    if any(glob_matches(g, path, cwd, home) for g in rules["exclude"]):
        return False
    return not rules["include"] or any(glob_matches(g, path, cwd, home) for g in rules["include"])


def under(folders, path):
    return any(path == f or path.startswith(f + "/") for f in folders)


class Git:
    """The same git calls the mod makes, once per folder"""

    def __init__(self):
        self.roots = {}
        self.names = {}

    @staticmethod
    def run(args):
        try:
            r = subprocess.run(["git"] + args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=2)
        except (OSError, subprocess.SubprocessError):
            return None
        return r.stdout.decode("utf-8", "replace").strip() if r.returncode == 0 else None

    # the repo's folder; a worktree's is the repo it was made from
    def root_of(self, folder):
        if folder not in self.roots:
            out = self.run(["-C", folder, "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"]) if os.path.exists(folder) else None
            lines = out.split("\n") if out else []
            top = lines[0] if lines else ""
            common = lines[1] if len(lines) > 1 else None
            root = None
            if top:
                root = common[: -len("/.git")] if common and common.endswith("/.git") and common != top + "/.git" else top
            self.roots[folder] = root
        return self.roots[folder]

    # its origin remote's name, when that's not its folder's
    def remote_name(self, root):
        if root not in self.names:
            url = self.run(["-C", root, "remote", "get-url", "origin"])
            m = re.search(r"([^/:]+?)(?:\.git)?/?$", url) if url else None
            name = m.group(1) if m else None
            self.names[root] = name if name and name != root.split("/")[-1] else None
        return self.names[root]


def text_of(content):
    if isinstance(content, str):
        return content
    return "".join(str(c["text"]) if c.get("text") is not None else "" for c in items(content) if c.get("type") == "text")


def items(content):
    return [c for c in content if isinstance(c, dict)] if isinstance(content, list) else []


def entries_of(text):
    entries = []
    for line in text.split("\n"):
        if not line.strip():
            continue
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if isinstance(entry, dict) and parse_ms(entry.get("timestamp")) is not None:
            entries.append(entry)
    return entries


class Tokens:
    """One turn's tokens, by message: a message streamed over several lines
    repeats its usage on each, so the last line's is the whole of it"""

    KEYS = ("input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens")

    def __init__(self):
        self.by_message = {}
        self.model = None

    def add(self, entry):
        message = child(entry, "message")
        usage = message.get("usage")
        if not usage:
            return
        key = message.get("id") if message.get("id") is not None else entry.get("uuid")
        self.by_message[str(key)] = usage if isinstance(usage, dict) else {}
        model = message.get("model")
        if isinstance(model, str) and model != "<synthetic>":
            self.model = model

    def take(self):
        if not self.by_message:
            return UNDEFINED
        usage = {key: 0 for key in self.KEYS}
        for u in self.by_message.values():
            for key in self.KEYS:
                v = u.get(key)
                usage[key] += v if isinstance(v, (int, float)) and not isinstance(v, bool) and v == v else 0
        if self.model:
            usage["model"] = self.model
        self.by_message = {}
        self.model = None
        return usage


class Session:
    def __init__(self, git, rules):
        self.git = git
        self.rules = rules

    # an event with its repo's root and name, as the mod writes them, or
    # nothing while the cwd or its repo is in an ignored folder. Its fields
    # are (name, value) pairs in the mod's order; None and UNDEFINED are left out
    def event_at(self, at, cwd, event, fields):
        root = self.git.root_of(cwd) if cwd else None
        if under(self.rules["ignore"], cwd) or (root and under(self.rules["ignore"], root)):
            return None
        name = self.git.remote_name(root) if root else None
        e = {"at": at, "cwd": cwd, "event": event, "fields": [(k, v) for k, v in fields if v is not UNDEFINED and v is not None]}
        if root and root != cwd:
            e["root"] = root
        if name:
            e["rootName"] = name
        return e

    def keep(self, path, cwd):
        if path and allowed(self.rules, path, cwd) and not under(self.rules["ignore"], resolve_path(cwd, path)):
            return path
        return None

    def thread(self, entries, agent_id):
        git, rules = self.git, self.rules
        events = []
        started = {}
        tokens = Tokens()
        main = agent_id is None
        state = {
            "mode": None,
            # the open turn's start, and whether the last one was closed by an
            # Esc (a turn_duration after it, with no prompt between, is the
            # same turn)
            "turn_from": None,
            "interrupted": False,
            # the last thing the main thread did, and where
            "last_at": 0,
            "last_cwd": "",
            # a slash command no answer has followed yet: a local one (/model,
            # /clear) never gets one, and was never a prompt
            "command": None,
        }

        def push(at, cwd, event, fields):
            e = self.event_at(at, cwd, event, [("agentId", agent_id)] + fields)
            if e:
                events.append(e)
            return e

        def drop_command():
            if state["command"] is not None:
                events[:] = [e for e in events if e is not state["command"]]
            state["command"] = None

        # Claude at work. In a turn that never ends, a long silence (a request
        # that hung while the laptop slept) is where it stopped, not more of it
        def worked(at, cwd):
            if state["turn_from"] is not None and at - state["last_at"] > SILENCE_MS:
                return
            state["last_at"] = at
            state["last_cwd"] = cwd

        # A turn cut short leaves no line saying so when it was an Esc right
        # after sending or a call turned down: it just never ends. It's over at
        # its last work, found at the next prompt sent between turns, an Esc
        # or the transcript's end
        def abandon_turn():
            if state["turn_from"] is not None:
                last = state["last_at"]
                push(last, state["last_cwd"], "interrupt", [("reason", "aborted"), ("durationMs", last - state["turn_from"]), ("usage", tokens.take())])
            state["turn_from"] = None

        def prompted(at, cwd, text, fields, mid_turn):
            pasted = folded_paste_chars(text) if dict(fields)["origin"] == "composer" else 0
            e = push(
                at,
                cwd,
                "prompt",
                [("words", count_words(text)), ("chars", len(text))] + fields + [("midTurn", True if mid_turn else None), ("pastedChars", pasted or None)],
            )
            # one sent mid-turn after a long silence (a task's notification as
            # the laptop woke) doesn't carry the turn's work up to it either
            worked(at, cwd)
            state["interrupted"] = False
            return e

        def tool_ended(at, cwd, result, denied):
            call = started.pop(result.get("tool_use_id"), None)
            if not call:
                return
            tool, given = call["tool"], call["input"]
            named = None
            if tool in FILE_TOOLS:
                named = given.get("file_path") if given.get("file_path") is not None else given.get("notebook_path")
            command = given.get("command") if tool == "Bash" and isinstance(given.get("command"), str) else None
            file = self.keep(named if isinstance(named, str) else None, cwd)
            if file:
                where = re.sub(r"/[^/]*$", "", resolve_path(cwd, file), count=1)
            else:
                where = cd_target(command, cwd, rules["home"]) if command is not None else None
            repo = None
            if where and where != cwd and not where.startswith(cwd + "/"):
                root = git.root_of(where)
                repo = self.keep(root if root and root != git.root_of(cwd) else None, cwd)
            outcome = "denied" if denied else "error" if result.get("is_error") else "ok"
            push(
                at,
                cwd,
                "tool",
                [
                    ("tool", tool),
                    ("file", file),
                    ("repo", repo),
                    ("repoName", git.remote_name(repo) if repo else None),
                    ("commandChars", utf16_length(command) if command is not None else None),
                    ("outcome", outcome),
                    ("durationMs", max(0, at - call["at"])),
                ],
            )
            if outcome == "ok" and tool in EDIT_TOOLS and file:
                push(at, cwd, "file_changed", [("tool", tool), ("path", file), ("via", "tool")])

        for entry in entries:
            if main and entry.get("isSidechain"):
                continue
            at = parse_ms(entry["timestamp"])
            cwd = entry["cwd"] if isinstance(entry.get("cwd"), str) else state["last_cwd"]
            kind_of_line = entry.get("type")
            if kind_of_line == "assistant":
                tokens.add(entry)
                for c in items(child(entry, "message").get("content")):
                    if c.get("type") == "tool_use":
                        started[c.get("id")] = {"at": at, "tool": str(c.get("name")), "input": child(c, "input")}
                if state["command"] is not None and state["turn_from"] is None:
                    state["turn_from"] = state["command"]["at"]
                state["command"] = None
                worked(at, cwd)
                continue
            if not main:
                if kind_of_line == "user":
                    for c in items(child(entry, "message").get("content")):
                        if c.get("type") == "tool_result":
                            tool_ended(at, cwd, c, bool(entry.get("toolDenialKind")))
                continue

            if kind_of_line == "system" and entry.get("subtype") == "turn_duration":
                if not state["interrupted"]:
                    push(at, cwd, "turn_end", [("reason", "answer"), ("durationMs", field(entry, "durationMs")), ("usage", tokens.take())])
                state["turn_from"] = None
                state["interrupted"] = False
                continue
            # a prompt sent while Claude was working, handed to it mid-turn (a
            # task notification gets there the same way, but never as a prompt
            # the mod sees)
            queued = child(entry, "attachment")
            if kind_of_line == "attachment" and queued.get("type") == "queued_command" and queued.get("commandMode") == "prompt":
                origin = child(queued, "origin").get("kind")
                text = queued["prompt"] if isinstance(queued.get("prompt"), str) else text_of(queued.get("prompt"))
                fields = [("origin", "composer" if not origin or origin == "human" else origin), ("isMeta", queued.get("isMeta") is True)]
                prompted(at, cwd, text, fields, True)
                continue
            if kind_of_line == "system" and entry.get("subtype") == "compact_boundary":
                m = child(entry, "compactMetadata")
                push(
                    at,
                    cwd,
                    "compact",
                    [
                        ("trigger", field(m, "trigger")),
                        ("tokensBefore", field(m, "preTokens")),
                        ("tokensAfter", field(m, "postTokens")),
                        ("durationMs", field(m, "durationMs")),
                        ("outcome", "compacted"),
                        ("uuid", field(entry, "uuid")),
                    ],
                )
                continue
            if kind_of_line != "user":
                continue

            content = child(entry, "message").get("content")
            results = [c for c in items(content) if c.get("type") == "tool_result"]
            if results:
                for c in results:
                    tool_ended(at, cwd, c, bool(entry.get("toolDenialKind")))
                worked(at, cwd)
                continue
            text = text_of(content)
            # an Esc ends the turn at its last work too: one pressed days after
            # the request hung isn't days of work
            if text.startswith(INTERRUPTED):
                if state["turn_from"] is not None:
                    worked(at, cwd)
                abandon_turn()
                state["interrupted"] = True
                continue
            if entry.get("isCompactSummary") or LOCAL_OUTPUT.match(text):
                continue
            kind = child(entry, "origin").get("kind")
            named = re.search(r"<command-name>/?([^<]*)</command-name>", text)
            name = named.group(1) if named else None
            # older lines have no origin: a person's prompt is plain text, the
            # rest (skill bodies, caveats, ! commands) is meta or wrapped in a tag
            if not kind and (entry.get("isMeta") or (text.startswith("<") and not name)):
                continue
            drop_command()
            is_queued = entry.get("promptSource") == "queued"
            if not is_queued and (not kind or kind == "human"):
                abandon_turn()
            mode = entry.get("permissionMode")
            if isinstance(mode, str) and mode != state["mode"]:
                state["mode"] = mode
                push(at, cwd, "mode", [("mode", mode)])
            args = None
            if name is not None:
                found = re.search(r"<command-args>([\s\S]*?)</command-args>", text)
                args = js_trim(found.group(1)) if found else None
            images = len([c for c in items(content) if c.get("type") == "image"])
            fields = [
                ("command", name),
                ("isMeta", entry.get("isMeta") is True),
                ("origin", "composer" if not kind or kind == "human" else kind),
                ("images", images or None),
            ]
            sent = "/" + name + (" " + args if args else "") if name is not None else text
            e = prompted(at, cwd, sent, fields, state["turn_from"] is not None or is_queued)
            if name is not None:
                state["command"] = e
            elif state["turn_from"] is None:
                state["turn_from"] = at
        if main:
            drop_command()
            abandon_turn()

        # a subagent's run as one turn, from its first line to its last
        if not main and entries:
            first = parse_ms(entries[0]["timestamp"])
            last = entries[-1]
            end = parse_ms(last["timestamp"])
            cwd = last["cwd"] if isinstance(last.get("cwd"), str) else ""
            push(end, cwd, "turn_end", [("reason", "answer"), ("durationMs", end - first), ("usage", tokens.take())])
        return events

    def events(self, main_text, subagents, before=None):
        """A session's events in time order, as the mod would have logged them"""
        entries = entries_of(main_text)
        events = self.thread(entries, None)
        # the session opened with its first line
        opened = next((e for e in entries if not e.get("isSidechain") and isinstance(e.get("cwd"), str)), None)
        if opened and events:
            entrypoint = opened.get("entrypoint")
            fields = [("surface", "terminal" if entrypoint == "cli" else None), ("isInteractive", entrypoint != "sdk-cli")]
            start = self.event_at(parse_ms(opened["timestamp"]), opened["cwd"], "session_start", fields)
            if start:
                events.insert(0, start)
        for agent_id, text in subagents:
            events.extend(self.thread(entries_of(text), agent_id))
        kept = events if before is None else [e for e in events if e["at"] < before]
        # its opening alone is the moment the mod's own log opened with
        if all(e["event"] == "session_start" for e in kept):
            return []
        # stable, so a re-run writes the same rows in the same order
        return sorted(kept, key=lambda e: e["at"])


def plain(value):
    """numbers as JavaScript writes them: 3.0 is 3"""
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, dict):
        return {k: plain(v) for k, v in value.items()}
    if isinstance(value, list):
        return [plain(v) for v in value]
    return value


LONE_SURROGATE = re.compile("[\ud800-\udfff]")


def line(row):
    text = json.dumps(plain(row), ensure_ascii=False, separators=(",", ":"))
    return LONE_SURROGATE.sub(lambda m: "\\u%04x" % ord(m.group()), text) + "\n"


def rooted(e):
    return [(key, e[key]) for key in ("root", "rootName") if key in e]


def relative(path, cwd):
    return path[len(cwd) + 1 :] if isinstance(path, str) and path.startswith(cwd + "/") else path


def encode(events):
    """The session file as the mod writes it, its header saying backfill"""
    start = events[0]["at"]
    cwd = events[0]["cwd"]
    rows = [dict([("v", FORMAT), ("event", "session"), ("start", start), ("cwd", cwd)] + rooted(events[0]) + [("backfill", 1)])]
    for e in events:
        t = e["at"] - start
        if e["cwd"] != cwd:
            cwd = e["cwd"]
            rows.append(dict([("t", t), ("event", "cwd_changed"), ("cwd", cwd)] + rooted(e)))
        usual = DEFAULTS.get(e["event"], {})
        row = {"t": t, "event": e["event"]}
        for key, value in e["fields"]:
            if key in usual and type(usual[key]) is type(value) and usual[key] == value:
                continue
            row[key] = relative(value, cwd) if key in ("file", "path") else value
        rows.append(row)
    return "".join(line(row) for row in rows)


def active_ms(events):
    """Rough active time, for the summary: each main turn a span, every event
    a moment, gaps up to the idle cap bridged"""
    spans = []
    for e in events:
        fields = dict(e["fields"])
        lead = 0
        main_turn = e["event"] in ("turn_end", "interrupt") or (e["event"] == "compact" and fields.get("trigger") != "precompute")
        if main_turn and "agentId" not in fields:
            duration = fields.get("durationMs")
            lead = duration if isinstance(duration, (int, float)) and not isinstance(duration, bool) else 0
        spans.append((e["at"] - lead, e["at"]))
    total = 0
    last = None
    for start, end in sorted(spans):
        if last and start - last[1] <= IDLE_CAP_MS:
            last[1] = max(last[1], end)
            continue
        if last:
            total += last[1] - last[0]
        last = [start, end]
    return total + (last[1] - last[0] if last else 0)


def read_config(analytics):
    try:
        with open(os.path.join(analytics, "config.json"), encoding="utf-8") as f:
            config = json.load(f)
        return config if isinstance(config, dict) else {}
    except (OSError, ValueError):
        return {}


def strings(v):
    return [g for g in v if isinstance(g, str)] if isinstance(v, list) else []


def mod_start(analytics, session):
    """Where the mod's own log of a session begins: its first run's start.
    None when it never logged it; False when it did but nothing says when (a
    file it can't read counts as that too, so nothing is counted twice)"""
    path = os.path.join(analytics, "events", session + ".jsonl")
    parts = []
    try:
        if os.path.exists(path + ".gz"):
            with open(path + ".gz", "rb") as f:
                parts.append(gzip.decompress(f.read()).decode("utf-8", "replace"))
        if os.path.exists(path):
            with open(path, encoding="utf-8", errors="replace") as f:
                parts.append(f.read())
    except (OSError, EOFError, ValueError):
        return False
    if not parts:
        return None
    starts = []
    for part in parts:
        # whole lines only: a last line with no newline is still being written
        for text in part.split("\n")[:-1]:
            try:
                row = json.loads(text)
            except ValueError:
                continue
            if not isinstance(row, dict) or row.get("event") != "session":
                continue
            start = row.get("start")
            if isinstance(start, int) and not isinstance(start, bool) and abs(start) <= 2**53 - 1:
                starts.append(start)
    return min(starts) - OVERLAP_MS if starts else False


def read(path):
    with open(path, encoding="utf-8", errors="replace") as f:
        return f.read()


def main(argv):
    home = os.path.expanduser("~")
    analytics = os.path.join(home, ".claude", "analytics")
    projects = os.path.join(os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(home, ".claude"), "projects")
    out = argv[1] if len(argv) > 1 else os.path.join(analytics, "backfill")
    config = read_config(analytics)
    files = child(config, "files")
    rules = {"home": home, "ignore": strings(config.get("ignore")), "include": strings(files.get("include")), "exclude": strings(files.get("exclude"))}
    session = Session(Git(), rules)

    now = time.time() * 1000
    counts = {"written": 0, "logged": 0, "live": 0, "empty": 0}
    total = 0
    os.makedirs(os.path.join(out, "events"), exist_ok=True)
    for folder_name in sorted(os.listdir(projects)) if os.path.isdir(projects) else []:
        folder = os.path.join(projects, folder_name)
        if not os.path.isdir(folder):
            continue
        for name in sorted(os.listdir(folder)):
            sid = name[: -len(".jsonl")] if name.endswith(".jsonl") else None
            if not sid or not SESSION_ID.match(sid):
                continue
            agents_dir = os.path.join(folder, sid, "subagents")
            agent_files = sorted(f for f in os.listdir(agents_dir) if AGENT_FILE.match(f)) if os.path.isdir(agents_dir) else []
            paths = [os.path.join(folder, name)] + [os.path.join(agents_dir, f) for f in agent_files]
            if any(now - os.stat(p).st_mtime * 1000 < LIVE_MS for p in paths):
                counts["live"] += 1
                continue
            before = mod_start(analytics, sid)
            if before is False:
                counts["logged"] += 1
                continue
            subagents = [(f[len("agent-") : -len(".jsonl")], read(os.path.join(agents_dir, f))) for f in agent_files]
            events = session.events(read(paths[0]), subagents, before)
            if not events:
                counts["empty" if before is None else "logged"] += 1
                continue
            with open(os.path.join(out, "events", sid + ".jsonl"), "w", encoding="utf-8", newline="\n") as f:
                f.write(encode(events))
            total += active_ms(events)
            counts["written"] += 1

    # every file there, older runs' too, for /time-track backfill send
    written = os.listdir(os.path.join(out, "events"))
    sessions = sorted(f[: -len(".jsonl")] for f in written if f.endswith(".jsonl") and SESSION_ID.match(f[: -len(".jsonl")]))
    print(json.dumps(dict(counts, ms=total, dir=out, sessions=sessions)))


if __name__ == "__main__":
    try:
        main(sys.argv)
    except Exception as err:  # every failure, said in one line
        print("backfill: %s" % err, file=sys.stderr)
        sys.exit(1)
