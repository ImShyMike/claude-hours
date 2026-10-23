# The hub rewrite

The hub (SvelteKit with shadcn-svelte, Drizzle on stock Postgres) is the whole
repo now, next to the mod in `mod/`. It replaced the old Bun server, its
`public/` dashboard and its token script, which are still on `main`. The
parsing they used was carried over into `src/lib/analytics/`, and the
dashboard's pages into `src/lib/dashboard/`, drawn as shadcn-svelte
pages in `src/routes/(app)/` (overview, timeline and session) that move
between each other without a page load.
[old-dashboard.md](old-dashboard.md) describes those pages.

## Running it

```sh
docker compose up -d      # Postgres on localhost:5434
cp .env.example .env      # then fill in the HCA app
bun run db:migrate
bun run dev
```

The Hack Club Auth app is registered at https://auth.hackclub.com/developer/apps
with the redirect uri `http://localhost:5173/auth/callback` (plus the deployed
one).

The tests need no server, the database ones run on PGlite. `bun run test` runs
vitest over `src/` and `bun test` over the installer's tests in `scripts/`;
the mod has its own (`claude plugin test mod`).

```sh
bun run test && bun run check
```

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
User-Agent: hook-analytics/<version>
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
`acked`), then one table per event type (`_prompts`, `_tool_calls`, ...) with
a typed column per known field plus an `extra jsonb` for anything else, keyed
by run and `n`. Draft timelines get a table of their own (`_draft_timelines`),
and refused rows go to `_quarantine`. Everything the mod sends is in a table
with a leading `_`, so it sorts apart from the accounts. Reading a session back rebuilds its rows exactly as
the mod wrote them, so the hub decodes them with the same code the old
dashboard used.

### The mod's side

`/hook-analytics login <hub>` checks `GET /v1/hello`, starts the device flow
and answers at once with the link (built from the url typed, not the hub's
`verification_uri`, which a hub behind a proxy may get wrong). A poll behind
it saves `server` in `config.json` (written under `umask 077`, the rest of the
config kept), then sends everything not sent. `logout` drops it and calls
`DELETE /v1/me`, which revokes that token (as JSON: SvelteKit refuses a
bodyless DELETE as a cross-site form). `status` asks `GET /v1/me`.
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
`process.run`'s 4 MiB cap and a request stays under node's default 512 KB
body. A run answered short (a gap: the hub lost rows, or holds less than this
file says) starts that stream over from line 0 once, and the hub skips what it
has. A 401 says to log in again, once. Files from the old byte-offset protocol
(no `"v": 2`) count as nothing sent.

### Where this differs from what we sketched

- A run is keyed by its header's `start`, not a random id in a new `v: 2`
  header. Every run already has a header, so the file format doesn't change,
  and imports key rows the way the mod does without a hash.
- Drafts are one run per session keyed by line, not by `draftId`: ids are
  first-edit time plus text length, unique in practice but not by
  construction.
- The manifest stays per session in `sent/`, not one `sync.json`, since
  sessions running side by side would race on one file. No byte hints on the
  wire; the mod's own cursor counts lines.
- The startup sweep sends session by session, not one batch across them.
- The mod doesn't gzip (its fetch takes a string body); the hub takes gzip
  from anyone else.
- The hub sums, not the browser: `/api/summary?from&to&tz` answers the
  range's summary (days and hours in the viewer's zone) and what all time
  decides (project colors, the calendar, each session's home), and
  `/api/session/:id` one session's events and draft timelines. Each session's
  decoded events are kept in memory until one of its runs moves (`acked`,
  `updated_at`), so a refresh re-reads only the session being worked in. The
  idle cap is one hub-wide setting (the `settings` table, set on `/admin`),
  where the old dashboard let each viewer pick theirs.

## Deploying

- The `Dockerfile` builds with bun and runs on node. Each start runs
  `scripts/migrate.js` first (drizzle-orm's migrator, no drizzle-kit), so a
  new database gets its tables and a deploy brings an old one up to date. It
  sets `PORT=3000`, `BODY_SIZE_LIMIT=4M` and the `x-forwarded-*` headers
  below. Without the image, run `bun run db:migrate` (with `DATABASE_URL`
  set) before starting a new version; the app doesn't migrate on its own.
- `vite build` needs no secrets. `DATABASE_URL`, `HCA_CLIENT_ID` and
  `HCA_CLIENT_SECRET` are checked when the server starts, and it refuses to
  boot without them.
- adapter-node 6 has no `ORIGIN` env anymore. The origin comes from the
  request: the `Host` header, and `https` unless `PROTOCOL_HEADER` names a
  header that says otherwise. Behind a TLS proxy that keeps `Host`, that's
  already right. Otherwise set `paths.origin` in `vite.config.ts`, or
  `HOST_HEADER`/`PROTOCOL_HEADER` (e.g. `x-forwarded-host`/`x-forwarded-proto`).
- Rate limits live in memory, so they assume one server process.
- Set `BODY_SIZE_LIMIT=4M` to take what `GET /v1/hello` says it takes. The
  mod stays under node's default 512K either way; `scripts/import.ts` needs
  more.

## Milestone 1: accounts and devices

- [x] The hub at the repo root, the old server gone, its parsing kept
- [x] Schema: people, sessions, device codes, device tokens, deletion requests
- [x] Hack Club Auth login (OIDC code flow, state and nonce), sessions, logout
- [x] Admins from `ADMIN_EMAILS`, matched against a verified email per request
- [x] Device flow: `POST /v1/device/code`, `POST /v1/device/token`, `/device`
      approve/deny page, `GET /v1/me`
- [x] Settings: list and revoke devices, request or withdraw deletion
- [x] Admin: people, approve or reject deletion requests
- [x] Tests on PGlite; checked live against Postgres and a browser
- [ ] First real Hack Club Auth login (needs the registered app): check the
      claims that arrive, `email_verified` above all, since admin depends on it

## Milestone 2: syncing and the dashboard

- [x] Sync protocol v1: `POST /v1/events`, `GET /v1/hello`, a typed table per
      event plus `extra`, quarantine
- [x] Reading it back as session files, so the old parsing decodes it
      (round trip checked on the fixtures and on real data)
- [x] `scripts/import.ts` for old session files
- [x] Dashboard: overview, timeline and session pages, ported from `main`;
      summed on the hub (`/api/summary`, `/api/session/:id`), equal to what
      the old dashboard summed from the same files; an admin picks whose to
      see
- [x] The mod: `/hook-analytics login | status | logout`, after-turn sync and
      the startup sweep on protocol v1
- [x] `curl <hub>/install.sh | sh` and copyable login commands on settings
- [x] The mod's requests (captured from its own code under the test engine)
      replayed into `node build`: every run acked as expected, and the data
      the same as the import path's
- [ ] A real session with the mod loaded from this branch, logged in to a
      deployed hub
- [ ] Settings could show how much the hub holds (`rowsHeld` is there)

## Next

- What approving a deletion actually deletes, and whether a tombstone stays
- Server-side summaries, so the dashboard stops fetching every event
- Each person's time zone, for days and hours on the hub
