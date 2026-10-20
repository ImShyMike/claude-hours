# claude-hackatime

A local, Hackatime-style dashboard for the time spent coding with Claude Code.
It reads the JSONL logs that the `hook-analytics` mod writes to
`~/.claude/analytics/events/`, one file per session.

## Setup

There are two halves: the mod, which records, and this repo, which shows.

### Quick install (macOS and Linux)

Needs Claude Code and `python3` (on macOS it comes with the Command Line
Tools, same as `git`). From this repo:

```sh
./install.sh                     # load the mod in every Claude Code session
./install.sh uninstall           # stop loading it, keep your data
./install.sh uninstall --purge   # stop loading it and delete ~/.claude/analytics
```

The installer only edits `env.CLAUDE_CODE_PLUGIN_DIRS` in
`~/.claude/settings.json` (keeping a `settings.json.bak`), adding this repo's
`mod/` folder and dropping any other copy of hook-analytics so nothing gets
logged twice. Other plugin folders listed there are left alone. Then start
a new Claude Code session. The mod loads from this repo's `mod/`, so keep
the clone where it is. The installer doesn't touch the dashboard; that
stays a repo thing (`bun run dev`, below).

Windows isn't supported yet: the mod writes with `tee`, `mkdir` and `find`.
Running Claude Code inside WSL works like Linux.

### By hand

1. **Get the mod.** `hook-analytics` is a Claude Code plugin made of a
   function-hooks module, in this repo's `mod/` folder:

   ```
   mod/
     .claude-plugin/plugin.json   # name, version, description
     hooks/hooks.json             # points Claude Code at register.ts
     hooks/register.ts            # every hook; the whole mod
     hooks/register.test.ts       # tests (claude plugin test)
     types/index.d.ts             # the mod's own state type
     TODO.md                      # what it logs, field by field, and open todos
   ```

2. **Load it in every session.** Point Claude Code at the folder (an
   absolute path, `~` allowed) in `~/.claude/settings.json`:

   ```json
   { "env": { "CLAUDE_CODE_PLUGIN_DIRS": "~/path/to/claude-hackatime/mod" } }
   ```

   For a one-off try, `claude --plugin-dir ~/path/to/claude-hackatime/mod`
   works too. Start a new session; a `session_start` line in
   `~/.claude/analytics/events/` means it's recording. Editing
   `register.ts` hot-reloads it in running sessions, and Claude Code writes
   the API's type declarations into `mod/.claude-plugin/types/` (ignored by
   git) so `tsc -p mod` works.

3. **Check the mod** (optional, after editing it):

   ```sh
   cd mod
   claude plugin test        # its tests
   claude plugin validate .  # the manifest and what it hooks
   ```

