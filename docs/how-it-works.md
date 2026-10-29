# How claude-hours works

The details behind the [README](../README.md): what the mod writes and where,
how the hub counts time, how the two talk, and how to run and deploy them.

## The installer

`install.sh` (served by the hub with the hub's address filled in, or run from
a clone) downloads the mod the hub was built with to
`~/.claude/claude-hours/mod`, along with a `release.json` naming that build
for `/time-track update`. From a clone, `./install.sh` (and
`./install.sh uninstall [--purge]`) uses the clone's own `mod/` folder
instead, so keep the clone where it is.

Either way the installer only edits `env.CLAUDE_CODE_PLUGIN_DIRS` in
`~/.claude/settings.json` (keeping a `settings.json.bak`), adding the mod's
folder and dropping any other copy of time-track so nothing gets
logged twice. Other plugin folders listed there are left alone.

Windows isn't supported yet: the mod writes with `tee`, `mkdir` and `find`.
Running Claude Code inside WSL works like Linux.

## Running it from a clone

1. **Get the mod.** `time-track` is a Claude Code plugin made of a
   function-hooks module, in this repo's `mod/` folder:

   ```
   mod/
     .claude-plugin/plugin.json   # name, version, description
     hooks/hooks.json             # points Claude Code at register.ts
     hooks/register.ts            # every hook; the whole mod
     hooks/register.test.ts       # tests (claude plugin test)
     types/index.d.ts             # the mod's own state type
     backfill.py                  # rebuilds older sessions from transcripts (/time-track backfill)
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

   The Hack Club Auth app is registered at https://auth.hackclub.com/developer/apps
   with the redirect uri `http://localhost:5173/auth/callback` (plus the deployed
   one).
   `bun run build` needs Bun 1.4 or newer (an older one stops before writing
   `build/`, with no error), and `bun ./build` runs what it made.
   Deploying it is [below](#deploying).

5. **Connect the mod to a hub** with `/time-track login`, as in the
   [README](../README.md#connect-it-to-the-server).

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

To leave a whole repo out, run `/time-track ignore` in a session inside it
(again to take it back). That adds its root to `"ignore": [...]` in the
config: nothing done in it is logged or sent from then on, and a file in it
touched from elsewhere loses its path like an excluded one. What was sent
before stays on the hub.

### How the mod hears things

It's all Claude Code function hooks, each one watching and passing the event
on unchanged:

- `prompt.edit` fires on every keystroke in the prompt box. The mod keeps the
  draft in memory (counts and the shape timeline) and writes nothing until
  the prompt is sent or given up, so typing never waits on disk.
- `prompt.submit`, `turn.start`, `turn.complete` and `tool.call` give the
  prompt, turn and tool lines. Compactions and the permission mode come from
  the session's transcript, grepped at each prompt and turn end, since a
  security plugin above the mod skips the events that carry them.
  `turn.start` / `turn.complete` also tell it whether a turn is open, which
  is how `midTurn` and `toolsRunning` work.
- After a Bash call it runs `find` for files newer than the call's start, so
  scripts that write files still show up in Languages (paler than the files
  Claude's edit tools wrote). A repo's gitignored files are left out, since
  they're build output and caches.
- A hot reload forgets in-memory state: a half-typed draft, or a turn that's
  already running.

## The hub

`src/` is the hub: a SvelteKit app on Postgres, where people log in with
their Hack Club account, connect the mod with a device code and see their
time on the dashboard (overview, timeline, and a page per session with draft
replays). People see only their own data; admins (`ADMIN_EMAILS`) can pick
anyone's. How the mod's rows get there is the
[sync protocol](#sync-protocol-v1).

Session files from before the login, or from another computer, can go up
with `HUB=<url> TOKEN=hct_... bun scripts/import.ts [dir]`; the hub keeps each
row once, so sending something twice is fine.

### Backfilling from transcripts

Sessions from before time-track was installed can be rebuilt from Claude
Code's own transcripts (`~/.claude/projects`). `/time-track backfill` runs the
mod's `backfill.py` (python3, which the installer needs anyway), which writes
them as session files to `~/.claude/analytics/backfill/events` and says how
many it found; `/time-track backfill send` then sends them like the mod's own
rows, keeping track in `backfill/sent`. It only reaches back as far as the
transcripts do, `cleanupPeriodDays` (30 by default), and leaves out sessions
still going. A file it wrote stays once its transcript is gone, and the same
transcripts give the same rows, so running it again is fine.

A transcript has each turn's `durationMs`, the tool calls, compactions,
interrupts, the permission mode and the tokens, so `backfill.py` turns it into
the rows the mod would have logged. `config.json`'s `ignore` and file globs
apply the same way, and only counts come out, never text. What it can't have:
typing (no drafts, so no `typingMs`), when the session was opened and closed,
permission dialogs inside a call (they stay part of it), and files a Bash
command changed. So a backfilled session comes out a little under what the mod
would have counted, most of it the typing. A turn that never ends (an Esc
right after sending, a call turned down) is an `interrupt` up to its last work
before a silence over 15 minutes, and so is one Esc'd after such a silence (a
request left hanging while the laptop slept). Only the terminal writes a
`turn_duration` line, so in the VS Code extension, the desktop app or the SDK
a turn whose last message from Claude finished (`stop_reason: end_turn`) is a
`turn_end` instead, at that same last work. A call turned down is `denied`, where the
mod's own rows say `error`.

Each backfilled run's header says `backfill: 3` (the hub turns down a new run
saying `1`, from the version that stretched a turn Esc'd days after it hung
over all those days, or `2`, which called every answered turn outside the
terminal an interrupt, and asks for `/time-track update`), its events carry
`backfill: true` once decoded, and the session page says it was rebuilt. A
session the mod logged too is cut where the mod's log begins (less 2 s, for
the prompt that woke it), twice over: `backfill.py` stops there when the mod's
file is on this computer, and `decodeSession` drops a backfilled row from
there on whenever the session has a run of the mod's own, so a backfill made
after `uninstall --purge` doesn't count anything twice either.

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
- Moments and spans closer together than the **idle cap** merge into active
  time. Longer gaps are idle. Each person picks their own on `/settings`
  (1, 2, 5, 10 or 15 min; 2 until they do), and their dashboard counts with
  theirs, an admin looking at it too.
- Waiting on you isn't Claude working: a main-thread `AskUserQuestion` or
  `ExitPlanMode` call, or a permission dialog (the turn's `waits`). Claude
  Code already leaves these out of the turn's `durationMs`, so a turn with one
  in it is laid out back from its end, stepping over the wait. The wait is
  then a gap like the one before your next prompt: under the idle cap it
  still counts, over it it's idle. The session timeline shows it on the You
  lane.
- Time goes to the repo the work is in, not just the session's. Each thread
  (the main one, or a subagent) starts in the cwd's project, and a tool call
  that writes a file in another git repo, or a Bash command that `cd`s into
  one, moves that thread there until a call works back home (any Bash with
  no `cd`, or a file written under the cwd). Files in no repo at all don't
  move it, and neither does reading a file (that's looking, not working
  there) or anything in Claude Code's own `~/.claude/projects` (its memory,
  a long output it saved to read back), so the hub counts those where the
  thread already was, whatever the mod's rows say.
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
- Wall-clock time counts once. A stretch several sessions were active at once
  (three tabs, say) goes only to the one in the foreground: the one you last
  started typing a prompt in, sent or not. One left working in another tab
  meanwhile adds nothing then, and a notification arriving isn't you turning
  to it. Where you hadn't typed in any of them yet, they split it evenly. A
  session's own page still shows all of its time.
- Typing a prompt counts too. time-track times each draft from its first
  keystroke and puts `typingMs` (pauses over 30 s left out) on the `prompt`
  line. Drafts that never get sent are logged as `draft_abandoned`. Both count
  as spans of `typingMs` ending at Enter, or at the moment the draft was given up.
- The overview can count only prompts instead (`/api/summary?time=prompts`),
  the way Hackatime counts heartbeats: each prompt you wrote and each draft
  you gave up is a span of its typing, and it also gets the gap before it
  (from the last prompt in any session), up to the idle cap. So a break
  still counts the cap, a gap between prompts in two repos goes to the
  later one, and nothing counts after the last prompt. Unlike Hackatime,
  the very first prompt gets the cap before it too, as if after a break,
  so a range's time only ever depends on prompts near it. Claude's turns, tool calls and notifications make no time then, though
  they still say which repo a thread was in. A backfilled prompt has no
  typing, so it's just the moment it was sent. Models' time stays Claude's,
  and project colors are still ranked by all of the time.
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

## Sync protocol (v1)

The mod sends what its session files hold, row by row, and the hub keeps
each row once however often it arrives.

### Row identity

A session's events file, read as one stream (the `.gz` members, then the
plain file), is a list of runs: every `{"event":"session",...}` header starts
one, at a new session or a resume. A run is keyed by its header's `start`, and
a row by its index `n` within its run (the header itself isn't counted). The
drafts sidecar has no headers, so it's one run keyed `0`, and `n` is the line.
So the live mod and an import of old files key every row the same way, and a
broken stretch of one run can't renumber the next.

### Sending

```
POST /v1/events
User-Agent: time-track/<version>
X-Protocol: 1
Authorization: Bearer hct_...
Content-Type: application/json
(Content-Encoding: gzip, optional)

{ "runs": [
  { "session": "<id>", "stream": "events", "run": 1792472272642, "header": { ... }, "from": 0, "rows": [ ... ] },
  { "session": "<id>", "stream": "drafts", "run": 0, "from": 12, "rows": [ ... ] }
] }
```

- One request can carry runs from many sessions (the first sync sends all of
  history). Each run's `rows` start at index `from`.
- The hub holds `acked` rows of each run, always a contiguous prefix. With
  `from` past `acked` it stores nothing and answers `gap`; otherwise it skips
  the rows it has and stores the rest. Either way the answer says the new
  `acked`, and the client sends from there next time:

```
{ "runs": { "<session>/<stream>/<run>": { "status": "ok" | "gap", "acked": 40 } }, "quarantined": 0 }
```

- A row that isn't a JSON object with an `event` (events) or a `draftId`
  (drafts) goes to the `_quarantine` table and still counts toward `acked`, so one
  bad row never blocks a run. A field whose value doesn't fit its column's
  type is kept in the row's `extra` instead.
- `400`: bad body, or an `X-Protocol` the hub doesn't speak (the answer lists
  `protocols`). `401`: the token is unknown or revoked, log in again. `413`:
  over 4 MB or 5000 rows, send half. `GET /v1/hello` says the protocols and
  limits.

