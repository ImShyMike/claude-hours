# claude-hours

A Hackatime-style dashboard for the time spent coding with Claude Code. The
`time-track` mod writes JSONL logs to `~/.claude/analytics/events/`, one
file per session, and the hub is where people log in with their Hack Club
account to see their time.

## Setup

There are two halves: the mod, which records, and the hub, which shows.

### Quick install (macOS and Linux)

Needs Claude Code, `curl` and `python3` (on macOS it comes with the Command
Line Tools, same as `git`). The hub's settings page has both commands ready
to copy. From a hub, no clone needed:

```sh
curl -fsSL https://your-hub.example/install.sh | sh                          # install, or update
curl -fsSL https://your-hub.example/install.sh | sh -s uninstall           # stop loading it, keep your data
curl -fsSL https://your-hub.example/install.sh | sh -s uninstall --purge   # ...and delete ~/.claude/analytics
```

That downloads the mod the hub was built with to `~/.claude/claude-hours/mod`
(rerunning it updates the mod). Then start a new Claude Code session and
paste in a login command from the hub's settings page
(`/time-track login https://your-hub.example <code>`, good once for 10
minutes).

From a clone, `./install.sh` (and `./install.sh uninstall [--purge]`) does
the same with the clone's own `mod/` folder, so keep the clone where it is.

Either way the installer only edits `env.CLAUDE_CODE_PLUGIN_DIRS` in
`~/.claude/settings.json` (keeping a `settings.json.bak`), adding the mod's
folder and dropping any other copy of time-track so nothing gets
logged twice. Other plugin folders listed there are left alone.

Windows isn't supported yet: the mod writes with `tee`, `mkdir` and `find`.
Running Claude Code inside WSL works like Linux.

### By hand

1. **Get the mod.** `time-track` is a Claude Code plugin made of a
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
   { "env": { "CLAUDE_CODE_PLUGIN_DIRS": "~/path/to/claude-hours/mod" } }
   ```

   For a one-off try, `claude --plugin-dir ~/path/to/claude-hours/mod`
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

4. **Run the hub.** Install [Bun](https://bun.sh) and Docker, then in this
   repo:

   ```sh
   bun install
   docker compose up -d      # Postgres on localhost:5434
   cp .env.example .env      # then fill in the Hack Club Auth app
   bun run db:migrate
   bun run dev               # http://localhost:5173
   bun run test              # needs no Postgres, the tests use PGlite
   ```

   More on the hub, deploying it included, in
   [docs/rewrite.md](docs/rewrite.md).

5. **Connect the mod to a hub.** In Claude Code:

   ```
   /time-track login https://your-hub.example
   ```

   It answers with a link and a code; approve it there and this computer
   starts sending, history included (every finished session not sent yet
   goes up in the background). A login command copied from the hub's
   settings page carries a code approved already
   (`/time-track login <hub> <code>`), so that one logs in straight
   away. `/time-track status` says who it's logged
   in as, `/time-track stats` shows today's time, the last 7 days' (with
   the top projects) and all time's, and `/time-track logout` forgets the
   token here and on the hub.

## Where things live

```
~/.claude/analytics/
  events/<sessionId>.jsonl     # one JSON line per event, one file per session
  events/<sessionId>.jsonl.gz  # the same, once the session has ended
  drafts/<sessionId>.jsonl     # draft edit timelines for the replay, same split
  drafts/<sessionId>.jsonl.gz
  config.json                  # optional: which files get logged, and the hub login
  sent/<sessionId>.json        # how much of each session the hub holds
