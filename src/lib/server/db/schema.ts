// The hub's accounts: people (from Hack Club Auth), their browser sessions,
// the devices the mod syncs from and data deletion requests. Then what the
// mod sends: runs, a table per event type, draft timelines and quarantine,
// each named with a leading _ so they sort apart from the accounts.
//
// Every secret is stored as its sha256 (hex): a session cookie, a device
// token, a device code. The table alone lets no one in.

import { sql } from 'drizzle-orm'
import { bigint, boolean, check, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'
import type { PgColumnBuilderBase } from 'drizzle-orm/pg-core'

const id = () => bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity()
const personRef = (name = 'person_id') =>
  bigint(name, { mode: 'number' })
    .notNull()
    .references(() => people.id, { onDelete: 'cascade' })
const at = (name: string) => timestamp(name, { withTimezone: true })
const createdAt = () => at('created_at').notNull().defaultNow()

// One per Hack Club Auth account, keyed by its `sub` (ident!...): an email can
// change, the sub can't. Admin isn't stored, it's ADMIN_EMAILS against a
// verified email on every request, so taking an email out of the env is enough
export const people = pgTable('people', {
  id: id(),
  sub: text('sub').notNull().unique(),
  name: text('name'),
  email: text('email'),
  emailVerified: boolean('email_verified').notNull().default(false),
  slackId: text('slack_id'),
  verificationStatus: text('verification_status'),
  createdAt: createdAt(),
  lastLoginAt: at('last_login_at'),
  // how long a quiet stretch still counts as active for them, picked on
  // /settings; none is settings.ts' default
  idleCapMin: integer('idle_cap_min'),
})

// A logged-in browser: the cookie holds the token, this holds its hash
export const sessions = pgTable(
  'sessions',
  {
    tokenHash: text('token_hash').primaryKey(),
    personId: personRef(),
    createdAt: createdAt(),
    expiresAt: at('expires_at').notNull(),
  },
  t => [index('sessions_person_idx').on(t.personId)],
)

// A device asking to be connected (the mod's login command), RFC 8628 style: the
// mod holds the device code and polls, the person types the user code into
// /device and approves. person_id is set once approved
export const deviceCodes = pgTable('device_codes', {
  deviceCodeHash: text('device_code_hash').primaryKey(),
  userCode: text('user_code').notNull().unique(),
  // what the mod says it runs on (a hostname), shown when approving
  deviceName: text('device_name').notNull(),
  personId: bigint('person_id', { mode: 'number' }).references(() => people.id, { onDelete: 'cascade' }),
  createdAt: createdAt(),
  expiresAt: at('expires_at').notNull(),
  approvedAt: at('approved_at'),
  // set when the person says no, so the mod can tell denied from expired
  deniedAt: at('denied_at'),
  // polls faster than the interval get told to slow down
  lastPolledAt: at('last_polled_at'),
})

// A connected device: the mod sends its token as a bearer. Revoking deletes it
export const deviceTokens = pgTable(
  'device_tokens',
  {
    id: id(),
    tokenHash: text('token_hash').notNull().unique(),
    personId: personRef(),
    name: text('name').notNull(),
    createdAt: createdAt(),
    lastSeenAt: at('last_seen_at'),
    // revoking keeps the row, so the runs it sent still say where from
    revokedAt: at('revoked_at'),
  },
  t => [index('device_tokens_person_idx').on(t.personId)],
)

// Someone asking for their data to be deleted; an admin approves or rejects
// it. At most one pending at a time
export const deletionRequests = pgTable(
  'deletion_requests',
  {
    id: id(),
    personId: personRef(),
    reason: text('reason'),
    status: text('status', { enum: ['pending', 'approved', 'rejected'] })
      .notNull()
      .default('pending'),
    requestedAt: at('requested_at').notNull().defaultNow(),
    decidedAt: at('decided_at'),
    decidedBy: bigint('decided_by', { mode: 'number' }).references(() => people.id, { onDelete: 'set null' }),
  },
  t => [
    uniqueIndex('deletion_requests_one_pending')
      .on(t.personId)
      .where(sql`${t.status} = 'pending'`),
    check('deletion_requests_status', sql`${t.status} in ('pending', 'approved', 'rejected')`),
  ],
)

// One run of a session's file: from a header (a new session, or a resume) to
// the next, keyed by the header's start. The drafts sidecar is one run per
// session with start 0. acked is how many of its rows the hub holds, always
// rows 0 to acked - 1 (see the sync protocol in docs/how-it-works.md)
export const runs = pgTable(
  '_runs',
  {
    id: id(),
    personId: personRef(),
    session: text('session').notNull(),
    stream: text('stream', { enum: ['events', 'drafts'] }).notNull(),
    // the device that sent the run's first rows; null for runs from before
    // devices were kept, or imported by hand
    deviceId: bigint('device_id', { mode: 'number' }).references(() => deviceTokens.id, { onDelete: 'set null' }),
    start: bigint('start', { mode: 'number' }).notNull(),
    // the header's fields, events runs only
    v: integer('v'),
    cwd: text('cwd'),
    root: text('root'),
    rootName: text('root_name'),
    headerExtra: jsonb('header_extra').$type<Record<string, unknown>>(),
    acked: integer('acked').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: at('updated_at').notNull().defaultNow(),
  },
  t => [uniqueIndex('_runs_key').on(t.personId, t.session, t.stream, t.start)],
)

// Every row of a run, by its n. Its own fields go in typed columns named like
// the JSON field; a field the table doesn't know, or a value that doesn't fit
// its column (a null, say), goes in extra, so a row always comes back exactly
// as the mod wrote it. A row has t (ms since the run's start) or at (epoch ms)
const ms = (name: string) => bigint(name, { mode: 'number' })
const runRow = () => ({
  runId: bigint('run_id', { mode: 'number' })
    .notNull()
    .references(() => runs.id, { onDelete: 'cascade' }),
  n: integer('n').notNull(),
})
const eventTable = <C extends Record<string, PgColumnBuilderBase>>(name: string, columns: C) =>
  pgTable(name, { ...runRow(), t: ms('t'), at: ms('at'), ...columns, extra: jsonb('extra').$type<Record<string, unknown>>() }, t => [
    primaryKey({ columns: [t.runId, t.n] }),
  ])

const draftColumns = () => ({
  composeMs: ms('compose_ms'),
  typingMs: ms('typing_ms'),
  edits: integer('edits'),
  typedChars: integer('typed_chars'),
  pastedChars: integer('pasted_chars'),
  deletedChars: integer('deleted_chars'),
  fixes: integer('fixes'),
  rewrites: integer('rewrites'),
  rewrittenChars: integer('rewritten_chars'),
  pauses: integer('pauses'),
  breaks: integer('breaks'),
  longestPauseMs: ms('longest_pause_ms'),
  wordDeletes: integer('word_deletes'),
  lineKills: integer('line_kills'),
  draftId: text('draft_id'),
})
const turnColumns = () => ({
  turnId: text('turn_id'),
  agentId: text('agent_id'),
  reason: text('reason'),
  durationMs: ms('duration_ms'),
  usage: jsonb('usage'),
  waits: jsonb('waits'),
  answerChars: integer('answer_chars'),
  toolsRunning: jsonb('tools_running'),
})

export const sessionStarts = eventTable('_session_starts', { surface: text('surface'), isInteractive: boolean('is_interactive') })
export const sessionEnds = eventTable('_session_ends', { reason: text('reason') })
export const prompts = eventTable('_prompts', {
  words: integer('words'),
  chars: integer('chars'),
  origin: text('origin'),
  command: text('command'),
  isMeta: boolean('is_meta'),
  midTurn: boolean('mid_turn'),
  images: integer('images'),
  audio: integer('audio'),
  documents: integer('documents'),
  ...draftColumns(),
})
export const abandonedDrafts = eventTable('_abandoned_drafts', { ...draftColumns(), how: text('how'), endedAt: ms('ended_at') })
export const turnEnds = eventTable('_turn_ends', turnColumns())
export const interrupts = eventTable('_interrupts', turnColumns())
export const compacts = eventTable('_compacts', {
  trigger: text('trigger'),
  agentId: text('agent_id'),
  messages: integer('messages'),
  outcome: text('outcome'),
  tokensBefore: integer('tokens_before'),
  tokensAfter: integer('tokens_after'),
  usage: jsonb('usage'),
  durationMs: ms('duration_ms'),
})
export const toolCalls = eventTable('_tool_calls', {
  tool: text('tool'),
  agentId: text('agent_id'),
  file: text('file'),
  repo: text('repo'),
  repoName: text('repo_name'),
  commandChars: integer('command_chars'),
  outcome: text('outcome'),
  durationMs: ms('duration_ms'),
})
export const fileChanges = eventTable('_file_changes', { tool: text('tool'), agentId: text('agent_id'), path: text('path'), via: text('via') })
export const cwdChanges = eventTable('_cwd_changes', { cwd: text('cwd'), root: text('root'), rootName: text('root_name') })
// an event type the hub doesn't know yet: everything but t/at is in extra
export const otherEvents = eventTable('_other_events', { event: text('event').notNull() })

// which table each event goes to; anything else goes to otherEvents
export const eventTables = {
  session_start: sessionStarts,
  session_end: sessionEnds,
  prompt: prompts,
  draft_abandoned: abandonedDrafts,
  turn_end: turnEnds,
  interrupt: interrupts,
  compact: compacts,
  tool: toolCalls,
  file_changed: fileChanges,
  cwd_changed: cwdChanges,
}

// a draft's edit timeline, the drafts sidecar's rows (shapes only, no text)
export const draftTimelines = pgTable(
  '_draft_timelines',
  {
    ...runRow(),
    v: integer('v'),
    draftId: text('draft_id'),
    outcome: text('outcome'),
    startedAt: ms('started_at'),
    durationMs: ms('duration_ms'),
    initialShape: text('initial_shape'),
    initialCursor: integer('initial_cursor'),
    steps: text('steps'),
    truncated: boolean('truncated'),
    extra: jsonb('extra').$type<Record<string, unknown>>(),
  },
  t => [primaryKey({ columns: [t.runId, t.n] })],
)

// rows that couldn't be read as an event or a timeline at all, kept to look at
export const quarantine = pgTable(
  '_quarantine',
  {
    id: id(),
    personId: personRef(),
    session: text('session').notNull(),
    stream: text('stream').notNull(),
    start: bigint('start', { mode: 'number' }).notNull(),
    n: integer('n').notNull(),
    row: jsonb('row'),
    reason: text('reason').notNull(),
    receivedAt: at('received_at').notNull().defaultNow(),
  },
  t => [index('_quarantine_person_idx').on(t.personId)],
)

export type Person = typeof people.$inferSelect
export type DeviceToken = typeof deviceTokens.$inferSelect
export type DeletionRequest = typeof deletionRequests.$inferSelect
