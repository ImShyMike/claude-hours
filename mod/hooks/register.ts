import { atom, read, update } from 'claude-code'
import type { EngineInterface, PromptEditInput, Register } from 'claude-code'
import type { StartedSessions } from '../types'

// One JSON object per line, one file per session, under $HOME. Prompt text
// and file contents are never written: only sizes, tool names and paths.
//
// A session file opens with a header, {"v":1,"event":"session","start":<epoch
// ms>,"cwd":...}. Every later row carries `t`, ms since that start (or `at`,
// epoch ms, if the header couldn't be read back), and no cwd: a cwd_changed
// row says when it moves, and paths under it are written relative to it.
//
// Each draft's edit timeline goes to drafts/<session>.jsonl, as shapes only:
// 'a' for any character, ' ' for blanks, '\n' for newlines.
//
// Fields at their usual value are left out (DEFAULTS), and when a session
// ends its files are gzipped onto <file>.gz (a resumed one appends another
// gzip member, which readers see as one stream).
const LOG_DIR = '.claude/analytics'
const EVENTS_DIR = `${LOG_DIR}/events`
const DRAFTS_DIR = `${LOG_DIR}/drafts`
const FORMAT = 1
// which files get logged, globs in {"files":{"include":[...],"exclude":[...]}},
// and where to send them, {"server":{"url":...,"token":...}}
const CONFIG_FILE = `${LOG_DIR}/config.json`
// how far each session's files have reached the server: sent/<session>.json
const SENT_DIR = `${LOG_DIR}/sent`
// one upload's most, cut back to its last whole line
const CHUNK_BYTES = 512 * 1024
const UPLOAD_TIMEOUT_MS = 10_000
const KINDS = ['events', 'drafts'] as const

// a field at this value is left out of its row; readers put it back
const DEFAULTS: Record<string, Fields> = {
  tool: { outcome: 'ok' },
  turn_end: { reason: 'answer' },
  file_changed: { via: 'tool' },
  prompt: { origin: 'composer', isMeta: false },
  session_start: { isInteractive: true },
  compact: { outcome: 'compacted' },
}
// a typed draft's counters, left out at 0 (only on rows with typingMs)
const DRAFT_COUNTERS = ['pastedChars', 'deletedChars', 'fixes', 'rewrites', 'rewrittenChars', 'pauses', 'breaks', 'longestPauseMs', 'wordDeletes', 'lineKills']

function compactRow(event: string, fields: Fields) {
  const usual = DEFAULTS[event] ?? {}
  const draft = typeof fields.typingMs === 'number'
  const out: Fields = {}
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || usual[key] === value) continue
    if (draft && value === 0 && DRAFT_COUNTERS.includes(key)) continue
    out[key] = value
  }
  return out
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])
// built-in tools whose path we log; an MCP tool's file_path argument is its
// own business and stays out of the log
const FILE_TOOLS = new Set(['Read', ...EDIT_TOOLS])
const PRUNE = ['.git', 'node_modules', 'target', '.venv', 'venv', '__pycache__', 'dist', 'build']
const MAX_PATHS_PER_CALL = 50
// Claude Code's own churn under ~/.claude, this log included
const NOISY_HOME_DIRS = ['.claude/projects', '.claude/state', '.claude/analytics', '.claude/plugins']

type Fields = Record<string, unknown>

const startedSessions = atom({ plugin: 'hook-analytics', key: 'startedSessions' } as const, [] as StartedSessions)

// `find -newermt` wants whole seconds on both GNU find and bfs
const isoSeconds = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z')

const countWords = (text: string) => text.trim().split(/\s+/).filter(Boolean).length

// A pause between edits up to this long still counts as typing; longer is
// thinking or tea. A keyless insert at least PASTE_CHARS long counts as a
// paste (a fast burst of keys also arrives keyless, but short)
const TYPING_GAP_MS = 30_000
const PASTE_CHARS = 32
// how long a draft emptied by a clear can still turn out to be the submit's
const CLEAR_GRACE_MS = 2_000
// a gap between edits this long is a thinking pause (up to TYPING_GAP_MS,
// past that it's a break); deleting this many chars or fewer and typing
// again is a typo fix, more is a rewrite
const PAUSE_MS = 2_000
const FIX_CHARS = 3
// a timeline stops growing past either cap and is marked truncated
const MAX_TIMELINE_EDITS = 5_000
const MAX_SHAPE_CHARS = 50_000

// The shape of a text, one character per UTF-16 unit so editor offsets line up
const shapeOf = (text: string) => text.replace(/\S/g, 'a').replace(/[^\S\n]/g, ' ')

// One step of a draft: [ms since its start, kind, position, chars removed,
// shape inserted], kinds: t typed, p pasted, r typed over a selection, b
// backspace, d forward delete, w word delete, k line kill, m cursor move
// (position only), c the box replaced (history, undo, a fill; then the 6th
// item is who did it)
type Step = [number, string, number, number?, string?, string?]

