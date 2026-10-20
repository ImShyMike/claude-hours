import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { parseLines, type Event } from './aggregate'
import { parseTimelines, type Timeline } from './replay'

// events.jsonl now, events-YYYY-MM.jsonl if the mod starts rotating
const LOG_NAME = /^events.*\.jsonl$/

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

export async function loadEvents(dir: string): Promise<Event[]> {
  const names = (await readdir(dir).catch(() => [])).filter(name => LOG_NAME.test(name)).sort()
  const events: Event[] = []
  for (const name of names) {
    for (const e of parseLines(await Bun.file(join(dir, name)).text())) {
      if (typeof e.cwd === 'string') e.project = projectFor(e.cwd)
      events.push(e)
    }
  }
  return events
}

// Session ids are uuids; anything else never reaches a path
export const SESSION_ID = /^[\w-]{1,128}$/

// A session's draft timelines, from drafts/<sessionId>.jsonl
export async function loadTimelines(dir: string, sessionId: string): Promise<Timeline[]> {
  if (!SESSION_ID.test(sessionId)) return []
  const file = Bun.file(join(dir, 'drafts', `${sessionId}.jsonl`))
  if (!(await file.exists())) return []
  return parseTimelines(await file.text())
}
