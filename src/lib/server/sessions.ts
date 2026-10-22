// Browser sessions: a random token in an httpOnly cookie, its hash in the
// sessions table. A session past half its life gets pushed out again, so
// someone who keeps visiting stays logged in
import { eq } from 'drizzle-orm'
import { people, sessions, sha256, type Db } from './db/index'
import type { Cookies } from '@sveltejs/kit'
import { randomToken } from './tokens'

export const SESSION_COOKIE = 'session'
const LIFETIME_MS = 30 * 86_400_000

export async function createSession(db: Db, personId: number, now = new Date()) {
  const token = randomToken()
  const expiresAt = new Date(now.getTime() + LIFETIME_MS)
  await db.insert(sessions).values({ tokenHash: await sha256(token), personId, expiresAt })
  return { token, expiresAt }
}

// the person behind a cookie, or null. `renewed` says the cookie needs
// sending again with the new expiry
export async function validateSession(db: Db, token: string, now = new Date()) {
  const tokenHash = await sha256(token)
  const [row] = await db
    .select({ person: people, expiresAt: sessions.expiresAt })
    .from(sessions)
    .innerJoin(people, eq(people.id, sessions.personId))
    .where(eq(sessions.tokenHash, tokenHash))
  if (!row) return null
  if (row.expiresAt <= now) {
    await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash))
    return null
  }
  if (row.expiresAt.getTime() - now.getTime() > LIFETIME_MS / 2) return { person: row.person, expiresAt: row.expiresAt, renewed: false }
  const expiresAt = new Date(now.getTime() + LIFETIME_MS)
  await db.update(sessions).set({ expiresAt }).where(eq(sessions.tokenHash, tokenHash))
  return { person: row.person, expiresAt, renewed: true }
}

export async function deleteSession(db: Db, token: string) {
  await db.delete(sessions).where(eq(sessions.tokenHash, await sha256(token)))
}

export function setSessionCookie(cookies: Cookies, token: string, expiresAt: Date) {
  cookies.set(SESSION_COOKIE, token, { path: '/', httpOnly: true, sameSite: 'lax', expires: expiresAt })
}
