// The hub's accounts: people (from Hack Club Auth), their browser sessions,
// the devices the mod syncs from, and data deletion requests. Event tables
// come once the sync protocol settles.
//
// Every secret is stored as its sha256 (hex): a session cookie, a device
// token, a device code. The table alone lets no one in.

import { sql } from 'drizzle-orm'
import { bigint, boolean, check, index, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'

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

export type Person = typeof people.$inferSelect
export type DeviceToken = typeof deviceTokens.$inferSelect
export type DeletionRequest = typeof deletionRequests.$inferSelect
