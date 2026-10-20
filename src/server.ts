import { homedir } from 'node:os'
import { join } from 'node:path'
import index from '../public/index.html'
import { loadEvents } from './load'

const dir = process.env.ANALYTICS_DIR ?? join(homedir(), '.claude/analytics')
const port = Number(process.env.PORT ?? 4747)

// localhost only: the events carry local paths
const server = Bun.serve({
  hostname: '127.0.0.1',
  port,
  development: process.env.NODE_ENV !== 'production',
  routes: {
    '/': index,
    // re-read on every request, the log is small and always growing
    '/api/events': async () => Response.json(await loadEvents(dir)),
  },
})

console.log(`claude-hackatime on ${server.url} reading ${dir}`)
