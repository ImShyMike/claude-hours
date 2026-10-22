// Sends a folder of session files (~/.claude/analytics by default) to a hub,
// through the same protocol the mod uses, so old data or the demo fixtures
// land like anything else. Safe to run again: the hub keeps each row once.
//
//   HUB=http://localhost:5173 TOKEN=hct_... bun scripts/import.ts [dir]
//
// TOKEN is a device token, from logging in with the mod or the device flow
import { readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { SESSION_ID, sessionParts } from '../src/lib/analytics/load'
import { rowsOf, splitRuns } from '../src/lib/analytics/runs'

const hub = process.env.HUB?.replace(/\/+$/, '')
const token = process.env.TOKEN
const dir = process.argv[2] ?? join(homedir(), '.claude/analytics')
if (!hub || !token) {
  console.error('usage: HUB=<hub url> TOKEN=<device token> bun scripts/import.ts [dir]')
  process.exit(1)
}

type Run = { session: string; stream: 'events' | 'drafts'; run: number; header?: unknown; from: number; rows: unknown[] }

const BATCH_ROWS = 4000
const BATCH_BYTES = 2 * 1024 * 1024

async function send(runs: Run[]) {
  const res = await fetch(`${hub}/v1/events`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'content-encoding': 'gzip',
      'user-agent': 'claude-hours-import/1',
      'x-protocol': '1',
    },
    body: Bun.gzipSync(JSON.stringify({ runs })),
  })
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`)
  return (await res.json()) as { runs: Record<string, { status: string; acked: number }>; quarantined: number }
}

const sessions = [...new Set(readdirSync(join(dir, 'events')).map(name => /^(.+)\.jsonl(\.gz)?$/.exec(name)?.[1]))].filter(
  (id): id is string => !!id && SESSION_ID.test(id),
)

// every run, sliced so no request goes over the limits
const pending: Run[] = []
for (const session of sessions) {
  const events = (await sessionParts(join(dir, 'events', `${session}.jsonl`))).join('')
  for (const r of splitRuns(events)) pending.push({ session, stream: 'events', run: r.start, header: r.header, from: 0, rows: r.rows })
  const drafts = (await sessionParts(join(dir, 'drafts', `${session}.jsonl`))).join('')
  if (drafts) pending.push({ session, stream: 'drafts', run: 0, from: 0, rows: rowsOf(drafts) })
}

let sent = 0
let quarantined = 0
while (pending.length) {
  const batch: Run[] = []
  let rows = 0
  let bytes = 0
  while (pending.length && rows < BATCH_ROWS && bytes < BATCH_BYTES) {
    const r = pending.shift()!
    const room = Math.min(BATCH_ROWS - rows, r.rows.length)
    // a run too big for what's left goes in part, the rest waits its turn
    const part = { ...r, rows: r.rows.slice(0, room || r.rows.length) }
    if (part.rows.length < r.rows.length) pending.unshift({ ...r, from: r.from + part.rows.length, rows: r.rows.slice(part.rows.length) })
    batch.push(part)
    rows += part.rows.length
    bytes += JSON.stringify(part).length
  }
  const answer = await send(batch)
  quarantined += answer.quarantined
  for (const r of batch) {
    const result = answer.runs[`${r.session}/${r.stream}/${r.run}`]
    if (result?.status !== 'ok') throw new Error(`${r.session} ${r.stream} ${r.run}: ${JSON.stringify(result)}`)
  }
  sent += rows
  process.stdout.write(`\rsent ${sent} rows`)
}
console.log(`\nimported ${sessions.length} sessions from ${dir}${quarantined ? `, ${quarantined} rows quarantined` : ''}`)
