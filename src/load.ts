import { existsSync, readFileSync, statSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { gunzipSync } from 'node:zlib'
import type { Event } from './aggregate'
import { decodeSession } from './eventlog'
import { parseTimelines, type Timeline } from './replay'

const repoCache = new Map<string, string | null>()

// A repo's folder by name, ~/.claude by a friendly one. A worktree (a
// subagent's under <repo>/.claude/worktrees, say) goes by the repo it was made
// from, which on the hub, where nothing can be read, its path has to tell
export function repoName(dir: string) {
  const main = /^(.+?)\/\.claude\/worktrees\/[^/]+(?:\/|$)/.exec(dir)?.[1] ?? dir
  return main.endsWith('/.claude') ? '~/.claude' : basename(main) || '/'
}

// a worktree's .git is a file pointing into its repo's .git/worktrees
function worktreeOf(at: string) {
  try {
    if (!statSync(join(at, '.git')).isFile()) return undefined
    const gitdir = /^gitdir:\s*(.+)$/m.exec(readFileSync(join(at, '.git'), 'utf8'))?.[1]?.trim()
    return gitdir && /^(.+)\/\.git\/worktrees\/[^/]+\/?$/.exec(gitdir)?.[1]
  } catch {
    return undefined
  }
}

// the name of the nearest git root at or above dir (~/.claude gets a friendly
// name of its own), or undefined when there's none
export function repoFor(dir: string, home = homedir()) {
  const cached = repoCache.get(dir)
  if (cached !== undefined) return cached ?? undefined
  let name: string | null = null
  for (let at = dir; ; at = dirname(at)) {
    if (at === join(home, '.claude')) {
      name = '~/.claude'
      break
    }
    if (existsSync(join(at, '.git'))) {
      const main = worktreeOf(at)
      name = main ? repoName(main) : basename(at)
      break
    }
    if (at === dirname(at) || at === home) break
  }
  repoCache.set(dir, name)
  return name ?? undefined
}

// A cd into a subdir shouldn't split a repo into two projects, so name the
// nearest git root, else the folder itself
export function projectFor(cwd: string, home = homedir()) {
  return repoFor(cwd, home) ?? (basename(cwd) || '/')
}

// Which project a tool call or changed file was really in: the repo the mod
// saw it work in (a Bash cd, a file outside the cwd's repo), else a file's own
// repo. A Bash call with no repo ran in the cwd. Undefined when it says
// nothing, like a file in no repo at all. The dashboard moves the calling
// thread's time there (aggregate's projectSpans)
function workProject(e: Event, remote: boolean) {
  if (e.event !== 'tool' && e.event !== 'file_changed') return undefined
  if (typeof e.repoName === 'string') return e.repoName
  if (typeof e.repo === 'string') return remote ? repoName(e.repo) : repoFor(e.repo)
  const path = typeof e.file === 'string' ? e.file : typeof e.path === 'string' ? e.path : undefined
  if (path) return path.startsWith(`${e.cwd}/`) ? e.project : remote ? undefined : repoFor(dirname(path))
  return e.tool === 'Bash' ? e.project : undefined
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

// every session file in events/, flattened and tagged with its project. On
// the hub the cwds are someone else's disk, so a project is the folder of the
// repo the mod said the cwd is in, else the cwd's own. Locally the disk says
export async function loadEvents(dir: string, { remote = false } = {}): Promise<Event[]> {
  const names = await readdir(join(dir, 'events')).catch(() => [])
  const ids = [...new Set(names.map(sessionOf))].filter((id): id is string => !!id && SESSION_ID.test(id)).sort()
  const events: Event[] = []
  for (const sessionId of ids) {
    // a folder with no repo to be found (gone since, or never said) under
    // where the session started is part of the session's project
    let base: { cwd: string; project: string } | undefined
    for (const text of await sessionParts(join(dir, 'events', `${sessionId}.jsonl`))) {
      for (const e of decodeSession(text, sessionId)) {
        if (e.cwd) {
          const root = typeof e.root === 'string' ? e.root : undefined
          // the name the mod read off the repo's origin beats any folder's
          const known = typeof e.rootName === 'string' ? e.rootName : remote ? root && repoName(root) : repoFor(e.cwd)
          if (!known && base && e.cwd.startsWith(`${base.cwd}/`)) e.project = base.project
          else e.project = known || (remote ? repoName(e.cwd) : projectFor(e.cwd))
          base ??= { cwd: root ?? e.cwd, project: e.project }
        }
        const work = workProject(e, remote)
        if (work) e.workProject = work
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