// Shapes run-length encoded: a letter, _ a blank, n a newline, each run with
// its count unless it's 1 ("5a_3a" is five letters, a blank, three letters)
function rle(shape: string) {
  let out = ''
  for (let i = 0; i < shape.length; ) {
    const ch = shape[i]!
    let n = 1
    while (shape[i + n] === ch) n++
    out += `${n > 1 ? n : ''}${ch === '\n' ? 'n' : ch === ' ' ? '_' : 'a'}`
    i += n
  }
  return out
}

// Steps as one compact string, leaving out whatever the replay can work out.
// Each is "<10ms ticks since the last step><kind>[@pos][-removed][+shape][:who]",
// comma separated (ticks are rounded from the draft's start, so they never
// drift). The position is left out when it's where the cursor
// already is (before it, for a backspace), removed when it's the usual (1 for
// b and d, else 0). A one-character insert at the cursor is just its symbol:
// "14a" a letter 140ms after the last step, "9_" a blank, "8n" a newline
function encodeSteps(steps: Step[], initialCursor: number) {
  let cursor = initialCursor
  let prev = 0
  return steps
    .map(([at, kind, pos, removed = 0, shape = '', who]) => {
      const tick = Math.round(at / 10)
      const dt = Math.max(0, tick - prev)
      prev = Math.max(prev, tick)
      let token: string
      if (kind === 't' && !removed && shape.length === 1 && pos === cursor) token = `${dt}${rle(shape)}`
      else {
        const usualRemoved = kind === 'b' || kind === 'd' ? 1 : 0
        const usualPos = kind === 'b' ? cursor - (removed || 1) : cursor
        token = `${dt}${kind}`
        if (pos !== usualPos) token += `@${pos}`
        if (removed !== usualRemoved) token += `-${removed}`
        if (shape) token += `+${rle(shape)}`
        if (who) token += `:${who.replace(/[^a-z]/g, '')}`
      }
      cursor = kind === 'm' || kind === 'c' ? pos : kind === 't' || kind === 'p' || kind === 'r' ? pos + shape.length : pos
      return token
    })
    .join(',')
}

// The draft in the prompt box, from its first edit. Only counts and times are
// kept, never the text.
type Draft = {
  startedAt: number
  lastAt: number
  typingMs: number
  edits: number
  typedChars: number
  pastedChars: number
  deletedChars: number
  fixes: number
  rewrites: number
  rewrittenChars: number
  pauses: number
  breaks: number
  longestPauseMs: number
  // chars deleted since the last insert, waiting to see if they get retyped
  deleteRun: number
  wordDeletes: number
  lineKills: number
  // the replay: what the box held when the draft began, then every step
  id: string
  initialShape: string
  initialCursor: number
  // chars already in the box when the draft began (a recalled or put-back
  // prompt, or typing from before a hot reload): not pasted, just there
  initialChars: number
  steps: Step[]
  shapeChars: number
  truncated: boolean
}
// a draft the box lost without an edit or a submit we saw (`clear`, `undo`,
// backspaced away); a submit in the grace window claims it, else it's abandoned
type Emptied = { draft: Draft; at: number; how: string }

let draft: Draft | undefined
let emptied: Emptied | undefined
// abandoned drafts waiting for their line: written at the next submit or at
// exit, never from a keystroke. A hot reload forgets them
let abandoned: Emptied[] = []

// the main loop's turns still running, and its tool calls in flight by
// tool_use_id, so a prompt knows it came mid-turn and an interrupt what it cut
// short. A hot reload mid-turn forgets them
const openTurns = new Set<string>()
const runningTools = new Map<string, string>()

// Waits on the person inside a main-loop turn. The engine leaves them out of
// the turn's durationMs, so its clock time minus durationMs is what they took.
// A question or plan approval waits for its whole call; a permission dialog
// opens when the check answers `ask` and closes some time before the call
// ends, so the left-out time is what tells how long it stayed open
const QUESTION_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode'])
const askedAt = new Map<string, number>()
let turnClock: { turnId: string; startedMs: number; questionsMs: number; asked: { tool: string; from: number; to: number }[] } | undefined

// [ms before the turn's end it opened, ms open, tool] per dialog. Several in
// one turn share the left-out time by how long each call ran past its ask
function dialogWaits(clock: NonNullable<typeof turnClock>, endMs: number, durationMs: number) {
  const dialogsMs = endMs - clock.startedMs - durationMs - clock.questionsMs
  const askedMs = clock.asked.reduce((ms, a) => ms + a.to - a.from, 0)
  if (dialogsMs < 500 || !askedMs) return undefined
  const share = Math.min(1, dialogsMs / askedMs)
  return clock.asked.map(a => [endMs - a.from, Math.round((a.to - a.from) * share), a.tool])
}

let home: Promise<string> | undefined
let queue: Promise<void> = Promise.resolve()
// the session file being written: its start, and the cwd its rows are under.
// A reload (or a resumed session) reads the start back from the header and
// writes a cwd_changed before its first row, since it can't know the last cwd
let head: { sessionId: string; start?: number; cwd?: string } | undefined

function homeDir($: EngineInterface) {
  return (home ??= $.env.get('HOME').then(async dir => {
    if (!dir) throw new Error('HOME is not set')
    await $.process.run(['mkdir', '-p', `${dir}/${EVENTS_DIR}`, `${dir}/${DRAFTS_DIR}`, `${dir}/${SENT_DIR}`])
    return dir
  }))
}