### Storing

A `_runs` row per run (person, session, stream, start, the header's fields,
`acked`, and the device that started it, which the session page names;
revoking a device only sets its `revoked_at`, so that name stays), then one table per event type (`_prompts`, `_tool_calls`, ...) with
a typed column per known field plus an `extra jsonb` for anything else, keyed
by run and `n`. Draft timelines get a table of their own (`_draft_timelines`),
and refused rows go to `_quarantine`. Everything the mod sends is in a table
with a leading `_`, so it sorts apart from the accounts. Reading a session back rebuilds its rows exactly as
the mod wrote them, so the hub decodes them with the same code the old
dashboard used.

### The mod's side

`/time-track login <hub>` checks `GET /v1/hello`, starts the device flow
and answers at once with the link (built from the url typed, not the hub's
`verification_uri`, which a hub behind a proxy may get wrong). A poll behind
it saves `server` in `config.json` (written under `umask 077`, the rest of the
config kept), then sends everything not sent. `logout` drops it and calls
`DELETE /v1/me`, which revokes that token (as JSON: SvelteKit refuses a
bodyless DELETE as a cross-site form). `status` asks `GET /v1/me`, and
`stats` asks `GET /v1/stats?tz=<the computer's zone>`: today, the last 7 days
with their top three projects, and all time, counted by the same `digest` as
the dashboard (`src/lib/server/stats.ts`).
`/v1/hello` also names the mod the hub hands out, `mod: { version, files }`,
the version a hash of its files taken when the hub is built (`installer()` in
`vite.config.ts`). install.sh saves it as `.claude-plugin/release.json` beside
the mod; at session start a mod with one toasts when the hub's differs, and
`update` downloads every file in `files` from `/install/mod/` before writing
any, `release.json` last. A clone has no `release.json`, so it's never
touched.
`login <hub> <code>` takes a code made on the hub's settings page instead:
the hub makes it approved from the start (`loginCode`), so the mod swaps it
at `POST /v1/device/token` once, sending its hostname as `device_name` to
name the device.

