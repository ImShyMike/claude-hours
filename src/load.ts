import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { gunzipSync } from 'node:zlib'
import type { Event } from './aggregate'
import { decodeSession } from './eventlog'
import { parseTimelines, type Timeline } from './replay'

const projectCache = new Map<string, string>()

// A cd into a subdir shouldn't split a repo into two projects, so name the
// nearest git root. ~/.claude gets a friendly name of its own.
export function projectFor(cwd: string, home = homedir()) {
  const cached = projectCache.get(cwd)
  if (cached) return cached
  let name = basename(cwd) || '/'
  for (let dir = cwd; ; dir = dirname(dir)) {
    if (dir === join(home, '.claude')) {
      name = '~/.claude'
      break
    }
    if (existsSync(join(dir, '.git'))) {
      name = basename(dir)
      break
    }
    if (dir === dirname(dir) || dir === home) break
  }
  projectCache.set(cwd, name)
  return name
}

// Session ids are uuids; anything else never reaches a path
export const SESSION_ID = /^[\w-]{1,128}$/

// A finished session's file is gzipped to <id>.jsonl.gz, and a resumed one
// grows a fresh <id>.jsonl beside it, so a session can be in both; the gz
// holds the older part. Each is a whole file with its own header. The mod
// appends one gzip member per pack, which node:zlib reads all of (Bun's own
// gunzipSync stops after the first).
async function sessionParts(path: string): Promise<string[]> {
  const parts: string[] = []
  const gz = Bun.file(`${path}.gz`)
  if (await gz.exists()) {
    try {
      parts.push(gunzipSync(new Uint8Array(await gz.arrayBuffer())).toString('utf8'))
    } catch {}
  }
  const plain = Bun.file(path)
  if (await plain.exists()) parts.push(await plain.text())
  return parts
}

const sessionOf = (name: string) => /^(.+)\.jsonl(\.gz)?$/.exec(name)?.[1]

// every session file in events/, flattened and tagged with its project
export async function loadEvents(dir: string): Promise<Event[]> {
  const names = await readdir(join(dir, 'events')).catch(() => [])
  const ids = [...new Set(names.map(sessionOf))].filter((id): id is string => !!id && SESSION_ID.test(id)).sort()
  const events: Event[] = []
  for (const sessionId of ids) {
    for (const text of await sessionParts(join(dir, 'events', `${sessionId}.jsonl`))) {
      for (const e of decodeSession(text, sessionId)) {
        if (e.cwd) e.project = projectFor(e.cwd)
        events.push(e)
      }
    }
  }
  return events
}

// A session's draft timelines, from drafts/<sessionId>.jsonl (and .gz)
export async function loadTimelines(dir: string, sessionId: string): Promise<Timeline[]> {
  if (!SESSION_ID.test(sessionId)) return []
  const parts = await sessionParts(join(dir, 'drafts', `${sessionId}.jsonl`))
  return parts.flatMap(parseTimelines)
}