async function append($: EngineInterface, path: string, rows: Fields[]) {
  const text = rows.map(row => `${JSON.stringify(row)}\n`).join('')
  const { exitCode, stderr } = await $.process.run(['tee', '-a', path], { stdin: text })
  if (exitCode !== 0) throw new Error(`append failed: ${stderr.trim()}`)
}

// A finished session's files, gzipped onto <file>.gz. A resumed session
// appends one more gzip member there, and readers take them as one stream.
// Runs behind the queue, so every row is in before the file goes. The file
// moves aside first, so an upload reading gz-then-plain meanwhile sees less
// of it for a moment, never the same rows twice
function packSession($: EngineInterface) {
  queue = queue
    .then(async () => {
      const [sessionId, dir] = await Promise.all([$.session.id(), homeDir($)])
      const files = [`${dir}/${EVENTS_DIR}/${sessionId}.jsonl`, `${dir}/${DRAFTS_DIR}/${sessionId}.jsonl`]
      const script = 'for f; do [ -f "$f" ] || continue; mv "$f" "$f.packing" && gzip -c "$f.packing" >> "$f.gz" && rm -f "$f.packing"; done'
      const { exitCode, stderr } = await $.process.run(['sh', '-c', script, 'sh', ...files], { timeoutMs: 1_000 })
      if (exitCode !== 0) throw new Error(`gzip failed: ${stderr.trim()}`)
      if (head?.sessionId === sessionId) head = undefined
    })
    .catch(err => $.ui.log(`${$.plugin.name}: ${String(err)}`))
  return queue
}

// a path under the cwd, written relative to it
const relative = (path: unknown, cwd: string) =>
  typeof path === 'string' && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path

// The session file's header: written when the file is new, read back after a
// reload. A file too big to read back gets absolute times instead
async function headFor($: EngineInterface, path: string, sessionId: string, now: number, cwd: string, rows: Fields[]) {
  if (head?.sessionId === sessionId) return head
  if (await $.fs.exists(path)) {
    const text = await $.fs.read(path).catch(() => '')
    let start: number | undefined
    try {
      const first = JSON.parse(String(text).slice(0, String(text).indexOf('\n')))
      if (first.event === 'session' && typeof first.start === 'number') start = first.start
    } catch {}
    head = { sessionId, start }
  } else {
    rows.push({ v: FORMAT, event: 'session', start: now, cwd })
    head = { sessionId, start: now, cwd }
  }
  return head
}

// Appends go through one queue so parallel tool calls never interleave lines.
// The time and cwd are read when the event happens, not when it is written.
// Several entries go out in one append, and draft timelines in one more
function logAll($: EngineInterface, entries: [event: string, fields: Fields][], timelines: Fields[] = []) {
  const at = $.clock.now()
  const session = $.session.id()
  const where = $.session.cwd()
  queue = queue
    .then(async () => {
      const [now, sessionId, cwd, dir] = await Promise.all([at, session, where, homeDir($)])
      const path = `${dir}/${EVENTS_DIR}/${sessionId}.jsonl`
      const rows: Fields[] = []
      const h = await headFor($, path, sessionId, now, cwd, rows)
      const stamp = h.start === undefined ? { at: now } : { t: now - h.start }
      if (h.cwd !== cwd) rows.push({ ...stamp, event: 'cwd_changed', cwd })
      h.cwd = cwd
      for (const [event, fields] of entries) {
        rows.push({ ...stamp, event, ...compactRow(event, { ...fields, file: relative(fields.file, cwd), path: relative(fields.path, cwd) }) })
      }
      if (timelines.length) await append($, `${dir}/${DRAFTS_DIR}/${sessionId}.jsonl`, timelines)
      await append($, path, rows)
    })
    .catch(err => $.ui.log(`${$.plugin.name}: ${String(err)}`))
  return queue
}

const log = ($: EngineInterface, event: string, fields: Fields = {}) => logAll($, [[event, fields]])

// Bash (and python run from it) can touch anything, so look for files under
// the working dir modified since the call started. Can't tell who did it.
async function filesChangedSince($: EngineInterface, startedMs: number, repo?: string) {
  const [cwd, dir] = await Promise.all([$.session.cwd(), homeDir($)])
  const roots = [cwd === '/' || cwd === dir ? undefined : cwd, repo].filter((root): root is string => !!root)
  if (!roots.length) return []
  const prune = PRUNE.flatMap((name, i) => (i === 0 ? ['-name', name] : ['-o', '-name', name]))
  const argv = ['find', ...roots, '(', ...prune, ')', '-prune', '-o', '-type', 'f', '-newermt', isoSeconds(startedMs), '-print']
  const { stdout } = await $.process.run(argv, { timeoutMs: 3_000 })
  const noisy = NOISY_HOME_DIRS.map(sub => `${dir}/${sub}/`)
  return stdout
    .split('\n')
    .filter(path => path && !noisy.some(prefix => path.startsWith(prefix)))
    .slice(0, MAX_PATHS_PER_CALL)
}

