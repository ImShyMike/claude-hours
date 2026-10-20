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
- A project is named after the nearest git root above the event's `cwd`, so
  subdirectories don't split a repo. `~/.claude` shows up as `~/.claude`.
- All aggregation happens in the browser, so days and hours are local time.

Languages come from the extensions of `file_changed` paths. Tools come from
`tool_end`, with errors, denials and average duration shown in the tooltip.

## Layout

- `src/aggregate.ts`: pure parsing and summarizing, shared by the page and the tests
- `src/load.ts`: reads every `events*.jsonl` and tags each event with its project
- `src/server.ts`: `Bun.serve` with the page and `/api/events`
- `public/`: the page; Bun bundles `app.ts` on the fly
- `scripts/fixtures.ts`: deterministic fake data for the demo
