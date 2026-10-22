// Connecting the mod, RFC 8628 style. The mod asks for a code pair
// (startDeviceCode), shows the person the user code and polls with the device
// code (pollDeviceCode). The person types the user code into /device while
// logged in and approves (decideDeviceCode); the next poll swaps the device
// code for a long-lived device token
import { and, desc, eq, gt, isNull, lt } from 'drizzle-orm'
import { deviceCodes, deviceTokens, people, sha256, type Db } from './db/index'
import { randomToken } from './tokens'

export const CODE_TTL_S = 600
export const POLL_INTERVAL_S = 5

// no vowels so codes never spell words, and nothing that reads like 0/O or 1/I
// (RFC 8628 section 6.1)
const ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ'

export function newUserCode() {
  let code = ''
  while (code.length < 8) {
    // 240 is the biggest multiple of 20 under 256, so every letter is as likely
    for (const byte of crypto.getRandomValues(new Uint8Array(16))) if (byte < 240 && code.length < 8) code += ALPHABET[byte % 20]
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`
}

// what someone typed (any case, spaces, dash or none) as a stored user code,
// or null when it can't be one
export function normalizeUserCode(input: string) {
  const letters = input.toUpperCase().replace(/[^A-Z]/g, '')
  if (letters.length !== 8 || [...letters].some(c => !ALPHABET.includes(c))) return null
  return `${letters.slice(0, 4)}-${letters.slice(4)}`
}

export async function startDeviceCode(db: Db, deviceName: string, now = new Date()) {
  await db.delete(deviceCodes).where(lt(deviceCodes.expiresAt, now))
  const deviceCode = randomToken()
  const expiresAt = new Date(now.getTime() + CODE_TTL_S * 1000)
  // a clash with a live user code is about 1 in 25 billion per live code,
  // but a retry is cheap
  for (let attempt = 0; ; attempt++) {
    const userCode = newUserCode()
    const rows = await db
      .insert(deviceCodes)
      .values({ deviceCodeHash: await sha256(deviceCode), userCode, deviceName, expiresAt, createdAt: now })
      .onConflictDoNothing({ target: deviceCodes.userCode })
      .returning({ userCode: deviceCodes.userCode })
    if (rows.length) return { deviceCode, userCode, expiresAt }
    if (attempt === 4) throw new Error('could not find a free user code')
  }
}

export type PollResult = { token: string } | { error: 'authorization_pending' | 'slow_down' | 'access_denied' | 'expired_token' | 'invalid_grant' }

export async function pollDeviceCode(db: Db, deviceCode: string, now = new Date()): Promise<PollResult> {
  const hash = await sha256(deviceCode)
  return db.transaction(async tx => {
    const [row] = await tx.select().from(deviceCodes).where(eq(deviceCodes.deviceCodeHash, hash)).for('update')
    if (!row) return { error: 'invalid_grant' }
    if (row.expiresAt <= now) return { error: 'expired_token' }
    if (row.deniedAt) {
      await tx.delete(deviceCodes).where(eq(deviceCodes.deviceCodeHash, hash))
      return { error: 'access_denied' }
    }
    if (row.approvedAt && row.personId !== null) {
      // the code is spent the moment it's swapped, so a second poll can't
      // mint a second token
      await tx.delete(deviceCodes).where(eq(deviceCodes.deviceCodeHash, hash))
      const token = randomToken('hct_')
      await tx.insert(deviceTokens).values({ tokenHash: await sha256(token), personId: row.personId, name: row.deviceName, createdAt: now })
      return { token }
    }
    // a second of slack, so a poll that wakes up a hair early isn't punished
    const tooSoon = row.lastPolledAt && now.getTime() - row.lastPolledAt.getTime() < (POLL_INTERVAL_S - 1) * 1000
    await tx.update(deviceCodes).set({ lastPolledAt: now }).where(eq(deviceCodes.deviceCodeHash, hash))
    return { error: tooSoon ? 'slow_down' : 'authorization_pending' }
  })
}

const pending = (userCode: string, now: Date) =>
  and(eq(deviceCodes.userCode, userCode), gt(deviceCodes.expiresAt, now), isNull(deviceCodes.approvedAt), isNull(deviceCodes.deniedAt))

// a code still waiting for someone to say yes or no, for the /device page
export async function findPendingCode(db: Db, userCode: string, now = new Date()) {
  const [row] = await db
    .select({ userCode: deviceCodes.userCode, deviceName: deviceCodes.deviceName, createdAt: deviceCodes.createdAt })
    .from(deviceCodes)
    .where(pending(userCode, now))
  return row ?? null
}

// false when the code is gone, expired or already decided
export async function decideDeviceCode(db: Db, userCode: string, personId: number, approve: boolean, now = new Date()) {
  const rows = await db
    .update(deviceCodes)
    .set(approve ? { personId, approvedAt: now } : { personId, deniedAt: now })
    .where(pending(userCode, now))
    .returning({ userCode: deviceCodes.userCode })
  return rows.length > 0
}

// the person a bearer token belongs to, or null once it's revoked
export async function authenticateDevice(db: Db, token: string, now = new Date()) {
  const tokenHash = await sha256(token)
  const [row] = await db
    .select({ person: people, deviceId: deviceTokens.id, lastSeenAt: deviceTokens.lastSeenAt })
    .from(deviceTokens)
    .innerJoin(people, eq(people.id, deviceTokens.personId))
    .where(eq(deviceTokens.tokenHash, tokenHash))
  if (!row) return null
  // once a minute is plenty for "last seen", and spares a write per request
  if (!row.lastSeenAt || now.getTime() - row.lastSeenAt.getTime() > 60_000)
    await db.update(deviceTokens).set({ lastSeenAt: now }).where(eq(deviceTokens.id, row.deviceId))
  return { person: row.person, deviceId: row.deviceId }
}

export function listDevices(db: Db, personId: number) {
  return db
    .select({ id: deviceTokens.id, name: deviceTokens.name, createdAt: deviceTokens.createdAt, lastSeenAt: deviceTokens.lastSeenAt })
    .from(deviceTokens)
    .where(eq(deviceTokens.personId, personId))
    .orderBy(desc(deviceTokens.createdAt))
}

// only ever someone's own device: the person id is part of the match
export async function revokeDevice(db: Db, personId: number, id: number) {
  const rows = await db
    .delete(deviceTokens)
    .where(and(eq(deviceTokens.id, id), eq(deviceTokens.personId, personId)))
    .returning({ id: deviceTokens.id })
  return rows.length > 0
}
