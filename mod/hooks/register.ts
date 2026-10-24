import { atom, read, update } from 'claude-code'
import type { EngineInterface, PromptEditInput, PromptSubmitAttachment, Register } from 'claude-code'
import type { LastMode, SeenCompactions, StartedSessions, TranscriptRead } from '../types'

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
// folders never logged at all, {"ignore":[...]} (/time-track ignore), and
// where to send them, {"server":{"url":...,"token":...}} (/time-track login
// writes that part)
const CONFIG_FILE = `${LOG_DIR}/config.json`
// the hub build a downloaded mod came from, beside its plugin.json. A clone
// has none, so it's never updated from a hub
const RELEASE_FILE = '.claude-plugin/release.json'
// how far each session's files have reached the server: sent/<session>.json
const SENT_DIR = `${LOG_DIR}/sent`
// the hub's sync protocol, sent as X-Protocol
const PROTOCOL = 1
// one request's most, in whole lines: well under the hub's 5000 rows, and
// under the 512 KB body a Node server takes by default
const CHUNK_LINES = 4_000
const CHUNK_BYTES = 256 * 1024
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
const DRAFT_COUNTERS = [
  'pastedChars',
  'deletedChars',
  'fixes',
  'rewrites',
  'rewrittenChars',
  'pauses',
  'breaks',
  'longestPauseMs',
  'wordDeletes',
  'lineKills',
]

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
// files right in a working dir outside any repo, and one folder down
const SHALLOW_DEPTH = 2
// Claude Code's own churn under ~/.claude, this log included
const NOISY_HOME_DIRS = ['.claude/projects', '.claude/state', '.claude/analytics', '.claude/plugins']

type Fields = Record<string, unknown>

