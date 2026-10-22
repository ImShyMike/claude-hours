import { expect, test } from 'vitest'
import { people } from './db/index'
import { testDb } from './db/testing'
import { isAdmin, upsertPerson } from './people'
import { createSession, deleteSession, validateSession } from './sessions'

const DAY = 86_400_000
const t0 = new Date(Date.UTC(2026, 9, 21))
const after = (days: number) => new Date(t0.getTime() + days * DAY)

test('a session lasts 30 days, and gets renewed once past half of that', async () => {
  const db = await testDb()
  const [ana] = await db.insert(people).values({ sub: 'ident!ana' }).returning()
  const { token } = await createSession(db, ana!.id, t0)

  expect(await validateSession(db, token, after(10))).toMatchObject({ person: { id: ana!.id }, renewed: false })
  const renewed = await validateSession(db, token, after(20))
  expect(renewed).toMatchObject({ renewed: true, expiresAt: after(50) })
  // without the renewal this would have expired on day 30
  expect(await validateSession(db, token, after(45))).not.toBeNull()
  expect(await validateSession(db, token, after(80))).toBeNull()
  expect(await validateSession(db, 'not a token', after(1))).toBeNull()
})

test('logging out kills the session', async () => {
  const db = await testDb()
  const [ana] = await db.insert(people).values({ sub: 'ident!ana' }).returning()
  const { token } = await createSession(db, ana!.id, t0)
  await deleteSession(db, token)
  expect(await validateSession(db, token, t0)).toBeNull()
})

test('a login refreshes the person it matches by sub', async () => {
  const db = await testDb()
  const first = await upsertPerson(db, { sub: 'ident!ana', name: 'Ana', email: 'ana@old.com' }, t0)
  const again = await upsertPerson(db, { sub: 'ident!ana', name: 'Ana B', email: 'ana@new.com', email_verified: true }, after(1))
  expect(again).toMatchObject({ id: first.id, name: 'Ana B', email: 'ana@new.com', emailVerified: true, lastLoginAt: after(1) })
})

test('admin needs a verified email on the list', async () => {
  const db = await testDb()
  const admins = ['ana@hackclub.com']
  const verified = await upsertPerson(db, { sub: 'a', email: 'Ana@HackClub.com', email_verified: true })
  const unverified = await upsertPerson(db, { sub: 'b', email: 'ana@hackclub.com' })
  const other = await upsertPerson(db, { sub: 'c', email: 'bo@hackclub.com', email_verified: true })
  expect([verified, unverified, other].map(p => isAdmin(p, admins))).toEqual([true, false, false])
})
