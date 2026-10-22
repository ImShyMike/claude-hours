# The hub rewrite

The new hub lives next to the old one while it's built: `apps/web` (SvelteKit
with shadcn-svelte) on `packages/db` (Drizzle on stock Postgres). The old
`src/` server and the mod keep working untouched until the new hub can take
their data.

## Running it

```sh
docker compose up -d                       # Postgres on localhost:5434
cp apps/web/.env.example apps/web/.env     # then fill in the HCA app
(cd packages/db && bun run migrate)
(cd apps/web && bun run dev)
```

The Hack Club Auth app is registered at https://auth.hackclub.com/developer/apps
with the redirect uri `http://localhost:5173/auth/callback` (plus the deployed
one).

Tests need no server: `packages/db` and `apps/web` both run on PGlite.

```sh
(cd packages/db && bun test)
(cd apps/web && bun run test && bun run check)
```

## Deploying

- Run `bun run migrate` in `packages/db` (with `DATABASE_URL` set) before
  starting a new version. The app doesn't migrate on its own.
- `vite build` needs no secrets. `DATABASE_URL`, `HCA_CLIENT_ID` and
  `HCA_CLIENT_SECRET` are checked when the server starts, and it refuses to
  boot without them.
- adapter-node 6 has no `ORIGIN` env anymore. The origin comes from the
  request: the `Host` header, and `https` unless `PROTOCOL_HEADER` names a
  header that says otherwise. Behind a TLS proxy that keeps `Host`, that's
  already right. Otherwise set `paths.origin` in `vite.config.ts`, or
  `HOST_HEADER`/`PROTOCOL_HEADER` (e.g. `x-forwarded-host`/`x-forwarded-proto`).
- Rate limits live in memory, so they assume one server process.

## Milestone 1: accounts and devices

- [x] Workspace: `apps/web`, `packages/db`, one prettier config
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

## Next

- Settle the sync protocol, then `POST /v1/events`, `GET /v1/hello` and the
  typed event tables
- The mod: `login` command (device flow), the sync manifest and flushing
- What approving a deletion actually deletes, and whether a tombstone stays
- Importing the old JSONL files
- The dashboard, from server-side summaries