const startedSessions = atom({ plugin: 'time-track', key: 'startedSessions' } as const, [] as StartedSessions)
const seenCompactions = atom({ plugin: 'time-track', key: 'seenCompactions' } as const, [] as SeenCompactions)
const lastMode = atom({ plugin: 'time-track', key: 'lastMode' } as const, null as LastMode)
const transcriptRead = atom({ plugin: 'time-track', key: 'transcriptRead' } as const, null as TranscriptRead)

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
  for (let i = 0; i < shape.length;) {
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

// The permission mode (default, acceptEdits, plan, auto, dontAsk,
// bypassPermissions): only the classic hooks' input carries it, and their
// events fire for a module whether or not any settings hook is set. A `mode`
// row each time the main loop's changes, so a prompt in a new mode finds it
// by the time it's sent and a shift+tab mid-turn by the next tool or the end.
// A plugin above this one can send those events on past it, and then the
// transcript's prompts say which mode each was sent in (logFromTranscript)
async function noteMode($: EngineInterface, e: { permission_mode?: string; agent_id?: string }) {
  const mode = e.permission_mode
  if (e.agent_id !== undefined || !mode) return
  try {
    const [sessionId, at] = await Promise.all([$.session.id(), $.clock.now()])
    let changed = false
    await update($, lastMode, last => {
      if (last?.sessionId === sessionId && last.mode === mode) return last
      changed = true
      return { sessionId, at, mode }
    })
    if (changed) await log($, 'mode', { mode })
  } catch (err) {
    $.ui.log(`${$.plugin.name}: ${String(err)}`)
  }
}

let turnClock: { turnId: string; startedMs: number; questionsMs: number; asked: { tool: string; from: number; to: number }[] } | undefined

// [ms before the turn's end it opened, ms open, tool] per dialog. Several in
// one turn share the left-out time by how long each call ran past its ask.
// Exported for its tests: a test engine can't answer an ask, so a dialog's
// length can't be played through the hooks
export function dialogWaits(clock: NonNullable<typeof turnClock>, endMs: number, durationMs: number) {
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
const relative = (path: unknown, cwd: string) => (typeof path === 'string' && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path)

// The session file's header: written when the file is new, read back after a
// reload. A file too big to read back gets absolute times instead
async function headFor($: EngineInterface, path: string, sessionId: string, now: number, cwd: string, rows: Fields[], rooted: Fields) {
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
    rows.push({ v: FORMAT, event: 'session', start: now, cwd, ...rooted })
    head = { sessionId, start: now, cwd }
  }
  return head
}

// Appends go through one queue so parallel tool calls never interleave lines.
// The time and cwd are read when the event happens, not when it is written.
// Several entries go out in one append, and draft timelines in one more. An
// entry can bring its own time (epoch ms), for something found after it
// happened; one from before this file began belongs to an earlier file,
// unless it carries on (a mode), and then the latest such holds from the start
function logAll($: EngineInterface, entries: [event: string, fields: Fields, at?: number, carries?: boolean][], timelines: Fields[] = []) {
  const at = $.clock.now()
  const session = $.session.id()
  const where = $.session.cwd()
  queue = queue
    .then(async () => {
      const [now, sessionId, cwd, dir] = await Promise.all([at, session, where, homeDir($)])
      const path = `${dir}/${EVENTS_DIR}/${sessionId}.jsonl`
      const rows: Fields[] = []
      // the repo the cwd is in, beside it when that's a folder further up, so
      // a reader that can't see this disk (the hub) still names the project
      const root = await rootOf($, cwd)
      const rootName = root ? await remoteName($, root) : undefined
      const rooted = { ...(root && root !== cwd ? { root } : {}), ...(rootName ? { rootName } : {}) }
      // an ignored folder writes nothing, not even a header
      const ignored = await ignoredFolders($, dir)
      if (under(ignored, cwd) || (root && under(ignored, root))) return
      const h = await headFor($, path, sessionId, now, cwd, rows, rooted)
      const stamp = h.start === undefined ? { at: now } : { t: now - h.start }
      if (h.cwd !== cwd) rows.push({ ...stamp, event: 'cwd_changed', cwd, ...rooted })
      h.cwd = cwd
      const later: Fields[] = []
      let carried: { when: number; row: Fields } | undefined
      for (const [event, fields, when, carries] of entries) {
        const row = { event, ...compactRow(event, { ...fields, file: relative(fields.file, cwd), path: relative(fields.path, cwd) }) }
        if (when === undefined) later.push({ ...stamp, ...row })
        else if (h.start !== undefined && when >= h.start) later.push({ t: when - h.start, ...row })
        else if (carries && h.start !== undefined && (!carried || when >= carried.when)) carried = { when, row }
      }
      if (carried) rows.push({ t: 0, ...carried.row })
      rows.push(...later)
      if (timelines.length) await append($, `${dir}/${DRAFTS_DIR}/${sessionId}.jsonl`, timelines)
      await append($, path, rows)
    })
    .catch(err => $.ui.log(`${$.plugin.name}: ${String(err)}`))
  return queue
}

const log = ($: EngineInterface, event: string, fields: Fields = {}) => logAll($, [[event, fields]])

// A security plugin above skips session.compact here, and the session.append
// of its boundary too, so compactions come from the transcript instead: each
// leaves a compact_boundary entry, stamped when it finished. It skips the
// classic hooks too, so the permission mode comes from there as well: each
// prompt's entry says which mode it was sent in. Grepped, as a transcript
// runs to tens of MB, and for a prompt only its time and mode, never the
// line, which holds its text. A subagent's are in its own file. Only what was
// added since the last look is read, from a little before where that ended,
// so a line still being written then is read whole now; what's read twice is
// already seen
const TRANSCRIPT_OVERLAP = 64 * 1024
const BOUNDARY = '"subtype":"compact_boundary"'
const PROMPT_MODE = '","permissionMode":"'
const PROMPT_MODE_PAIR = '"timestamp":"[^"]*","permissionMode":"[A-Za-z]*"'
type Boundary = { uuid: string; timestamp: string; compactMetadata?: Record<string, unknown> }

async function readTranscript($: EngineInterface) {
  const [configDir, home, sessionId] = await Promise.all([$.env.get('CLAUDE_CONFIG_DIR'), homeDir($), $.session.id()])
  const done = await read($, transcriptRead)
  const from = done?.sessionId === sessionId ? Math.max(1, done.bytes - TRANSCRIPT_OVERLAP + 1) : 1
  // its size first, then the boundaries, then each prompt's time and mode
  const script =
    'for f in "$2"/projects/*/"$3".jsonl; do [ -f "$f" ] || continue; wc -c < "$f"; ' +
    'tail -c +"$6" "$f" | grep -F -e "$1"; tail -c +"$6" "$f" | grep -F -e "$4" | grep -oE -e "$5"; done'
  const argv = ['sh', '-c', script, 'sh', BOUNDARY, configDir || `${home}/.claude`, sessionId, PROMPT_MODE, PROMPT_MODE_PAIR, String(from)]
  const { stdout } = await $.process.run(argv, { timeoutMs: 2_000 })
  const boundaries: Boundary[] = []
  const modes: { at: number; mode: string }[] = []
  const [size, ...lines] = stdout.split('\n')
  const bytes = Number(size?.trim())
  if (size?.trim() && Number.isInteger(bytes)) await update($, transcriptRead, () => ({ sessionId, bytes }))
  for (const line of lines) {
    try {
      if (line.startsWith('"timestamp"')) {
        const { timestamp, permissionMode } = JSON.parse(`{${line}}`)
        const at = Date.parse(timestamp)
        if (!Number.isNaN(at) && permissionMode) modes.push({ at, mode: permissionMode })
        continue
      }
      const entry = JSON.parse(line)
      if (entry.type === 'system' && entry.subtype === 'compact_boundary' && !entry.isSidechain && typeof entry.uuid === 'string') boundaries.push(entry)
    } catch {}
  }
  return { boundaries, modes, sessionId }
}

// when the session.compact hook logged a main-thread compaction itself, where
// nothing skips it, so its boundary isn't logged a second time
const hookedCompactions: number[] = []
const HOOKED_SLACK_MS = 5_000
let scanning: Promise<void> = Promise.resolve()

// One compact row per boundary not seen yet, at the time it finished, and a
// mode row at each prompt sent in another mode than the last one logged
function logFromTranscript($: EngineInterface) {
  scanning = scanning
    .then(async () => {
      const { boundaries, modes, sessionId } = await readTranscript($)
      const entries: [string, Fields, number, boolean?][] = []
      const seen = new Set(await read($, seenCompactions))
      const fresh = boundaries.filter(b => !seen.has(b.uuid))
      if (fresh.length) await update($, seenCompactions, ids => [...ids, ...fresh.map(b => b.uuid)])
      for (const b of fresh) {
        const at = Date.parse(b.timestamp)
        if (Number.isNaN(at) || hookedCompactions.some(hooked => Math.abs(hooked - at) < HOOKED_SLACK_MS)) continue
        const m = b.compactMetadata ?? {}
        entries.push(['compact', { trigger: m.trigger, tokensBefore: m.preTokens, tokensAfter: m.postTokens, durationMs: m.durationMs, uuid: b.uuid }, at])
      }
      // prompts up to the last mode logged (by either way) were looked at already
      const last = await read($, lastMode)
      let latest = last?.sessionId === sessionId ? last : null
      for (const { at, mode } of modes) {
        if (latest && at <= latest.at) continue
        if (latest?.mode !== mode) entries.push(['mode', { mode }, at, true])
        latest = { sessionId, at, mode }
      }
      if (latest && latest !== last) await update($, lastMode, () => latest)
      if (entries.length) await logAll($, entries.sort((a, b) => a[2] - b[2]))
    })
    .catch(err => $.ui.log(`${$.plugin.name}: ${String(err)}`))
  return scanning
}

// Bash (and python run from it) can touch anything, so look for files under
// the working dir modified since the call started. Can't tell who did it.
// A working dir in no repo (a folder full of repos, say) is only looked at
// SHALLOW_DEPTH deep: walking all of it can outlast the timeout
async function filesChangedSince($: EngineInterface, startedMs: number, repo?: string) {
  const [cwd, dir] = await Promise.all([$.session.cwd(), homeDir($)])
  const scans: [string, string[]][] = []
  if (cwd !== '/' && cwd !== dir) scans.push([cwd, (await rootOf($, cwd)) ? [] : ['-maxdepth', String(SHALLOW_DEPTH)]])
  if (repo) scans.push([repo, []])
  if (!scans.length) return []
  const prune = PRUNE.flatMap((name, i) => (i === 0 ? ['-name', name] : ['-o', '-name', name]))
  const since = isoSeconds(startedMs)
  const found = await Promise.all(
    scans.map(([root, depth]) =>
      $.process.run(['find', root, ...depth, '(', ...prune, ')', '-prune', '-o', '-type', 'f', '-newermt', since, '-print'], { timeoutMs: 3_000 }),
    ),
  )
  const noisy = NOISY_HOME_DIRS.map(sub => `${dir}/${sub}/`)
  return found
    .flatMap(({ stdout }) => stdout.split('\n'))
    .filter(path => path && !noisy.some(prefix => path.startsWith(prefix)))
    .slice(0, MAX_PATHS_PER_CALL)
}

// Where a call worked when that's another repo than the cwd's: the git root
// of a file outside the cwd, or of where a Bash command cd's to first
// (`cd ../hub && make`). Only the root is logged, never the command.
// A worktree (a subagent's under .claude/worktrees, say) is the repo it was
// made from: its common git dir is that repo's .git
const roots = new Map<string, Promise<string | undefined>>()
function rootOf($: EngineInterface, dir: string) {
  let root = roots.get(dir)
  if (!root) {
    root = $.process
      .run(['git', '-C', dir, 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'], { timeoutMs: 2_000 })
      .then(r => {
        const [top, common] = r.exitCode === 0 ? r.stdout.trim().split('\n') : []
        if (!top) return undefined
        return common?.endsWith('/.git') && common !== `${top}/.git` ? common.slice(0, -'/.git'.length) : top
      })
      .catch(() => undefined)
    roots.set(dir, root)
  }
  return root
}

// A repo's name from its origin remote (git@github.com:hackclub/telescreen.git
// is telescreen), when that's not its folder's name: a clone into a scratch
// folder, say. Undefined when it has no origin or the names agree
const names = new Map<string, Promise<string | undefined>>()
function remoteName($: EngineInterface, root: string) {
  let name = names.get(root)
  if (!name) {
    name = $.process
      .run(['git', '-C', root, 'remote', 'get-url', 'origin'], { timeoutMs: 2_000 })
      .then(r => {
        const from = r.exitCode === 0 ? /([^/:]+?)(?:\.git)?\/?$/.exec(r.stdout.trim())?.[1] : undefined
        return from && from !== root.split('/').pop() ? from : undefined
      })
      .catch(() => undefined)
    names.set(root, name)
  }
  return name
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

// a repo's root (or a folder in no repo) and everything under it
async function ignoredFolders($: EngineInterface, dir: string) {
  const ignore = (await readConfig($, dir)).ignore
  return Array.isArray(ignore) ? ignore.filter((f): f is string => typeof f === 'string') : []
}

const under = (folders: string[], path: string) => folders.some(f => path === f || path.startsWith(`${f}/`))

function serverFrom(value: unknown): Server | undefined {
  const server = value as Record<string, unknown> | undefined
  if (typeof server?.url !== 'string' || typeof server.token !== 'string') return undefined
  return { url: server.url.replace(/\/+$/, ''), token: server.token }
}

async function serverOf($: EngineInterface, dir: string) {
  return serverFrom((await readConfig($, dir)).server)
}

// Uploads: the hub's sync protocol (docs/how-it-works.md in claude-hours). A
// session's events stream (the .gz's members, then the plain file) is a list
// of runs, each from a header to the next and keyed by its start, and a row is
// its index in its run; the drafts stream is one run, 0, a row per line. The
// hub holds a contiguous prefix of each run and answers how far that reaches,
// so any send can be repeated. sent/<session>.json keeps, for one hub, how
// many lines of each stream are in and the run the events stream is in at
// that point, plus the .gz sizes once a finished session is all in. A file
// from the old byte-offset uploads (no v: 2) counts as nothing sent.
//
// This runs on its own chain, never awaited by a hook: a slow server must not
// hold up the log or the person.
type Kind = (typeof KINDS)[number]
type Cursor = { lines: number; run?: number; header?: Fields; acked: number }
type Sent = { v: 2; url: string; events?: Cursor; drafts?: Cursor; gz?: [number, number] }
type RunOut = { session: string; stream: Kind; run: number; header?: Fields; from: number; rows: unknown[] }
type RunAnswer = { status?: string; acked?: number; error?: string }

let syncing: Promise<void> = Promise.resolve()
let warned = false
let version: Promise<string> | undefined

function sentPath(dir: string, sessionId: string) {
  return `${dir}/${SENT_DIR}/${sessionId}.json`
}

async function readSent($: EngineInterface, server: Server, dir: string, sessionId: string): Promise<Sent> {
  const path = sentPath(dir, sessionId)
  const fresh: Sent = { v: 2, url: server.url }
  if (!(await $.fs.exists(path).catch(() => false))) return fresh
  try {
    const sent = JSON.parse(String(await $.fs.read(path)))
    return sent?.v === 2 && sent.url === server.url ? sent : fresh
  } catch {
    return fresh
  }
}

// the stream's lines from line `from` on, as many as one request takes; a
// last line with no newline is still being written, so it waits
async function linesFrom($: EngineInterface, path: string, from: number) {
  const script = '{ [ -f "$1.gz" ] && gzip -dc "$1.gz" 2>/dev/null; [ -f "$1" ] && cat "$1"; } | tail -n +$(($2 + 1)) | head -n $3 | head -c $4'
  const argv = ['sh', '-c', script, 'sh', path, String(from), String(CHUNK_LINES), String(CHUNK_BYTES)]
  const { stdout } = await $.process.run(argv, { timeoutMs: 5_000 })
  const lines = stdout.split('\n')
  lines.pop()
  return lines
}

// a line that isn't JSON goes as it is, so it keeps its place (the hub
// quarantines it)
function rowOf(line: string): unknown {
  try {
    return JSON.parse(line)
  } catch {
    return line
  }
}

const isHeader = (row: unknown): row is Fields & { start: number } =>
  !!row && typeof row === 'object' && (row as Fields).event === 'session' && Number.isSafeInteger((row as Fields).start)

function versionOf($: EngineInterface) {
  return (version ??= $.fs
    .read(`${$.plugin.root}/.claude-plugin/plugin.json`)
    .then(text => String(JSON.parse(String(text)).version ?? '0'))
    .catch(() => '0'))
}

async function request($: EngineInterface, url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  const timeout = $.clock.sleep(UPLOAD_TIMEOUT_MS).then(() => {
    throw new Error(`no answer from ${new URL(url).origin} in ${UPLOAD_TIMEOUT_MS / 1000}s`)
  })
  const headers = { 'user-agent': `time-track/${await versionOf($)}`, ...init.headers }
  return Promise.race([$.http.fetch(url, { ...init, headers }), timeout])
}

const answerOf = (text: string): Record<string, unknown> => {
  try {
    const body = JSON.parse(text)
    return body && typeof body === 'object' ? body : {}
  } catch {
    return {}
  }
}

async function sendRuns($: EngineInterface, server: Server, runs: RunOut[]) {
  const res = await request($, `${server.url}/v1/events`, {
    method: 'POST',
    headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json', 'x-protocol': String(PROTOCOL) },
    body: JSON.stringify({ runs }),
  })
  const answer = answerOf(res.text)
  if (res.status === 401) throw new Error(`${server.url} turned down this computer's token, run /time-track login`)
  if (res.status === 400 && Array.isArray(answer.protocols))
    throw new Error(`${server.url} speaks protocol ${answer.protocols.join(', ')} and this mod ${PROTOCOL}, update the one behind`)
  if (!res.ok) throw new Error(`upload refused: ${res.status} ${res.text.slice(0, 200)}`)
  return (answer.runs ?? {}) as Record<string, RunAnswer>
}

// Sends one stream past what sent/ says the hub holds, a request at a time,
// until it's all in. A hub that holds less than that (it lost rows, or the
// file was sent from elsewhere) starts the stream over once: it skips what
// it has
async function pushStream($: EngineInterface, server: Server, dir: string, sessionId: string, sent: Sent, kind: Kind) {
  const path = `${dir}/${LOG_DIR}/${kind}/${sessionId}.jsonl`
  let restarted = false
  for (;;) {
    const at = sent[kind] ?? { lines: 0, acked: 0 }
    const lines = await linesFrom($, path, at.lines)
    if (!lines.length) return
    // a header starts a run; any other row goes on the run it's in, and
    // rows before the first header belong to none
    let { run, header, acked } = kind === 'drafts' ? { run: 0, header: undefined, acked: at.lines } : at
    let part: RunOut | undefined
    const runs: RunOut[] = []
    for (const line of lines) {
      const row = rowOf(line)
      if (kind === 'events' && isHeader(row)) {
        ;({ run, header, acked, part } = { run: row.start, header: row, acked: 0, part: undefined })
      } else if (run !== undefined) {
        if (!part) runs.push((part = { session: sessionId, stream: kind, run, header, from: acked, rows: [] }))
        part.rows.push(row)
        acked++
      }
    }
    const answers = runs.length ? await sendRuns($, server, runs) : {}
    const short = runs.find(r => {
      const answer = answers[`${sessionId}/${kind}/${r.run}`]
      if (answer?.status === 'invalid') throw new Error(`${server.url} refused ${sessionId}: ${answer.error ?? 'invalid'}`)
      return answer?.status !== 'ok' || !((answer.acked ?? 0) >= r.from + r.rows.length)
    })
    if (short) {
      if (restarted) throw new Error(`${server.url} keeps answering short for ${sessionId}`)
      restarted = true
      delete sent[kind]
    } else sent[kind] = kind === 'drafts' ? { lines: at.lines + lines.length, acked } : { lines: at.lines + lines.length, run, header, acked }
    await $.fs.write(sentPath(dir, sessionId), JSON.stringify(sent))
  }
}

async function pushSession($: EngineInterface, server: Server, dir: string, sessionId: string, sent: Sent) {
  for (const kind of KINDS) await pushStream($, server, dir, sessionId, sent, kind)
}

// How uploads are going, in $.store so /time-track status can tell in any
// session: when one last went through, and the last error
type Health = { okAt?: number; error?: { at: number; message: string } }

async function noteHealth($: EngineInterface, health: Health) {
  const was = ((await $.store.get('health').catch(() => undefined)) ?? {}) as Health
  await $.store.set('health', { ...was, ...health }).catch(() => undefined)
}

async function uploadWorked($: EngineInterface) {
  warned = false
  await noteHealth($, { okAt: await $.clock.now() })
}

// said once until an upload works again, remembered every time
async function uploadFailed($: EngineInterface, err: unknown) {
  const message = err instanceof Error ? err.message : String(err)
  if (!warned) $.ui.log(`${$.plugin.name}: upload paused: ${message}`)
  warned = true
  await noteHealth($, { error: { at: await $.clock.now(), message } }).catch(() => undefined)
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
      await uploadWorked($)
      showToday($, server).catch(() => undefined)
    })
    .catch(err => uploadFailed($, err))
}

// Finished sessions (.gz alone, no plain file and no pack under way) with
// their .gz sizes, the events' and the drafts'
async function finishedSessions($: EngineInterface, dir: string) {
  const list =
    'cd "$1" || exit 0; for f in events/*.jsonl.gz; do [ -e "$f" ] || continue; id=${f#events/}; id=${id%.jsonl.gz}; ' +
    'for p in events/$id.jsonl drafts/$id.jsonl events/$id.jsonl.packing drafts/$id.jsonl.packing; do [ -e "$p" ] && continue 2; done; ' +
    'd=0; [ -f "drafts/$id.jsonl.gz" ] && d=$(wc -c < "drafts/$id.jsonl.gz"); echo "$id $(wc -c < "$f") $d"; done'
  const { stdout } = await $.process.run(['sh', '-c', list, 'sh', `${dir}/${LOG_DIR}`], { timeoutMs: 5_000 })
  const found: { sessionId: string; gz: [number, number] }[] = []
  for (const line of stdout.split('\n')) {
    const [sessionId, e, d] = line.trim().split(/\s+/)
    if (sessionId && /^[\w-]{1,128}$/.test(sessionId)) found.push({ sessionId, gz: [Number(e), Number(d)] })
  }
  return found
}

// a .gz whose size matches what sent/ recorded is all in
const allIn = (sent: Sent, gz: [number, number]) => sent.gz?.[0] === gz[0] && sent.gz[1] === gz[1]

// Finished sessions not yet all sent: one that crashed, ran offline, ended
// after its last upload or came before the login. Only finished ones (.gz
// alone, no plain file and no pack under way), since a live session sends its
// own. Not awaited
function sweep($: EngineInterface) {
  syncing = syncing
    .then(async () => {
      const dir = await homeDir($)
      const server = await serverOf($, dir)
      if (!server) return
      for (const { sessionId, gz } of await finishedSessions($, dir)) {
        const sent = await readSent($, server, dir, sessionId)
        if (allIn(sent, gz)) continue
        await pushSession($, server, dir, sessionId, sent)
        sent.gz = gz
        await $.fs.write(sentPath(dir, sessionId), JSON.stringify(sent))
      }
      await uploadWorked($)
      showToday($, server).catch(() => undefined)
    })
    .catch(err => uploadFailed($, err))
}

// Logging in to a hub: the device flow (RFC 8628). /time-track login
// answers at once with a code to approve on the hub; a poll behind it saves
// the token once someone does, then sends everything not sent yet. A login
// command copied from the hub's settings carries a code approved already,
// swapped for the token straight away
const USAGE = 'usage: /time-track login <hub url> [code] | status | stats | ignore | statusline | update | logout'
// the newest login, so starting another stops the last one's poll
let loginId = 0

// config.json with the token in it, never readable by anyone else, not even
// for a moment between a write and a chmod
async function writeConfig($: EngineInterface, dir: string, config: Record<string, unknown>) {
  const script = 'umask 077 && cat > "$1.tmp" && mv "$1.tmp" "$1"'
  const { exitCode, stderr } = await $.process.run(['sh', '-c', script, 'sh', `${dir}/${CONFIG_FILE}`], {
    stdin: `${JSON.stringify(config, null, 2)}\n`,
  })
  if (exitCode !== 0) throw new Error(`couldn't save the config: ${stderr.trim()}`)
}

async function whoami($: EngineInterface, server: Server) {
  const res = await request($, `${server.url}/v1/me`, { headers: { authorization: `Bearer ${server.token}` } })
  if (res.status === 401) return undefined
  if (!res.ok) throw new Error(`${res.status} ${res.text.slice(0, 100)}`)
  const me = answerOf(res.text)
  return String(me.name ?? me.email ?? 'someone')
}

// saves the token, says who it is, and sends what's waiting
async function finishLogin($: EngineInterface, url: string, token: string) {
  const dir = await homeDir($)
  const server = { url, token }
  await writeConfig($, dir, { ...(await readConfig($, dir)), server })
  const who = await whoami($, server).catch(() => undefined)
  warned = false
  sweep($)
  syncSession($)
  return `logged in to ${url}${who ? ` as ${who}` : ''}`
}

async function startLogin($: EngineInterface, arg: string, approved: string) {
  const dir = await homeDir($)
  const url = (arg || (await serverOf($, dir))?.url || '').replace(/\/+$/, '')
  if (!/^https?:\/\/[^/\s]+/.test(url)) return `which hub? ${USAGE}`
  const hello = await request($, `${url}/v1/hello`).catch(() => undefined)
  const protocols = hello?.ok ? answerOf(hello.text).protocols : undefined
  if (!Array.isArray(protocols)) return `${url} doesn't answer like a claude-hours hub${hello ? ` (${hello.status})` : ''}`
  if (!protocols.includes(PROTOCOL)) return `${url} speaks protocol ${protocols.join(', ')} and this mod ${PROTOCOL}, update the one behind`
  const host = await $.process.run(['uname', '-n'], { timeoutMs: 1_000 }).catch(() => undefined)
  const deviceName = host?.stdout.trim() || 'Claude Code'
  if (approved) {
    loginId++
    const res = await request($, `${url}/v1/device/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ device_code: approved, device_name: deviceName }),
    })
    const answer = answerOf(res.text)
    if (res.ok && typeof answer.access_token === 'string') return finishLogin($, url, answer.access_token)
    if (answer.error === 'expired_token') return `that login command ran out, copy a new one from ${url}/settings`
    if (answer.error === 'invalid_grant') return `that login command was used already or got cut short, copy a new one from ${url}/settings`
    return `${url} wouldn't log in: ${res.status} ${String(answer.error ?? '')}`.trim()
  }
  const res = await request($, `${url}/v1/device/code`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ device_name: deviceName }),
  })
  const code = answerOf(res.text)
  if (!res.ok || typeof code.device_code !== 'string' || typeof code.user_code !== 'string')
    return `${url} wouldn't start a login: ${res.status} ${String(code.error ?? '')}`.trim()
  // built from the url typed here, which a hub behind a proxy may not know
  const verify = `${url}/device?code=${encodeURIComponent(code.user_code)}`
  const open = 'if command -v xdg-open >/dev/null; then xdg-open "$1"; elif command -v open >/dev/null; then open "$1"; fi'
  $.process.run(['sh', '-c', open, 'sh', verify], { timeoutMs: 3_000 }).catch(() => undefined)
  pollLogin($, url, code, ++loginId)
  return `open ${verify} and approve the code ${code.user_code} there. this computer logs in once you do`
}

