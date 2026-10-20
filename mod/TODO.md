# hook-analytics: handoff

A function-hooks mod (Claude Code plugin) that appends one JSON line per event
to `~/.claude/analytics/events/<sessionId>.jsonl`. It's loaded in every session through
`env.CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json`. Commits so far:
`2fcda39` (add), `ac7b07e` (cwd on every line + `cwd_changed`).

## What it logs

Each session file opens with a header, `{"v":1,"event":"session","start":<epoch ms>,"cwd":...}`. Every later row has `event` and `t` (ms since `start`; `at`, epoch ms, instead if a reload couldn't read the header back). No row repeats the session id (it's the file name) or the cwd: `cwd_changed` moves it, and `file` / `path` under it are relative. A field at its usual value is left out (`DEFAULTS` in `register.ts`: tool `outcome: ok`, turn_end `reason: answer`, file_changed `via: tool`, prompt `origin: composer` / `isMeta: false`, session_start `isInteractive: true`, compact `outcome: compacted`), and so is a typed draft's counter at 0. At `session.end` both of the session's files are appended to `<id>.jsonl.gz` as one more gzip member and the plain files removed. `config.json` beside them can `include` / `exclude` file paths by glob; a left-out path drops its `file_changed` row and the `file` on its `tool` row.

| event | hook | extra fields |
|---|---|---|
| `session_start` | `session.start` (deduped across hot reloads via `$.state`) | `surface`, `isInteractive` |
| `session_end` | `session.end` | `reason` |
| `prompt` | `prompt.submit` (logged after `next`, so dropped prompts don't count) | `words`, `chars` (code points), `origin` (`composer` = typed), `command`, `isMeta`, `midTurn` (true when a main-loop turn was still running); for a typed draft also `composeMs`, `typingMs`, `edits`, `typedChars`, `pastedChars`, `deletedChars`, `fixes` (delete 3 chars or fewer, then retype), `rewrites` + `rewrittenChars` (more than 3, or typing over a selection), `pauses` (2 to 30 s gaps), `breaks` (over 30 s), `longestPauseMs`; the gap before Enter counts as a pause |
| (sidecar) `drafts/<sessionId>.jsonl` | written with each `prompt` / `draft_abandoned` that has a draft (same `draftId`) | `v: 1`, `outcome`, `startedAt` (epoch ms), `durationMs`, `initialShape` / `initialCursor` (left out when empty / 0), `steps`, `truncated` (only when true). Shapes only, run-length encoded: `a` a character, `_` a blank, `n` a newline (`5a_3a`). Steps are one string of `<dt><kind>[@pos][-removed][+shape][:who]` tokens (dt in 10ms ticks since the last step, rounded on the absolute clock, kinds t/p/r/b/d/w/k/m/c, a lone `a`/`_`/`n` is one char typed at the cursor; a missing pos is the cursor, a missing removed is 1 for b/d). Capped at 5000 steps / 50k shape chars |
| `draft_abandoned` | `prompt.edit` / `prompt.change` / `session.end` | the same draft fields, plus `how` (`clear`, `undo`, `deleted`, `exit`) and `endedAt` (epoch ms; it began `composeMs` before). Written late (at the next submit or at exit, never from a keystroke), so use `endedAt`, not `ts` |
| `turn_end` / `interrupt` | `turn.complete` (`reason: 'aborted'` → `interrupt`) | `turnId`, `agentId`, `reason`, `durationMs`, `usage`; a main-loop `interrupt` also has `answerChars` (answer shown so far, a count only) and `toolsRunning` (tool names still in flight, if any) |
| `compact` | `session.compact`, once it finishes | `trigger` (manual/auto/plugin/precompute), `agentId`, `messages` (count going in), `outcome` (compacted/skipped/threw), `tokensBefore`, `tokensAfter`, `usage`, `durationMs` |
| `tool` | `tool.call`, once it ends (a call that never ends leaves no row) | `tool`, `agentId`, `file` (built-in file tools only) / `commandChars`, `outcome`, `durationMs` |
| `file_changed` | `tool.call` | `path`, `via: tool` (Edit/Write/NotebookEdit) or `via: bash-window` |
| `cwd_changed` | inside `logAll()` whenever the cwd differs from the last row's, and once after a reload | `cwd` (the new one) |

Prompt text and file contents are never written.

## Still to do

- [ ] **Check delete keys live.** Press Ctrl+W, Ctrl+Backspace, Option/Alt+Backspace, Ctrl+U and Ctrl+K once each in a draft, send it, and check which `key` arrives and how each was classed (`jq -r '.steps | split(",")[] | select(test("^[0-9]+[wkbd]"))' ~/.claude/analytics/drafts/<session>.jsonl`).
- [ ] **Tab-out tracking.** Claude Code doesn't hand terminal focus (DEC 1004) to mods, and `ui.focus` is only focus inside its own panes. A window-manager watcher outside Claude Code could log focus changes if wanted.

- [x] **See draft tracking live.** All seen on 2026-10-20: sent prompts, a backspaced-away draft (`how: deleted`), and an Esc/Ctrl+C clear (`how: clear`, correctly not claimed by the prompt 8.7 s later). A big paste skipped `prompt.edit` entirely (the box folds it into a placeholder), which led to the leftover-chars fix below. Next real paste should show ~its length in `pastedChars`.

- [x] **See a real interrupt.** Seen live on 2026-10-20: Esc 1.4 s into a turn logged one `interrupt` (no `agentId`), and the prompt went back into the box.
- [ ] **Check Bash latency in a big repo.** Every Bash result waits for a `find` over the cwd (3 s timeout, prunes `.git`, `node_modules`, `target`, `.venv`, `venv`, `__pycache__`, `dist`, `build`). If it's noticeable, narrow the scan or skip it above some size.
- [ ] **Check the session_start dedupe live.** Edit the mod during an interactive session (hot reload) and confirm there's no second `session_start`.
- [x] **Something to read it with.** `~/Documents/GitHub/claude-hackatime`: local Bun dashboard (`bun run dev`, http://127.0.0.1:4747). It reads every file in `events/`.

## Known limits (by design, for now)

- Delete kinds are guessed from the span first, the key second: a multi-char delete reaching the line's start or end is a line kill (`k`), any other multi-char delete a word delete (`w`). So Ctrl+W on a line's first word reads as a line kill unless the key says `w`. Cursor moves (`m`) are in the timeline only and never touch the stats.
- Text already in the box when a draft starts (`initialChars`: a put-back prompt, a recall, typing from before a hot reload) doesn't count as pasted. Prompts logged before 2026-10-20 ~04:45Z may show it as pasted.

- An Esc right after sending interrupts the turn and puts the prompt back in the box. Deleting it then logs a `draft_abandoned` with `typedChars: 0`, while the prompt line stays (it was sent).
- Drafts: `typingMs` sums gaps between edits up to 30 s (plus the pause before Enter). `pastedChars` is the sent text's length beyond what edits put there (a big paste never reaches `prompt.edit`, the box folds it into a placeholder), plus any keyless insert of 32+ chars. So a recalled history entry also counts as pasted, and abandoned drafts only see the keyless-insert part. A stash (Ctrl+S) looks like a clear and logs as abandoned, and a draft put back from a stash starts a new one. A hot reload forgets the draft in progress and any abandoned drafts not written yet. Remote Control and `claude -p` prompts carry no draft fields.

- `bash-window` file changes = files under the cwd with an mtime after the Bash call started. It can't tell miggy's own edits from Claude's, misses writes outside the cwd, and catches at most 50 paths per call. `~/.claude/{projects,state,analytics,plugins}` are filtered out as noise.
- The org plugin `cc-plugin-sec-default` sits above mods and skips their `classic.SessionStart` hooks, so there's no `startup`/`resume`/`clear` source on `session_start`. Other `classic.*` events may get skipped too, so prefer engine events.
- `/clear` gives `session_end` with `reason: clear`, then lines under a new `sessionId` with no `session_start`.
- `$.session.cwd()` follows a Bash `cd`, but the `cd` call's own `tool` row still lands under the old dir. A hot reload forgets the last cwd, so it writes a `cwd_changed` before its first row even if nothing moved.
- Saving the hooks module swaps it at the next turn, not mid-turn (seen live 2026-10-20): calls in the turn that saved it still run the old code.
- This build has no MultiEdit tool. If a later one does, add it to `EDIT_TOOLS`.

## Dev loop

- `claude plugin validate ~/.claude/mods/hook-analytics`
- `claude plugin test ~/.claude/mods/hook-analytics` (tests in `hooks/register.test.ts`, mocks answer `$` calls with `{ value }`)
- type-check: once a session has loaded the mod, the engine lays types in `.claude-plugin/types/` and `tsc -p ~/.claude/mods/hook-analytics` works. The API reference is `.claude-plugin/types/claude-code/index.d.ts` (grep it for event names)
- headless smoke run from a scratch dir: `claude -p "<prompt>" --allowedTools Bash` (the prompt goes BEFORE `--allowedTools`, which swallows the args after it), then `jq -c . ~/.claude/analytics/events.jsonl`
- helpers that take `$` must be top-level functions, or validate refuses the module
- `find` in Claude's Bash shell is `bfs`, so `-newermt` gets whole-second ISO (`2026-10-19T21:32:40Z`), never `@epoch`
- `~/.claude/analytics/` stays OFF the `~/.claude` git allowlist
