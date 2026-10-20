# claude-hackatime

A local, Hackatime-style dashboard for the time spent coding with Claude Code.
It reads the JSONL log that the `hook-analytics` mod writes to
`~/.claude/analytics/events*.jsonl`.

## Setup

There are two halves: the mod, which records, and this repo, which shows.

1. **Get the mod.** `hook-analytics` is a Claude Code plugin made of a
   function-hooks module. It lives outside this repo, at
   `~/.claude/mods/hook-analytics/`:

   ```
   hook-analytics/
     .claude-plugin/plugin.json   # name, version, description
     hooks/register.ts            # every hook; the whole mod
     hooks/register.test.ts       # tests (claude plugin test)
     TODO.md                      # what it logs, field by field, and open todos
   ```

2. **Load it in every session.** Point Claude Code at the folder in
   `~/.claude/settings.json`:

   ```json
   { "env": { "CLAUDE_CODE_PLUGIN_DIRS": "~/.claude/mods/hook-analytics" } }
   ```

   For a one-off try, `claude --plugin-dir ~/.claude/mods/hook-analytics`
   works too. Start a new session; a `session_start` line in
   `~/.claude/analytics/events.jsonl` means it's recording. Editing
   `register.ts` hot-reloads it in running sessions.

3. **Check the mod** (optional, after editing it):

   ```sh
   cd ~/.claude/mods/hook-analytics
   claude plugin test        # its tests
   claude plugin validate .  # the manifest
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
  events.jsonl                 # one JSON line per event, every session
  drafts/<sessionId>.jsonl     # draft edit timelines for the replay, one file per session
```

- **Nothing here holds prompt text.** Prompts are logged as counts (words,
  chars, typing time, edits). Draft timelines keep shapes only: where letters,
  blanks and newlines were, never which letters. An interrupt records how many
  characters of the answer had shown, not the answer.
- **It does hold local paths:** every line's `cwd`, plus the files tools
  touched (`file_changed`). That's why the server stays on localhost.
- **Nothing leaves the machine.** The mod appends with `tee -a`; the dashboard
  reads the files on every request and does all the math in the browser.
- **Nothing is rotated yet.** The log grows forever (it's small, roughly a
  few hundred bytes per tool call). The reader already globs `events*.jsonl`,
  so renaming an old file to `events-2026-10.jsonl` keeps it counted.
- Deleting the files is safe: the next event recreates them. Keep the
  folders, though; the mod only creates them once per session.

### What gets logged

Every line has `ts`, `sessionId`, `cwd` and `event`. The full field list is
in the mod's `TODO.md`; the short version:

| event | when |
| --- | --- |
| `session_start` / `session_end` | a session opens or exits |
| `prompt` | a prompt is sent: word and char counts, who sent it (`origin`), `midTurn` if Claude was still working, and for a typed one the draft stats (typing time, fixes, rewrites, pauses, `draftId`) |
| `draft_abandoned` | a typed draft was cleared, undone, deleted or left at exit without being sent |
| `turn_end` / `interrupt` | a turn finished, or was stopped with Esc (`answerChars` and `toolsRunning` say what got cut off) |
| `compact` | a compaction finished: trigger, tokens before and after, how long it took |
| `tool_start` / `tool_end` | each tool call, with outcome and duration |
| `file_changed` | a file edited by a tool, or changed during a Bash call |
| `cwd_changed` | the session's working directory moved |

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
whatever follows from the cursor (`120a` is one letter typed 120ms after the
last step). `src/replay.ts` decodes it and skips rows of any other version.

Languages come from the extensions of `file_changed` paths. Tools come from
`tool_end`, with errors, denials and average duration shown in the tooltip.

## Layout

- `src/aggregate.ts`: pure parsing and summarizing, shared by the page and the tests
- `src/replay.ts`: pure draft replay (apply steps, squash pauses), shared too
- `src/load.ts`: reads every `events*.jsonl` and tags each event with its project
- `src/server.ts`: `Bun.serve` with both pages, `/api/events` and `/api/session/:id`
- `public/`: the pages (`index.html` + `app.ts`, `session.html` + `session.ts`, shared bits in `shared.ts`); Bun bundles them on the fly
- `scripts/fixtures.ts`: deterministic fake data for the demo