// Not awaited: it waits as long as the code lasts
function pollLogin($: EngineInterface, url: string, code: Record<string, unknown>, id: number) {
  const run = async () => {
    let interval = Number(code.interval) || 5
    const deadline = (await $.clock.now()) + (Number(code.expires_in) || 600) * 1000
    while ((await $.clock.now()) < deadline) {
      await $.clock.sleep(interval * 1000)
      if (id !== loginId) return
      const res = await request($, `${url}/v1/device/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ device_code: code.device_code }),
      }).catch(() => undefined)
      // a dropped connection is worth another try while the code lasts
      if (!res) continue
      const answer = answerOf(res.text)
      if (res.ok && typeof answer.access_token === 'string') {
        $.ui.toast(`${$.plugin.name}: ${await finishLogin($, url, answer.access_token)}`)
        return
      }
      if (answer.error === 'authorization_pending') continue
      if (answer.error === 'slow_down') {
        interval += 5
        continue
      }
      throw new Error(
        answer.error === 'access_denied'
          ? 'it was denied'
          : answer.error === 'expired_token'
            ? 'the code ran out'
            : `${res.status} ${String(answer.error ?? '')}`,
      )
    }
    throw new Error('the code ran out')
  }
  run().catch(err => {
    if (id !== loginId) return
    const text = `${$.plugin.name}: login failed, ${err instanceof Error ? err.message : String(err)}`
    $.ui.toast(text)
    $.ui.log(text)
  })
}

// 3m ago, or 2 days ago past two days
function ago(ms: number) {
  if (ms < 60_000) return 'just now'
  return ms < 48 * 3_600_000 ? `${hm(ms)} ago` : `${Math.floor(ms / 86_400_000)} days ago`
}

// who this computer is logged in as, how uploads are going, and what's left out
async function loginStatus($: EngineInterface) {
  const dir = await homeDir($)
  const [server, ignored] = await Promise.all([serverOf($, dir), ignoredFolders($, dir)])
  const lines: string[] = []
  if (!server) lines.push(`not logged in. ${USAGE}`)
  else {
    const who = await whoami($, server).catch(err => err as Error)
    if (who instanceof Error) lines.push(`logged in to ${server.url}, which isn't answering (${who.message})`)
    else lines.push(who ? `logged in to ${server.url} as ${who}` : `${server.url} turned down this computer's token, run /time-track login`)
    const [now, health, finished] = await Promise.all([
      $.clock.now(),
      $.store.get('health').catch(() => undefined) as Promise<Health | undefined>,
      finishedSessions($, dir).catch(() => []),
    ])
    let waiting = 0
    for (const { sessionId, gz } of finished) if (!allIn(await readSent($, server, dir, sessionId), gz)) waiting++
    if (health?.okAt) lines.push(`last synced ${ago(now - health.okAt)}`)
    if (waiting) lines.push(`${waiting} finished ${waiting === 1 ? 'session' : 'sessions'} waiting to send`)
    if (health?.error && health.error.at > (health.okAt ?? 0)) lines.push(`last problem ${ago(now - health.error.at)}: ${health.error.message}`)
  }
  if (ignored.length) lines.push(`ignoring ${ignored.join(', ')}`)
  // the first line under Claude Code's "time-track:" when there's more than one
  return (lines.length > 1 ? ['', ...lines] : lines).join('\n')
}

// Leaves the repo this session is in (or its folder, in no repo) out of the
// log, or takes it back when it's out already. Rows already sent stay on the hub
async function toggleIgnore($: EngineInterface) {
  const [dir, cwd] = await Promise.all([homeDir($), $.session.cwd()])
  const folder = (await rootOf($, cwd)) ?? cwd
  const { ignore: _, ...rest } = await readConfig($, dir)
  const ignored = await ignoredFolders($, dir)
  const ignore = !ignored.includes(folder)
  const next = ignore ? [...ignored, folder] : ignored.filter(f => f !== folder)
  await writeConfig($, dir, next.length ? { ...rest, ignore: next } : rest)
  return ignore
    ? `ignoring ${folder}: nothing in it gets logged or sent from now on (what was sent before stays). /time-track ignore again to undo`
    : `logging ${folder} again`
}

// The hub's build of the mod, from /v1/hello: a version, and the files in it
// relative to the mod's folder
async function hubRelease($: EngineInterface, url: string) {
  const res = await request($, `${url}/v1/hello`)
  if (!res.ok) throw new Error(`${res.status}`)
  const mod = answerOf(res.text).mod as { version?: unknown; files?: unknown } | undefined
  if (typeof mod?.version !== 'string' || !Array.isArray(mod.files)) return undefined
  return { version: mod.version, files: mod.files.filter((f): f is string => typeof f === 'string') }
}

async function releaseOf($: EngineInterface) {
  const text = await $.fs.read(`${$.plugin.root}/${RELEASE_FILE}`).catch(() => '')
  try {
    const { version } = JSON.parse(String(text))
    return typeof version === 'string' ? version : undefined
  } catch {
    return undefined
  }
}

// a name inside the mod's folder, never out of it
const safeFile = (file: string) => /^[\w.-]+(\/[\w.-]+)*$/.test(file) && !file.split('/').includes('..')

// At session start, a toast when the hub has a newer mod. Not awaited
function nudgeUpdate($: EngineInterface) {
  ;(async () => {
    const mine = await releaseOf($)
    const server = mine && (await serverOf($, await homeDir($)))
    if (!server) return
    const theirs = await hubRelease($, server.url)
    if (theirs && theirs.version !== mine) $.ui.toast(`${$.plugin.name} has an update, run /time-track update`)
  })().catch(() => undefined)
}

// Downloads the hub's mod over this one: every file first, so a download cut
// short changes nothing, and release.json last, so a write cut short leaves
// this mod still asking for the update
async function updateMod($: EngineInterface) {
  const mine = await releaseOf($)
  if (!mine) return `this mod runs from ${$.plugin.root}, not from a hub's download: update it with git pull`
  const server = await serverOf($, await homeDir($))
  if (!server) return `not logged in, so there's no hub to update from. ${USAGE}`
  const release = await hubRelease($, server.url).catch(err => err as Error)
  if (release instanceof Error) return `${server.url} isn't answering (${release.message})`
  if (!release) return `${server.url} doesn't hand out the mod`
  if (release.version === mine) return 'already up to date'
  const bad = release.files.find(f => !safeFile(f))
  if (bad) return `${server.url} named a file outside the mod (${bad}), so nothing changed`
  const files = [...release.files.filter(f => f !== RELEASE_FILE), ...release.files.filter(f => f === RELEASE_FILE)]
  const texts = await Promise.all(
    files.map(async file => {
      const res = await request($, `${server.url}/install/mod/${file}`)
      if (!res.ok) throw new Error(`${file}: ${res.status}`)
      return res.text
    }),
  ).catch(err => err as Error)
  if (texts instanceof Error) return `couldn't download the update, so nothing changed (${texts.message})`
  for (const [i, file] of files.entries()) await $.fs.write(`${$.plugin.root}/${file}`, texts[i]!)
  return `updated ${$.plugin.name}. new sessions load it`
}

// forgets the token here and asks the hub to forget it too
async function logout($: EngineInterface) {
  loginId++
  const dir = await homeDir($)
  const { server, ...rest } = await readConfig($, dir)
  const saved = serverFrom(server)
  if (!saved) return 'not logged in'
  await writeConfig($, dir, rest)
  $.ui.status(undefined)
  // JSON, or the hub takes a bodyless DELETE for a cross-site form and refuses it
  const headers = { authorization: `Bearer ${saved.token}`, 'content-type': 'application/json' }
  const res = await request($, `${saved.url}/v1/me`, { method: 'DELETE', headers }).catch(() => undefined)
  return res?.ok || res?.status === 401
    ? `logged out of ${saved.url}`
    : `logged out here, but ${saved.url} didn't answer: revoke this computer at ${saved.url}/settings`
}

// 2h 05m, or 14m under an hour
function hm(ms: number) {
  const m = Math.round(ms / 60_000)
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`
}

type Stats = {
  today: { ms: number; sessions: number }
  week: { ms: number; projects: { project: string; ms: number }[] }
  allTime: { ms: number }
  dashboard: string
}

// the hub's count (the same as its dashboard), days in this computer's time zone
function statsOf($: EngineInterface, server: Server) {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
  return request($, `${server.url}/v1/stats?tz=${encodeURIComponent(tz)}`, {
    headers: { authorization: `Bearer ${server.token}` },
  }).catch(err => err as Error)
}

// Today's time pinned under the prompt, after a sync sent this turn's rows,
// asked of the hub at most once a minute. Off unless the config says
// "statusLine": true (/time-track statusline)
const STATUS_EVERY_MS = 60_000
let statusAt = 0

async function showToday($: EngineInterface, server: Server) {
  const now = await $.clock.now()
  if (now - statusAt < STATUS_EVERY_MS) return
  statusAt = now
  if ((await readConfig($, await homeDir($))).statusLine !== true) return
  const res = await statsOf($, server)
  if (res instanceof Error || !res.ok) return
  const { today } = answerOf(res.text) as Partial<Stats>
  if (typeof today?.ms === 'number') $.ui.status(`${hm(today.ms)} today`)
}

async function toggleStatusLine($: EngineInterface) {
  const dir = await homeDir($)
  const { statusLine, ...rest } = await readConfig($, dir)
  const show = statusLine !== true
  await writeConfig($, dir, show ? { ...rest, statusLine: true } : rest)
  if (!show) {
    $.ui.status(undefined)
    return 'hid the status line. /time-track statusline again to bring it back'
  }
  statusAt = 0
  const server = await serverOf($, dir)
  if (server) await showToday($, server)
  return `showing today's time under the prompt${server ? '' : ' once you log in'}`
}

// a few numbers from the hub, which does the counting
async function stats($: EngineInterface) {
  const server = await serverOf($, await homeDir($))
  if (!server) return `not logged in, so there's nothing counted yet. ${USAGE}`
  const res = await statsOf($, server)
  if (res instanceof Error) return `${server.url} isn't answering (${res.message})`
  if (res.status === 401) return `${server.url} turned down this computer's token, run /time-track login`
  if (!res.ok) return `${server.url} couldn't count (${res.status})`
  const { today, week, allTime, dashboard } = answerOf(res.text) as Stats
  const top = week.projects.map(p => `${p.project} ${hm(p.ms)}`).join(', ')
  // the first line under Claude Code's "time-track:", not beside it
  return [
    '',
    `today        ${hm(today.ms)} (${today.sessions} ${today.sessions === 1 ? 'session' : 'sessions'})`,
    `last 7 days  ${hm(week.ms)}`,
    `all time     ${hm(allTime.ms)}`,
    ...(top ? [`top this week: ${top}`] : []),
    `dashboard: ${dashboard}`,
  ].join('\n')
}

async function runCommand($: EngineInterface, args: string) {
  const [verb = '', arg = '', code = ''] = args.trim().split(/\s+/)
  if (verb === 'login') return startLogin($, arg, code)
  if (verb === 'status' || !verb) return loginStatus($)
  if (verb === 'logout') return logout($)
  if (verb === 'stats') return stats($)
  if (verb === 'ignore') return toggleIgnore($)
  if (verb === 'update') return updateMod($)
  if (verb === 'statusline') return toggleStatusLine($)
  return USAGE
}

// excluded always loses; with any includes, only those are logged
const allowed = (rules: FileRules, path: string, cwd: string, home: string) =>
  !rules.exclude.some(g => globMatches(g, path, cwd, home)) && (!rules.include.length || rules.include.some(g => globMatches(g, path, cwd, home)))

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
// placeholder by its own route, and the sent text carries it in full between
// <pasted_content id="…"> tags (several blocks may share an id). Its chars
// are the ones between the tags, less the newlines the box pads it with
const PASTE_BLOCK = /<pasted_content id="([^"]*)">\n*([\s\S]*?)\n*<\/pasted_content id="\1">/g