The hub serves its own installer: `GET /install.sh` is `install.sh` with
`hub=''` filled in, and `GET /install/<file>` hands out the mod's files and
`scripts/settings.py`, built in with `?raw` imports (the repo's private, so
the installer can't fetch them from GitHub). The script puts the mod in
`~/.claude/claude-hours/mod`.

After every main-loop turn the mod sends its session's new rows, and at
session start a sweep sends finished sessions not all in. `sent/<session>.json`
keeps, for one hub url, how many lines of each stream are in, the run the
events stream is in there (its start, header and `acked`), and once a
finished session is all in its `.gz` sizes so the sweep can skip it. Each send
reads from that line on, at most 4000 lines and 256 KB, so a read never hits
`process.run`'s 4 MiB cap and a request stays under the server's default
512 KB body. A run answered short (a gap: the hub lost rows, or holds less
than this file says) starts that stream over from line 0 once, and the hub
skips what it has. A 401 says to log in again, once. Files from the old byte-offset protocol
(no `"v": 2`) count as nothing sent.

## Deploying

- The `Dockerfile` builds and runs with bun (1.4 or newer, which adapter-bun
  needs). Each start runs `scripts/migrate.js` first (drizzle-orm's migrator,
  no drizzle-kit), so a new database gets its tables and a deploy brings an
  old one up to date. It sets `PORT=3000`, `BODY_SIZE_LIMIT=4M` and the
  `x-forwarded-*` headers below. Without the image, run `bun run db:migrate`
  (with `DATABASE_URL` set) before starting a new version; the app doesn't
  migrate on its own.
- `vite build` needs no secrets. `DATABASE_URL`, `HCA_CLIENT_ID` and
  `HCA_CLIENT_SECRET` are checked when the server starts, and it refuses to
  boot without them.
- adapter-bun has no `ORIGIN` env. The origin comes from the request: the
  `Host` header, and `https` unless `PROTOCOL_HEADER` names a header that says
  otherwise. Behind a TLS proxy that keeps `Host`, that's already right.
  Otherwise set `paths.origin` in `vite.config.ts`, or
  `HOST_HEADER`/`PROTOCOL_HEADER` (e.g.
  `x-forwarded-host`/`x-forwarded-proto`).
- Rate limits live in memory, so they assume one server process.
- Set `BODY_SIZE_LIMIT=4M` to take what `GET /v1/hello` says it takes. The
  mod stays under the default 512K either way; `scripts/import.ts` needs
  more.

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
- `mod/`: the time-track mod that writes the data (see Running it from a clone)