// Where a call worked when that's another repo than the cwd's: the git root
// of a file outside the cwd, or of where a Bash command cd's to first
// (`cd ../hub && make`). Only the root is logged, never the command
const roots = new Map<string, Promise<string | undefined>>()
function rootOf($: EngineInterface, dir: string) {
  let root = roots.get(dir)
  if (!root) {
    root = $.process
      .run(['git', '-C', dir, 'rev-parse', '--show-toplevel'], { timeoutMs: 2_000 })
      .then(r => (r.exitCode === 0 && r.stdout.trim()) || undefined)
      .catch(() => undefined)
    roots.set(dir, root)
  }
  return root
}

// `..` and `.` folded away, relative paths taken from base
function resolvePath(base: string, path: string) {
  const parts: string[] = []
  for (const part of (path.startsWith('/') ? path : `${base}/${path}`).split('/')) {
    if (part === '..') parts.pop()
    else if (part && part !== '.') parts.push(part)
  }
  return `/${parts.join('/')}`
}

function cdTarget(command: string, cwd: string, home: string) {
  const m = /^\s*cd\s+(?:"([^"]*)"|'([^']*)'|([^\s;&|]+))/.exec(command)
  const to = m?.[1] ?? m?.[2] ?? m?.[3]
  if (!to) return undefined
  return resolvePath(cwd, to === '~' ? home : to.startsWith('~/') ? home + to.slice(1) : to)
}

async function workRepo($: EngineInterface, where: string | undefined, cwd: string) {
  if (!where || where === cwd || where.startsWith(`${cwd}/`)) return undefined
  const [root, home] = await Promise.all([rootOf($, where), rootOf($, cwd)])
  return root && root !== home ? root : undefined
}