function foldedPasteChars(text: string) {
  let chars = 0
  for (const [, , pasted = ''] of text.matchAll(PASTE_BLOCK)) chars += [...pasted].length
  return chars
}

// images, audio and documents pasted or attached to a prompt, counted by
// kind: never their bytes or file names
function attachmentCounts(items: readonly PromptSubmitAttachment[] = []) {
  const count = (type: PromptSubmitAttachment['type']) => items.filter(a => a.type === type).length || undefined
  return { images: count('image'), audio: count('audio'), documents: count('document') }
}

// a prompt that was only a folded paste never started a draft, so it carries
// just its pasted chars
function sentFields(d: Draft | undefined, endMs: number, text: string) {
  const folded = foldedPasteChars(text)
  if (!d) return folded ? { pastedChars: folded } : {}
  return { ...draftFields(d, endMs), pastedChars: d.pastedChars + folded }
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
      startedAt: at,
      lastAt: at,
      typingMs: 0,
      edits: 0,
      typedChars: 0,
      pastedChars: 0,
      deletedChars: 0,
      fixes: 0,
      rewrites: 0,
      rewrittenChars: 0,
      pauses: 0,
      breaks: 0,
      longestPauseMs: 0,
      deleteRun: 0,
      wordDeletes: 0,
      lineKills: 0,
      id: `${at.toString(36)}-${e.text.length.toString(36)}`,
      initialShape: shapeOf(e.text),
      initialCursor: e.cursor,
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
    await $.command
      .register({
        name: 'time-track',
        description: 'Log in to a claude-hours hub to send it your analytics',
        argumentHint: 'login <hub url> [code] | status | stats | ignore | statusline | update | logout',
      })
      .catch(err => $.ui.log(`${$.plugin.name}: ${String(err)}`))
    const sessionId = await $.session.id()
    if (!(await read($, startedSessions)).includes(sessionId)) {
      await update($, startedSessions, ids => [...ids, sessionId])
      await log($, 'session_start', { surface: e.surface, isInteractive: e.isInteractive })
      sweep($)
      nudgeUpdate($)
    }
    return started
  })

  // /time-track login | status | logout
  on('command.run', { command: 'time-track' }, async ($, e) => ({ text: await runCommand($, e.args) })).catch(($, _, next) => ({
    text: `${$.plugin.name}: ${next.error.message ?? next.error.kind}`,
  }))

  // session.end gets 1.5 s for every hook: the session_end line plus any
  // abandoned drafts still waiting, a few appends at most
  on('session.end', async ($, e, next) => {
    // a draft still in the box at exit was never sent either
    if (draft) noteEmptied(await $.clock.now(), 'exit')
    settleEmptied()
    const { entries, timelines } = takeAbandoned()
    await logFromTranscript($)
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
          ...attachmentCounts(e.attachments),
          ...(e.origin.kind === 'composer' && sentFields(typed, at, e.text)),
        },
      ])
      if (typed) timelines.push(timelineOf(typed, 'sent', at))
      // a /compact since the last turn, or this prompt's mode if it's in the
      // transcript yet, found without holding the prompt up
      logFromTranscript($)
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

  on('classic.UserPromptSubmit', async ($, e, next) => (await noteMode($, e), next(e))).catch(($, e, next) => next(e))
  on('classic.PostToolUse', async ($, e, next) => (await noteMode($, e), next(e))).catch(($, e, next) => next(e))
  on('classic.Stop', async ($, e, next) => (await noteMode($, e), next(e))).catch(($, e, next) => next(e))

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
    // an auto compaction mid-turn or the prompt's mode, in before the sync below
    if (main) await logFromTranscript($)
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
  // once it's done, so durationMs is how long the wait was. Where a security
  // plugin skips this, logFromTranscript finds them in the transcript instead
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
      const endMs = await $.clock.now()
      if (e.agentId === undefined) hookedCompactions.push(endMs)
      await log($, 'compact', { trigger: e.trigger, agentId: e.agentId, messages: e.messages.length, ...fields, durationMs: endMs - startedMs })
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
      const [rules, ignored] = await Promise.all([fileRules($, dir), ignoredFolders($, dir)])
      const keep = (path: string | undefined) =>
        path && allowed(rules, path, cwd, dir) && !under(ignored, resolvePath(cwd, path)) ? path : undefined
      const file = keep(typeof named === 'string' ? named : undefined)
      const where = file ? resolvePath(cwd, file).replace(/\/[^/]*$/, '') : e.tool === 'Bash' ? cdTarget(e.command, cwd, dir) : undefined
      const repo = keep(await workRepo($, where, cwd))
      const repoName = repo ? await remoteName($, repo) : undefined
      const entries: [string, Fields][] = [
        ['tool', { ...ids, file, repo, repoName, commandChars: e.tool === 'Bash' ? e.command.length : undefined, outcome, durationMs }],
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
