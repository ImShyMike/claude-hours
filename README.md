# claude-hackatime

A local, Hackatime-style dashboard for the time spent coding with Claude Code.
It reads the JSONL log that the `hook-analytics` mod writes to
`~/.claude/analytics/events*.jsonl`.

```sh
bun run dev     # http://127.0.0.1:4747, reads ~/.claude/analytics
bun run demo    # generates fake events into fixtures/ and serves those
bun run test
```

No dependencies, just Bun. The server only binds to `127.0.0.1`, since the
events contain local paths. Set `ANALYTICS_DIR` and `PORT` to override the
defaults. Add `?theme=dark` or `?theme=light` to the URL to pin the theme.

## How time is counted

- Every event is a moment of activity. Every main-thread turn (`turn_end` or
  `interrupt` without an `agentId`) is a span covering its full `durationMs`,
  so a long Bash call or a long think counts even though it logs nothing in
  the middle.
- Moments and spans closer together than the **idle cap** (2 to 15 min, picked
  on the page) merge into active time. Longer gaps are idle.
- Subagent turns don't add time, because they overlap the main thread. Their
  tokens still count.
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

Languages come from the extensions of `file_changed` paths. Tools come from
`tool_end`, with errors, denials and average duration shown in the tooltip.

## Layout

- `src/aggregate.ts`: pure parsing and summarizing, shared by the page and the tests
- `src/replay.ts`: pure draft replay (apply steps, squash pauses), shared too
- `src/load.ts`: reads every `events*.jsonl` and tags each event with its project
- `src/server.ts`: `Bun.serve` with both pages, `/api/events` and `/api/session/:id`
- `public/`: the pages (`index.html` + `app.ts`, `session.html` + `session.ts`, shared bits in `shared.ts`); Bun bundles them on the fly
- `scripts/fixtures.ts`: deterministic fake data for the demo
