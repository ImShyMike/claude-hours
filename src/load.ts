import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'
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

// every session file in events/, flattened and tagged with its project
export async function loadEvents(dir: string): Promise<Event[]> {
  const names = await readdir(join(dir, 'events')).catch(() => [])
  const events: Event[] = []
  for (const name of names.sort()) {
    const sessionId = name.replace(/\.jsonl$/, '')
    if (sessionId === name || !SESSION_ID.test(sessionId)) continue
    for (const e of decodeSession(await Bun.file(join(dir, 'events', name)).text(), sessionId)) {
      if (e.cwd) e.project = projectFor(e.cwd)
      events.push(e)
    }
  }
  return events
}

// A session's draft timelines, from drafts/<sessionId>.jsonl
export async function loadTimelines(dir: string, sessionId: string): Promise<Timeline[]> {
  if (!SESSION_ID.test(sessionId)) return []
  const file = Bun.file(join(dir, 'drafts', `${sessionId}.jsonl`))
  if (!(await file.exists())) return []
  return parseTimelines(await file.text())
}