4. **Run the dashboard.** Install [Bun](https://bun.sh), then in this repo:

   ```sh
   bun run dev     # http://127.0.0.1:4747, reads ~/.claude/analytics
   bun run demo    # generates fake events into fixtures/ and serves those
   bun run test
   ```

   No dependencies, just Bun. The server only binds to `127.0.0.1`, since
   the events contain local paths. Set `ANALYTICS_DIR` and `PORT` to
   override the defaults. Add `?theme=dark` or `?theme=light` to the URL to
   pin the theme.

## Where things live

```
~/.claude/analytics/
  events/<sessionId>.jsonl     # one JSON line per event, one file per session
  events/<sessionId>.jsonl.gz  # the same, once the session has ended
  drafts/<sessionId>.jsonl     # draft edit timelines for the replay, same split
  drafts/<sessionId>.jsonl.gz
  config.json                  # optional: which files get logged
```

- **Nothing here holds prompt text.** Prompts are logged as counts (words,
  chars, typing time, edits). Draft timelines keep shapes only: where letters,
  blanks and newlines were, never which letters. An interrupt records how many
  characters of the answer had shown, not the answer.
- **It does hold local paths:** the session's `cwd`, plus the files tools
  touched (`file_changed`). That's why the server stays on localhost.
- **Nothing leaves the machine unless you set a hub.** The mod appends with
  `tee -a`; the dashboard reads the files on every request and does all the
  math in the browser. With a `server` in `config.json`, the session files go
  to that hub as they are (see Central hub).
- **It splits itself.** Each session gets its own small file, so there's no
  one log to rotate. Delete old session files to forget them.
- **Ended sessions are gzipped.** When a session exits, the mod appends its
  files to `<id>.jsonl.gz` and removes the plain ones. A resumed session
  starts a fresh `.jsonl` next to the `.gz`, and the next exit appends another
  gzip member, so `zcat` shows the whole thing. The dashboard reads both.
- Deleting the files is safe: the next event recreates them. Keep the
  folders, though; the mod only creates them once per session.

### What gets logged

A session file opens with a header, `{"v":1,"event":"session","start":<epoch
ms>,"cwd":...}`. After it, every row has `event` and `t`, ms since that start,
and nothing repeated: the file name is the session, a `cwd_changed` row says
when the cwd moves, and paths under the cwd are written relative to it. A
field at its usual value is left out too (`outcome: "ok"`, `via: "tool"`,
`origin: "composer"` and friends, plus a typed draft's counters at 0), and
the decoder puts them back.

```json
{"v":1,"event":"session","start":1792472272642,"cwd":"/home/me/code/terra"}
{"t":0,"event":"session_start","surface":"terminal","isInteractive":true}
{"t":48211,"event":"tool","tool":"Edit","file":"src/db.ts","durationMs":31}
{"t":48212,"event":"file_changed","tool":"Edit","path":"src/db.ts"}
```

`src/eventlog.ts` decodes it back to flat events and skips files in any other
format. The full field list is in the mod's `TODO.md`; the short version:

| event | when |
| --- | --- |
| `session_start` / `session_end` | a session opens or exits |
| `prompt` | a prompt is sent: word and char counts, who sent it (`origin`), `midTurn` if Claude was still working, and for a typed one the draft stats (typing time, fixes, rewrites, pauses, `draftId`) |
| `draft_abandoned` | a typed draft was cleared, undone, deleted or left at exit without being sent |
| `turn_end` / `interrupt` | a turn finished, or was stopped with Esc (`answerChars` and `toolsRunning` say what got cut off) |
| `compact` | a compaction finished: trigger, tokens before and after, how long it took |
| `tool` | a tool call finished, with outcome and duration (its row is written at the end, so it began `durationMs` earlier) |
| `file_changed` | a file edited by a tool, or changed during a Bash call |
| `cwd_changed` | the session's working directory moved |

### Choosing which files get logged

By default every file a built-in tool touches is logged. To keep some out,
or to only log some, write `~/.claude/analytics/config.json`:

```json
{ "files": { "exclude": ["fixtures", "*.log", "~/secrets"], "include": ["src/**"] } }
```

- A glob with no `/` matches any folder or file name along the path, so
  `fixtures` drops everything under any `fixtures/` folder.
- A glob with a `/` matches from the session's cwd, or from the root when it
  starts with `/` or `~/`. Naming a folder covers everything inside it.
- `*` stays inside one folder, `**` crosses folders, `?` is one character.
- `exclude` always wins. A non-empty `include` means only those paths.

A left-out file still logs its tool call, just without the path, so time and
tool counts stay right. Changes apply from the next tool call. A broken
config logs everything, with a warning in the mod's log.

### How the mod hears things

It's all Claude Code function hooks, each one watching and passing the event
on unchanged:

- `prompt.edit` fires on every keystroke in the prompt box. The mod keeps the
  draft in memory (counts and the shape timeline) and writes nothing until
  the prompt is sent or given up, so typing never waits on disk.
- `prompt.submit`, `turn.start`, `turn.complete`, `tool.call` and
  `session.compact` give the prompt, turn, tool and compaction lines.
  `turn.start` / `turn.complete` also tell it whether a turn is open, which
  is how `midTurn` and `toolsRunning` work.
- After a Bash call it runs `find` for files newer than the call's start, so
  scripts that write files still show up in Languages.
- A hot reload forgets in-memory state: a half-typed draft, or a turn that's
  already running.

## Central hub

The same server can run as a hub that everyone's mod uploads to, where each
person logs in and sees their own dashboard (an admin sees anyone's).

```sh
# on the server: keep data in /srv/hackatime, listen behind your TLS proxy
HUB_DIR=/srv/hackatime HOST=127.0.0.1 PORT=4747 NODE_ENV=production bun src/server.ts

# a token per person (only its hash is kept; prints their config.json bit)
HUB_DIR=/srv/hackatime bun scripts/hub-token.ts ada --url https://hub.example
HUB_DIR=/srv/hackatime bun scripts/hub-token.ts miggy --admin --url https://hub.example
```

Each person puts the printed bit in `~/.claude/analytics/config.json`
(`chmod 600` it, the token is a password) next to any `files` rules:

```json
{ "server": { "url": "https://hub.example", "token": "..." } }
```

The wire format is the session file itself. Files only ever grow, so the
mod sends the bytes past what the hub holds:

```
POST /v1/sessions/<sessionId>/<events|drafts>?offset=<bytes>
Authorization: Bearer <token>

<whole lines of the file, from that offset>
```

The hub appends what it doesn't have yet and answers `{"length": <bytes>}`;
an offset past its end gets `409` with its length, and the mod resends from
there. So a repeated, interrupted or duplicate send never doubles or tears a
row. The mod keeps the hub's last answer in `sent/<sessionId>.json`.

- The mod sends after each turn, without waiting for it (a slow or missing
  hub never holds anything up). The rows written at exit, and anything sent
  while offline, go up at the next session's start, which sweeps finished
  sessions it hasn't fully sent.
- A hub that's down or refusing gets one line in the mod's log per session,
  then quiet retries.
- On the hub, each person's uploads are kept in `people/<person>/`, laid out
  like `~/.claude/analytics`; `tokens.json` maps token hashes to people.
- Logging in sets an HttpOnly cookie holding the token. Uploads only take the
  `Authorization` header, so a browser can't be tricked into sending one.
- What goes up is everything in the session files, cwd and file paths
  included. Use `files` rules to keep paths out.

## How time is counted

- Every event is a moment of activity. Every main-thread turn (`turn_end` or
  `interrupt` without an `agentId`) is a span covering its full `durationMs`,
  so a long Bash call or a long think counts even though it logs nothing in
  the middle.
- Moments and spans closer together than the **idle cap** (2 to 15 min, picked
  on the page) merge into active time. Longer gaps are idle.
- Subagent turns don't add time, because they overlap the main thread. Their
  tokens still count.
- A main-thread compaction is a span of its `durationMs` too, so a `/compact`
  between turns counts as time spent. A `precompute` runs in the background
  and doesn't.
- Time is computed separately for each session and project, so a `cd` from
  one repo into another doesn't bridge them.
- Typing a prompt counts too. hook-analytics times each draft from its first
  keystroke and puts `typingMs` (pauses over 30 s left out) on the `prompt`
  line. Drafts that never get sent are logged as `draft_abandoned`. Both count
  as spans of `typingMs` ending at Enter, or at the moment the draft was given up.
- A project is named after the nearest git root above the event's `cwd`, so
  subdirectories don't split a repo. `~/.claude` shows up as `~/.claude`.
- All aggregation happens in the browser, so days and hours are local time.

## Session page

Click a project in the Sessions table to open `/session?id=<sessionId>`:

- **Session timeline:** lanes for you writing prompts (hollow when the draft
  was abandoned), Claude's turns and tool calls, with interrupts marked. Zoom
  with the + and - buttons.
- **Drafts:** every typed draft with its writing time, edits, fixes, rewrites,
  word deletes and longest pause. Click one to replay it.
- **Replay:** the prompt box rebuilt from hook-analytics' edit timeline, drawn
  as shapes. Each letter is a block and blanks and newlines are gaps, so you
  see word shapes but never the text. Play, scrub, step edit by edit (or use
  space and the arrow keys), and squash long pauses. Under it, a strip shows
  every edit over time: typing above the line, deleting below, pastes in
  green, cursor moves as small ticks.

The timelines live in `~/.claude/analytics/drafts/<sessionId>.jsonl`, one
file per session, served by `/api/session/:id`. Drafts logged before
timelines existed show their stats but no replay.

Rows are written as `v: 1`: shapes run-length encoded (`a` a letter, `_` a
blank, `n` a newline, so `5a_3a`), and steps as one string of comma
separated `<dt><kind>[@pos][-removed][+shape][:who]` tokens that leave out
whatever follows from the cursor (`12a` is one letter typed 120ms after the
last step: gaps are in 10ms ticks, rounded on the draft's own clock so the
error never adds up). `startedAt` is epoch ms and `durationMs` how long the
draft lasted; an empty starting box and `truncated: false` are left out.
`src/replay.ts` decodes it and skips rows of any other version.

Languages come from the extensions of `file_changed` paths. Tools come from
`tool` rows, with errors, denials and average duration shown in the tooltip.

## Layout

- `src/eventlog.ts`: the session file format, decode and encode
- `src/aggregate.ts`: pure summarizing, shared by the page and the tests
- `src/replay.ts`: pure draft replay (apply steps, squash pauses), shared too
- `src/load.ts`: reads every session file in `events/` and tags each event with its project
- `src/server.ts`: `Bun.serve` with both pages, `/api/events` and `/api/session/:id`; with `HUB_DIR`, the hub (login, uploads)
- `src/hub.ts`: the hub's tokens, uploads and who sees what
- `scripts/hub-token.ts`: mints a person's token
- `public/`: the pages (`index.html` + `app.ts`, `session.html` + `session.ts`, shared bits in `shared.ts`); Bun bundles them on the fly
- `scripts/fixtures.ts`: deterministic fake data for the demo
- `mod/`: the hook-analytics mod that writes the data (see Setup)