// A glob as a RegExp: ** any run of folders, * anything within one name,
// ? one character
function globToRegExp(glob: string) {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!
    if (c === '*' && glob[i + 1] === '*') {
      re += glob[i + 2] === '/' ? '(?:.*/)?' : '.*'
      i += glob[i + 2] === '/' ? 2 : 1
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

// Whether a glob names this path. One without a slash matches any file or
// folder name in it (`fixtures`, `*.log`); one with a slash matches from the
// cwd, or from / or ~/ when it starts there. Naming a folder names what's in it
function globMatches(glob: string, path: string, cwd: string, home: string) {
  const re = globToRegExp(glob.replace(/^~\//, `${home}/`).replace(/\/$/, ''))
  if (!glob.includes('/')) return path.split('/').some(name => re.test(name))
  const target = glob.startsWith('/') || glob.startsWith('~/') ? path : path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : undefined
  if (target === undefined) return false
  const parts = target.split('/')
  return parts.some((_, i) => re.test(parts.slice(0, i + 1).join('/')))
}

type FileRules = { include: string[]; exclude: string[] }
type Server = { url: string; token: string }

// The config, read fresh each time (it's tiny). A missing file means log
// everything and send nothing; a broken one says so and does the same
async function readConfig($: EngineInterface, dir: string): Promise<Record<string, unknown>> {
  const path = `${dir}/${CONFIG_FILE}`
  if (!(await $.fs.exists(path).catch(() => false))) return {}
  try {
    const config = JSON.parse(String(await $.fs.read(path)))
    return config && typeof config === 'object' ? config : {}
  } catch (err) {
    $.ui.log(`${$.plugin.name}: ignoring ${path}: ${String(err)}`)
    return {}
  }
}

async function fileRules($: EngineInterface, dir: string): Promise<FileRules> {
  const files = ((await readConfig($, dir)).files ?? {}) as Record<string, unknown>
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((g): g is string => typeof g === 'string') : [])
  return { include: list(files.include), exclude: list(files.exclude) }
}

async function serverOf($: EngineInterface, dir: string): Promise<Server | undefined> {
  const server = (await readConfig($, dir)).server as Record<string, unknown> | undefined
  if (typeof server?.url !== 'string' || typeof server.token !== 'string') return undefined
  return { url: server.url.replace(/\/+$/, ''), token: server.token }
}

// Uploads. A session's files are append-only, so the wire format is the file
// itself: POST the bytes past what the server holds, and it answers its new
// length. Every send can be repeated safely, and the server is the one that
// counts (in bytes, never a JS string's length). sent/<session>.json keeps the
// last length it answered, plus the .gz sizes once a finished session is in,
// for one server: pointing the config at another starts over from nothing.
//
// This runs on its own chain, never awaited by a hook: a slow server must not
// hold up the log or the person.
type Sent = { url?: string; events?: number; drafts?: number; gz?: [number, number] }

let syncing: Promise<void> = Promise.resolve()
let warned = false

function sentPath(dir: string, sessionId: string) {
  return `${dir}/${SENT_DIR}/${sessionId}.json`
}

async function readSent($: EngineInterface, server: Server, dir: string, sessionId: string): Promise<Sent> {
  const path = sentPath(dir, sessionId)
  const fresh = { url: server.url }
  if (!(await $.fs.exists(path).catch(() => false))) return fresh
  try {
    const sent = JSON.parse(String(await $.fs.read(path)))
    return sent?.url === server.url ? sent : fresh
  } catch {
    return fresh
  }
}

// the session's file as one stream (the .gz's members, then the plain file),
// from `offset` bytes on, cut back to its last whole line
async function chunkFrom($: EngineInterface, path: string, offset: number) {
  const script = '{ [ -f "$1.gz" ] && gzip -dc "$1.gz" 2>/dev/null; [ -f "$1" ] && cat "$1"; } | tail -c +$(($2 + 1)) | head -c $3'
  const { stdout } = await $.process.run(['sh', '-c', script, 'sh', path, String(offset), String(CHUNK_BYTES)], { timeoutMs: 5_000 })
  return stdout.slice(0, stdout.lastIndexOf('\n') + 1)
}

async function post($: EngineInterface, server: Server, url: string, body: string) {
  const timeout = $.clock.sleep(UPLOAD_TIMEOUT_MS).then(() => {
    throw new Error(`no answer from ${server.url} in ${UPLOAD_TIMEOUT_MS / 1000}s`)
  })
  return Promise.race([
    $.http.fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/x-ndjson' },
      body,
    }),
    timeout,
  ])
}

// Sends one session's files up to their last whole line. True if the server
// holds all of it
async function pushSession($: EngineInterface, server: Server, dir: string, sessionId: string, sent: Sent) {
  let complete = true
  for (const kind of KINDS) {
    const path = `${dir}/${LOG_DIR}/${kind}/${sessionId}.jsonl`
    let drained = false
    // a 409 moves the offset to the server's, so a few rounds always settle
    for (let round = 0; round < 8 && !drained; round++) {
      const offset = sent[kind] ?? 0
      const body = await chunkFrom($, path, offset)
      drained = !body
      if (drained) break
      const url = `${server.url}/v1/sessions/${encodeURIComponent(sessionId)}/${kind}?offset=${offset}`
      const res = await post($, server, url, body)
      const length = Number((JSON.parse(res.text || '{}') as { length?: unknown }).length)
      if ((res.ok || res.status === 409) && Number.isSafeInteger(length) && length >= 0) {
        sent[kind] = length
        await $.fs.write(sentPath(dir, sessionId), JSON.stringify(sent))
        continue
      }
      throw new Error(`upload refused: ${res.status} ${res.text.slice(0, 200)}`)
    }
    if (!drained) complete = false
  }
  return complete
}

function warnOnce($: EngineInterface, err: unknown) {
  if (warned) return
  warned = true
  $.ui.log(`${$.plugin.name}: upload paused: ${String(err)}`)
}

// This session's files, after the writes queued so far. Not awaited
function syncSession($: EngineInterface) {
  const written = queue
  syncing = syncing
    .then(async () => {
      await written
      const [sessionId, dir] = await Promise.all([$.session.id(), homeDir($)])
      const server = await serverOf($, dir)
      if (!server) return
      await pushSession($, server, dir, sessionId, await readSent($, server, dir, sessionId))
      warned = false
    })
    .catch(err => warnOnce($, err))
}

// Finished sessions not yet all sent: one that crashed, ran offline or ended
// after its last upload. Only finished ones (.gz alone, no plain file and no
// pack under way), since a live session sends its own. A .gz whose size
// matches what sent/ recorded is already in. Not awaited
function sweep($: EngineInterface) {
  syncing = syncing
    .then(async () => {
      const dir = await homeDir($)
      const server = await serverOf($, dir)
      if (!server) return
      const list =
        'cd "$1" || exit 0; for f in events/*.jsonl.gz; do [ -e "$f" ] || continue; id=${f#events/}; id=${id%.jsonl.gz}; ' +
        'for p in events/$id.jsonl drafts/$id.jsonl events/$id.jsonl.packing drafts/$id.jsonl.packing; do [ -e "$p" ] && continue 2; done; ' +
        'd=0; [ -f "drafts/$id.jsonl.gz" ] && d=$(wc -c < "drafts/$id.jsonl.gz"); echo "$id $(wc -c < "$f") $d"; done'
      const { stdout } = await $.process.run(['sh', '-c', list, 'sh', `${dir}/${LOG_DIR}`], { timeoutMs: 5_000 })
      for (const line of stdout.split('\n')) {
        const [sessionId, e, d] = line.trim().split(/\s+/)
        if (!sessionId || !/^[\w-]{1,128}$/.test(sessionId)) continue
        const gz: [number, number] = [Number(e), Number(d)]
        const sent = await readSent($, server, dir, sessionId)
        if (sent.gz?.[0] === gz[0] && sent.gz[1] === gz[1]) continue
        if (await pushSession($, server, dir, sessionId, sent)) {
          sent.gz = gz
          await $.fs.write(sentPath(dir, sessionId), JSON.stringify(sent))
        }
      }
      warned = false
    })
    .catch(err => warnOnce($, err))
}

// excluded always loses; with any includes, only those are logged
const allowed = (rules: FileRules, path: string, cwd: string, home: string) =>
  !rules.exclude.some(g => globMatches(g, path, cwd, home)) &&
  (!rules.include.length || rules.include.some(g => globMatches(g, path, cwd, home)))

// the pause before Enter (or before giving up) is part of writing it too
function draftFields(d: Draft, endMs: number) {
  const last = endMs - d.lastAt
  return {
    composeMs: endMs - d.startedAt,
    typingMs: d.typingMs + (last <= TYPING_GAP_MS ? last : 0),
    edits: d.edits,
    typedChars: d.typedChars,
    pastedChars: d.pastedChars,
    deletedChars: d.deletedChars,
    fixes: d.fixes,
    rewrites: d.rewrites,
    rewrittenChars: d.rewrittenChars,
    pauses: d.pauses + (last >= PAUSE_MS && last <= TYPING_GAP_MS ? 1 : 0),
    breaks: d.breaks + (last > TYPING_GAP_MS ? 1 : 0),
    longestPauseMs: Math.max(d.longestPauseMs, last),
    wordDeletes: d.wordDeletes,
    lineKills: d.lineKills,
    draftId: d.id,
  }
}

// the draft's sidecar row: everything the replay needs, and no text (v 1:
// shapes and steps encoded as above, startedAt in epoch ms; an empty
// initialShape, a 0 initialCursor and truncated false are left out)
const timelineOf = (d: Draft, outcome: string, endMs: number): Fields => ({
  v: FORMAT,
  draftId: d.id,
  outcome,
  startedAt: d.startedAt,
  durationMs: endMs - d.startedAt,
  initialShape: rle(d.initialShape) || undefined,
  initialCursor: d.initialCursor || undefined,
  steps: encodeSteps(d.steps, d.initialCursor),
  truncated: d.truncated || undefined,
})

function addStep(d: Draft, at: number, step: [string, number, number?, string?, string?]) {
  const shape = step[3] ?? ''
  if (d.truncated) return
  if (d.steps.length >= MAX_TIMELINE_EDITS || d.shapeChars + shape.length > MAX_SHAPE_CHARS) {
    d.truncated = true
    return
  }
  d.shapeChars += shape.length
  d.steps.push([at - d.startedAt, ...step])
}

const isSurrogatePair = (text: string, at: number) => (text.codePointAt(at) ?? 0) > 0xffff

// What kind of edit it was. The span decides and the key only confirms: many
// terminals send Ctrl+Backspace as a plain backspace, and bursts come keyless
function editKind(e: PromptEditInput, inserted: number, removed: number) {
  if (inserted && removed) return 'r'
  if (inserted) return !e.key && inserted >= PASTE_CHARS ? 'p' : 't'
  const name = e.key?.key
  if (e.key?.ctrl && (name === 'u' || name === 'k')) return 'k'
  if ((e.key?.ctrl && name === 'w') || ((e.key?.ctrl || e.key?.meta) && (name === 'backspace' || name === 'delete'))) return 'w'
  const single = removed === 1 || (removed === 2 && isSurrogatePair(e.text, e.start))
  if (!single) {
    const fromLineStart = e.start === 0 || e.text[e.start - 1] === '\n'
    const toLineEnd = e.end === e.text.length || e.text[e.end] === '\n'
    const killsLine = (fromLineStart && e.end === e.cursor) || (toLineEnd && e.start === e.cursor)
    return killsLine && name !== 'w' ? 'k' : 'w'
  }
  return e.start === e.cursor && e.end > e.cursor ? 'd' : 'b'
}

// counts a gap between two edits (or the last edit and the end)
function notePause(d: Draft, gap: number) {
  if (gap > TYPING_GAP_MS) d.breaks++
  else if (gap >= PAUSE_MS) d.pauses++
  d.longestPauseMs = Math.max(d.longestPauseMs, gap)
}

// deleting and then typing again is a fix or a rewrite; typing over a
// selection is one in a single edit
function noteRetype(d: Draft, chars: number) {
  if (chars > FIX_CHARS) {
    d.rewrites++
    d.rewrittenChars += chars
  } else d.fixes++
}

// A big paste never comes through prompt.edit: the box folds it into a
// placeholder by its own route. So whatever the sent text holds beyond what
// the edits put there arrived some other way, and counts as pasted (a recalled
// history entry lands here too)
function sentFields(d: Draft, endMs: number, chars: number) {
  const fields = draftFields(d, endMs)
  const fromEdits = d.initialChars + d.typedChars + d.pastedChars - d.deletedChars
  return { ...fields, pastedChars: d.pastedChars + Math.max(0, chars - fromEdits) }
}

// the emptied draft is past claiming: it was abandoned
function settleEmptied() {
  if (emptied) abandoned.push(emptied)
  emptied = undefined
}

// The abandoned drafts' lines, written ahead of whatever comes next. They come
// late, so each carries its own start and end
function takeAbandoned() {
  const gone = abandoned
  abandoned = []
  return {
    entries: gone.map((g): [string, Fields] => [
      'draft_abandoned',
      {
        ...draftFields(g.draft, g.at),
        how: g.how,
        // written late, so it says when it ended; it began composeMs before
        endedAt: g.at,
      },
    ]),
    timelines: gone.map(g => timelineOf(g.draft, 'abandoned', g.at)),
  }
}

// no I/O and no awaits: this runs for every keystroke
function trackEdit(at: number, e: PromptEditInput, after: string) {
  if (!draft) {
    if (!after) return
    settleEmptied()
    draft = {
      startedAt: at, lastAt: at, typingMs: 0, edits: 0, typedChars: 0, pastedChars: 0, deletedChars: 0,
      fixes: 0, rewrites: 0, rewrittenChars: 0, pauses: 0, breaks: 0, longestPauseMs: 0, deleteRun: 0,
      wordDeletes: 0, lineKills: 0,
      id: `${at.toString(36)}-${e.text.length.toString(36)}`,
      initialShape: shapeOf(e.text),
      initialCursor: e.cursor,
      initialChars: [...e.text].length,
      steps: [],
      shapeChars: e.text.length,
      truncated: false,
    }
  } else notePause(draft, at - draft.lastAt)
  const gap = at - draft.lastAt
  if (gap <= TYPING_GAP_MS) draft.typingMs += gap
  draft.lastAt = at
  draft.edits++
  const removed = e.end - e.start
  draft.deletedChars += removed
  const inserted = [...e.inputText].length
  if (!e.key && inserted >= PASTE_CHARS) draft.pastedChars += inserted
  else draft.typedChars += inserted
  if (inserted && removed) noteRetype(draft, removed + draft.deleteRun)
  else if (inserted && draft.deleteRun) noteRetype(draft, draft.deleteRun)
  draft.deleteRun = inserted ? 0 : draft.deleteRun + removed
  const kind = editKind(e, inserted, removed)
  if (kind === 'w') draft.wordDeletes++
  if (kind === 'k') draft.lineKills++
  addStep(draft, at, inserted ? [kind, e.start, removed, shapeOf(e.inputText)] : [kind, e.start, removed])
  if (!after) noteEmptied(at, 'deleted')
}

function noteEmptied(at: number, how: string) {
  if (!draft) return
  emptied = { draft, at, how }
  draft = undefined
}

export const register: Register = on => {
  // the engine's own start, since a security plugin above skips classic.SessionStart.
  // It reruns on every hot reload, hence the dedupe.
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const sessionId = await $.session.id()
    if (!(await read($, startedSessions)).includes(sessionId)) {
      await update($, startedSessions, ids => [...ids, sessionId])
      await log($, 'session_start', { surface: e.surface, isInteractive: e.isInteractive })
      sweep($)
    }
    return started
  })

  // session.end gets 1.5 s for every hook: the session_end line plus any
  // abandoned drafts still waiting, a few appends at most
  on('session.end', async ($, e, next) => {
    // a draft still in the box at exit was never sent either
    if (draft) noteEmptied(await $.clock.now(), 'exit')
    settleEmptied()
    const { entries, timelines } = takeAbandoned()
    await logAll($, [...entries, ['session_end', { reason: e.reason }]], timelines)
    await packSession($)
    return next(e)
  })

  // logged after next() so a prompt another hook drops isn't counted
  on('prompt.submit', async ($, e, next) => {
    const midTurn = openTurns.size > 0
    const entered = await next(e)
    if (entered.drop === undefined) {
      const at = await $.clock.now()
      // the box may report its clear before or after the submit, so a draft
      // emptied a moment ago is this prompt's; an older one was abandoned
      let typed: Draft | undefined
      if (e.origin.kind === 'composer') {
        if (draft) typed = draft
        else if (emptied && at - emptied.at <= CLEAR_GRACE_MS) {
          typed = emptied.draft
          emptied = undefined
        }
        draft = undefined
        settleEmptied()
      }
      const { entries, timelines } = takeAbandoned()
      const chars = [...e.text].length
      entries.push([
        'prompt',
        {
          words: countWords(e.text),
          chars,
          command: e.command?.name,
          isMeta: e.isMeta,
          origin: e.origin.kind,
          midTurn: midTurn || undefined,
          ...(typed && sentFields(typed, at, chars)),
        },
      ])
      if (typed) timelines.push(timelineOf(typed, 'sent', at))
      await logAll($, entries, timelines)
    }
    return entered
  }).catch(($, e, next) => next(e))

  // Every keystroke lands here, so it stays cheap: the clock read runs
  // alongside the edit, then some arithmetic, and nothing is written. The
  // bookkeeping after next() must never throw, or the .catch would run next
  // again and apply the person's keystroke twice
  on('prompt.edit', async ($, e, next) => {
    const now = $.clock.now().catch(() => undefined)
    const box = await next(e)
    const at = await now
    if (at === undefined) return box
    try {
      // a cursor move goes in the replay only, so it never shifts the stats
      if (box.text !== e.text) trackEdit(at, e, box.text)
      else if (draft && box.cursor !== e.cursor) addStep(draft, at, ['m', box.cursor])
    } catch (err) {
      $.ui.log(`${$.plugin.name}: ${String(err)}`)
    }
    return box
  }).catch(($, e, next) => next(e))

  // a clear, a stash or an undo that empties the box takes the draft with it;
  // one that leaves text (a recalled entry, an undo, a fill) resets the replay
  on('prompt.change', async ($, e, next) => {
    const changed = await next(e)
    if (draft) {
      const at = await $.clock.now().catch(() => undefined)
      if (at !== undefined && draft) {
        if (!e.text) noteEmptied(at, e.origin.kind)
        else addStep(draft, at, ['c', e.cursor, 0, shapeOf(e.text), e.origin.kind])
      }
    }
    return changed
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      openTurns.add(e.turnId)
      turnClock = { turnId: e.turnId, startedMs: await $.clock.now(), questionsMs: 0, asked: [] }
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const main = e.agentId === undefined
    if (main) openTurns.delete(e.turnId)
    const clock = main && turnClock?.turnId === e.turnId ? turnClock : undefined
    if (clock) turnClock = undefined
    const waits = clock ? dialogWaits(clock, await $.clock.now(), e.durationMs) : undefined
    const aborted = e.reason === 'aborted'
    // what an Esc cut short: how much of the answer had shown (a count, never
    // the text) and any tools still running
    const cut = aborted && main ? { answerChars: [...e.answer].length, toolsRunning: runningTools.size ? [...runningTools.values()] : undefined } : {}
    if (main) runningTools.clear()
    await log($, aborted ? 'interrupt' : 'turn_end', {
      turnId: e.turnId,
      agentId: e.agentId,
      reason: e.reason,
      durationMs: e.durationMs,
      waits,
      usage: e.usage,
      ...cut,
    })
    if (main) syncSession($)
    return next(e)
  })

  // /compact, the threshold, a plugin or a precompute ahead of time. Logged
  // once it's done, so durationMs is how long the wait was
  on('session.compact', async ($, e, next) => {
    const startedMs = await $.clock.now()
    let fields: Record<string, unknown> = { outcome: 'threw' }
    try {
      const result = await next(e)
      fields =
        result.skip !== undefined
          ? { outcome: 'skipped' }
          : { outcome: 'compacted', tokensBefore: result.tokensBefore, tokensAfter: result.tokensAfter, usage: result.usage }
      return result
    } finally {
      const durationMs = (await $.clock.now()) - startedMs
      await log($, 'compact', { trigger: e.trigger, agentId: e.agentId, messages: e.messages.length, ...fields, durationMs })
    }
  }).catch(($, e, next) => next(e))

  // one `tool` row when the call ends (its time is the end; durationMs gives
  // the start), then the files it changed. A call that never ends, as when
  // Claude Code is killed mid-Bash, leaves no row
  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const ids = { tool, agentId: e.agentId }
    const named = !FILE_TOOLS.has(tool) ? undefined : 'file_path' in e ? e.file_path : 'notebook_path' in e ? e.notebook_path : undefined
    const startedMs = await $.clock.now()
    if (e.agentId === undefined) runningTools.set(e.tool_use_id, tool)

    let outcome = 'threw'
    try {
      const result = await next(e)
      outcome = result.deny !== undefined ? 'denied' : result.isError ? 'error' : 'ok'
      return result
    } finally {
      runningTools.delete(e.tool_use_id)
      const endedMs = await $.clock.now()
      const durationMs = endedMs - startedMs
      const asked = askedAt.get(e.tool_use_id)
      askedAt.delete(e.tool_use_id)
      if (e.agentId === undefined && turnClock) {
        if (QUESTION_TOOLS.has(tool)) turnClock.questionsMs += durationMs
        else if (asked !== undefined) turnClock.asked.push({ tool, from: asked, to: endedMs })
      }
      const [cwd, dir] = await Promise.all([$.session.cwd(), homeDir($)])
      const rules = await fileRules($, dir)
      const keep = (path: string | undefined) => (path && allowed(rules, path, cwd, dir) ? path : undefined)
      const file = keep(typeof named === 'string' ? named : undefined)
      const where = file ? resolvePath(cwd, file).replace(/\/[^/]*$/, '') : e.tool === 'Bash' ? cdTarget(e.command, cwd, dir) : undefined
      const repo = keep(await workRepo($, where, cwd))
      const entries: [string, Fields][] = [
        ['tool', { ...ids, file, repo, commandChars: e.tool === 'Bash' ? e.command.length : undefined, outcome, durationMs }],
      ]
      if (outcome === 'ok' && EDIT_TOOLS.has(tool)) {
        if (file) entries.push(['file_changed', { ...ids, path: file, via: 'tool' }])
      } else if (e.tool === 'Bash' && outcome !== 'denied') {
        const paths = await filesChangedSince($, startedMs, repo).catch(err => {
          $.ui.log(`${$.plugin.name}: ${String(err)}`)
          return []
        })
        for (const path of paths) if (keep(path)) entries.push(['file_changed', { ...ids, path, via: 'bash-window' }])
      }
      await logAll($, entries)
    }
  }).catch(($, e, next) => next(e))

  // when a main-loop call goes to a permission dialog (the verdict is passed
  // on untouched). In auto mode an ask may settle with no dialog, which the
  // turn's left-out time then shows as none
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    if (verdict.decision === 'ask' && e.tool_use_id && e.agentId === undefined) askedAt.set(e.tool_use_id, await $.clock.now())
    return verdict
  }).catch(($, e, next) => next(e))
}
