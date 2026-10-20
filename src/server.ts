import { homedir } from 'node:os'
import { join } from 'node:path'
import index from '../public/index.html'
import session from '../public/session.html'
import timeline from '../public/timeline.html'
import { COOKIE, people, upload, viewer, whoIs } from './hub'
import { loadEvents, loadTimelines } from './load'

const port = Number(process.env.PORT ?? 4747)
const development = process.env.NODE_ENV !== 'production'

// HUB_DIR set: the central server, taking uploads and showing each person
// their own. Otherwise the local dashboard over ~/.claude/analytics
const hub = process.env.HUB_DIR

function local() {
  const dir = process.env.ANALYTICS_DIR ?? join(homedir(), '.claude/analytics')
  // localhost only: the events carry local paths
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port,
    development,
    routes: {
      '/': index,
      '/session': session,
      '/timeline': timeline,
      // re-read on every request, the log is small and always growing
      '/api/events': async () => Response.json(await loadEvents(dir)),
      '/api/session/:id': async req => Response.json(await loadTimelines(dir, req.params.id)),
      '/api/me': () => Response.json({}),
    },
  })
  console.log(`claude-hours on ${server.url} reading ${dir}`)
}

const LOGIN = (error = '') => `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>claude-hours</title><link rel="stylesheet" href="/login.css" /></head>
<body><main class="login"><h1>claude-hours</h1>
<form method="post" action="/login">
<label for="token">your token</label>
<input id="token" name="token" type="password" autocomplete="current-password" required autofocus />
${error ? `<p class="error">${error}</p>` : ''}
<button type="submit">Open my dashboard</button>
</form></main></body></html>`

const LOGIN_CSS = `
:root { color-scheme: light dark; --bg: #fafaf9; --fg: #1c1917; --muted: #78716c; --line: #d6d3d1; --accent: #ec3750; }
@media (prefers-color-scheme: dark) { :root { --bg: #17171a; --fg: #f5f5f4; --muted: #a8a29e; --line: #3f3f46; } }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, sans-serif; }
.login { max-width: 22rem; margin: 18vh auto 0; padding: 0 16px; }
h1 { font-size: 1.4rem; margin: 0 0 1.5rem; }
form { display: grid; gap: .6rem; }
label { color: var(--muted); font-size: .9rem; }
input { font: inherit; padding: .6rem .7rem; border: 1px solid var(--line); border-radius: 8px; background: transparent; color: inherit; }
button { font: inherit; padding: .6rem; border: 0; border-radius: 8px; background: var(--accent); color: white; cursor: pointer; }
.error { color: var(--accent); margin: 0; font-size: .9rem; }
`

function central(dir: string) {
  const secure = (req: Request) => new URL(req.url).protocol === 'https:' || req.headers.get('x-forwarded-proto') === 'https'
  const cookie = (req: Request, value: string, maxAge: number) =>
    `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure(req) ? '; Secure' : ''}`
  const html = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } })
  const unauthorized = () => Response.json({ error: 'log in first' }, { status: 401 })

  const server = Bun.serve({
    // behind a proxy that terminates TLS; HOST=0.0.0.0 to listen wider
    hostname: process.env.HOST ?? '127.0.0.1',
    port,
    development,
    routes: {
      // the pages hold no data; their API calls send people to /login
      '/': index,
      '/session': session,
      '/timeline': timeline,
      '/login.css': () => new Response(LOGIN_CSS, { headers: { 'content-type': 'text/css' } }),
      '/login': {
        GET: () => html(LOGIN()),
        POST: async req => {
          const token = String((await req.formData()).get('token') ?? '').trim()
          if (!(await whoIs(dir, token))) return html(LOGIN("That token isn't one we know."), 401)
          return new Response(null, { status: 303, headers: { location: '/', 'set-cookie': cookie(req, token, 60 * 60 * 24 * 90) } })
        },
      },
      '/logout': {
        POST: req => new Response(null, { status: 303, headers: { location: '/login', 'set-cookie': cookie(req, '', 0) } }),
      },
      '/api/me': async req => {
        const view = await viewer(dir, req)
        if (!view) return unauthorized()
        const { who, person } = view
        return Response.json({ person, me: who.person, admin: !!who.admin, people: who.admin ? await people(dir) : undefined })
      },
      '/api/events': async req => {
        const view = await viewer(dir, req)
        return view ? Response.json(await loadEvents(view.dir, { remote: true })) : unauthorized()
      },
      '/api/session/:id': async req => {
        const view = await viewer(dir, req)
        return view ? Response.json(await loadTimelines(view.dir, req.params.id)) : unauthorized()
      },
      '/v1/sessions/:id/:kind': { POST: req => upload(dir, req, req.params.id, req.params.kind) },
    },
  })
  console.log(`claude-hours hub on ${server.url}, keeping uploads in ${dir}`)
}

if (hub) central(hub)
else local()