```

- **Nothing here holds prompt text.** Prompts are logged as counts (words,
  chars, typing time, edits). Draft timelines keep shapes only: where letters,
  blanks and newlines were, never which letters. An interrupt records how many
  characters of the answer had shown, not the answer.
- **It does hold local paths:** the session's `cwd`, plus the files tools
  touched (`file_changed`). That's why nothing syncs until you say so.
- **Nothing leaves the machine until you log in to a hub.** The mod appends
  with `tee -a`. After `/time-track login`, the rows go to that hub after
  every turn (see The hub). The token sits in `config.json`, readable only by
  you.
- **It splits itself.** Each session gets its own small file, so there's no
  one log to rotate. Delete old session files to forget them.
- **Ended sessions are gzipped.** When a session exits, the mod appends its
  files to `<id>.jsonl.gz` and removes the plain ones. A resumed session
  starts a fresh `.jsonl` next to the `.gz`, and the next exit appends another
  gzip member, so `zcat` shows the whole thing. `load.ts` reads both.
- Deleting the files is safe: the next event recreates them. Keep the
  folders, though; the mod only creates them once per session.

### What gets logged

A session file opens with a header, `{"v":1,"event":"session","start":<epoch
ms>,"cwd":...}`. After it, every row has `event` and `t`, ms since that start,
and nothing repeated: the file name is the session, a `cwd_changed` row says
when the cwd moves, and paths under the cwd are written relative to it. The
header and `cwd_changed` also carry `root`, the repo's folder, when the cwd
is below it (or in a worktree of it), so the hub can name the project, and
`rootName` when the repo's origin remote calls it something else than its
folder (a clone into a scratch folder, say). A `tool` row's `repo` gets a
`repoName` the same way. A
field at its usual value is left out too (`outcome: "ok"`, `via: "tool"`,
`origin: "composer"` and friends, plus a typed draft's counters at 0), and
the decoder puts them back.

```json
{"v":1,"event":"session","start":1792472272642,"cwd":"/home/me/code/terra"}
{"t":0,"event":"session_start","surface":"terminal","isInteractive":true}
{"t":48211,"event":"tool","tool":"Edit","file":"src/db.ts","durationMs":31}
{"t":48212,"event":"file_changed","tool":"Edit","path":"src/db.ts"}
```

`src/lib/analytics/eventlog.ts` decodes it back to flat events and skips files in any other
format. The full field list is in the mod's `TODO.md`; the short version:

| event | when |
| --- | --- |
| `session_start` / `session_end` | a session opens or exits |
| `prompt` | a prompt is sent: word and char counts, who sent it (`origin`), `midTurn` if Claude was still working, and for a typed one the draft stats (typing time, fixes, rewrites, pauses, `draftId`) |
| `draft_abandoned` | a typed draft was cleared, undone, deleted or left at exit without being sent |
| `turn_end` / `interrupt` | a turn finished, or was stopped with Esc (`answerChars` and `toolsRunning` say what got cut off); `waits` lists its permission dialogs as `[ms before the end it opened, ms open, tool]` |
| `compact` | a compaction finished: trigger, tokens before and after, how long it took |
| `tool` | a tool call finished, with outcome and duration (its row is written at the end, so it began `durationMs` earlier); `repo` is the git root it worked in when that's not the cwd's (a file elsewhere, or a Bash command starting `cd other-repo`) |
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

## The hub

`src/` is the hub: a SvelteKit app on Postgres, where people log in with
their Hack Club account, connect the mod with a device code and see their
time on the dashboard (overview, timeline, and a page per session with draft
replays). People see only their own data; admins (`ADMIN_EMAILS`) can pick
anyone's. [docs/rewrite.md](docs/rewrite.md) has the sync protocol, how to
deploy it, and what's done. [docs/old-dashboard.md](docs/old-dashboard.md)
describes the dashboard's pages.

Session files from before the login, or from another computer, can go up
with `HUB=<url> TOKEN=hct_... bun scripts/import.ts [dir]`; the hub keeps each
row once, so sending something twice is fine.

### Draft timelines

Replays are built from `~/.claude/analytics/drafts/<sessionId>.jsonl`, one
file per session. Drafts logged before timelines existed have their stats but
no replay.

Rows are written as `v: 1`: shapes run-length encoded (`a` a letter, `_` a
blank, `n` a newline, so `5a_3a`), and steps as one string of comma
separated `<dt><kind>[@pos][-removed][+shape][:who]` tokens that leave out
whatever follows from the cursor (`12a` is one letter typed 120ms after the
last step: gaps are in 10ms ticks, rounded on the draft's own clock so the
error never adds up). `startedAt` is epoch ms and `durationMs` how long the
draft lasted; an empty starting box and `truncated: false` are left out.
`src/lib/analytics/replay.ts` decodes it and skips rows of any other version.

## How time is counted

- Every event is a moment of activity. Every main-thread turn (`turn_end` or
  `interrupt` without an `agentId`) is a span covering its full `durationMs`,
  so a long Bash call or a long think counts even though it logs nothing in
  the middle.
- Moments and spans closer together than the **idle cap** (2 to 15 min, one
  for everyone, set by an admin on the hub's `/admin`; 5 until then) merge
  into active time. Longer gaps are idle.
- Waiting on you isn't Claude working: a main-thread `AskUserQuestion` or
  `ExitPlanMode` call, or a permission dialog (the turn's `waits`). Claude
  Code already leaves these out of the turn's `durationMs`, so a turn with one
  in it is laid out back from its end, stepping over the wait. The wait is
  then a gap like the one before your next prompt: under the idle cap it
  still counts, over it it's idle. The session timeline shows it on the You
  lane.
- Time goes to the repo the work is in, not just the session's. Each thread
  (the main one, or a subagent) starts in the cwd's project, and a tool call
  that touches a file in another git repo, or a Bash command that `cd`s into
  one, moves that thread there until a call works back home (any Bash with
  no `cd`, or a file under the cwd). Files in no repo at all don't move it.
- A subagent's turn adds time only where it works away from the main
  thread's project, like a fork sent off to another codebase. Then both
  projects get that stretch in full, while the total, days and hours count
  it once. Alongside the main thread it adds nothing, since the main turn
  covers it. Subagent tokens always count.
- An idle gap is only bridged if nothing else was going on in it: time spent
  in another project isn't idle in this one.
- A main-thread compaction is a span of its `durationMs` too, so a `/compact`
  between turns counts as time spent. A `precompute` runs in the background
  and doesn't.
- Time is computed separately for each session and project, so a `cd` from
  one repo into another doesn't bridge them.
- Typing a prompt counts too. time-track times each draft from its first
  keystroke and puts `typingMs` (pauses over 30 s left out) on the `prompt`
  line. Drafts that never get sent are logged as `draft_abandoned`. Both count
  as spans of `typingMs` ending at Enter, or at the moment the draft was given up.
- A project is named after the nearest git root above the event's `cwd` (or
  above the file or `repo` it worked in), so subdirectories don't split a
  repo. A worktree (like a subagent's under `.claude/worktrees`) counts as
  the repo it was made from, and a repo whose origin remote has another name
  than its folder goes by the remote's. `~/.claude` shows up as `~/.claude`. On a hub,
  where the paths are someone else's disk, it's the folder of the `root` the
  mod sent, else the cwd's own folder, and only the mod's `repo` moves time.
  A folder with no repo to be found (renamed away since, say) under where the
  session started counts as the session's project.
- Days and hours are local time. The old dashboard summed in the browser;
  the hub will need each person's time zone.
- The per-day and time-of-day columns are stacked by project. A stretch two
  projects worked at once is split evenly between them there, so each column
  still adds up to its total.

## Layout

- `src/routes/(app)/`: the dashboard (overview, timeline, session), settings, admin and the device approval page (Tailwind and shadcn-svelte); the dashboard's pieces are in `src/lib/dashboard/ui/`, what they draw is worked out in `src/lib/dashboard/`
- `src/routes/api/`: what the dashboard reads; `src/routes/v1/`: what the mod talks to
- `src/lib/server/`: sessions, Hack Club Auth, the device flow, deletion requests
- `src/lib/server/ingest.ts` and `history.ts`: storing what the mod sends, and reading it back as session files
- `src/lib/server/db/`: the Drizzle schema; migrations are in `drizzle/`
- `src/lib/analytics/eventlog.ts`: the session file format, decode and encode
- `src/lib/analytics/aggregate.ts`: pure summarizing (how time is counted)
- `src/lib/analytics/replay.ts`: pure draft replay (apply steps, squash pauses)
- `src/lib/analytics/load.ts`: reads every session file in `events/` and tags each event with its project
- `src/lib/analytics/runs.ts`: a session file as the sync protocol's runs
- `scripts/fixtures.ts`: deterministic fake data (`bun scripts/fixtures.ts` writes it to `fixtures/`)
- `scripts/import.ts`: sends a folder of session files to a hub
- `mod/`: the time-track mod that writes the data (see Setup)
