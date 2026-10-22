import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { deletionRequests, people, sha256 } from './index'
import { testDb } from './testing'

test('the migrations apply, and a person is unique by their sub', async () => {
  const db = await testDb()
  await db.insert(people).values({ sub: 'ident!abc', name: 'Miggy' })
  await expect(db.insert(people).values({ sub: 'ident!abc' }).execute()).rejects.toThrow()
})

test('a person has at most one pending deletion request', async () => {
  const db = await testDb()
  const [me] = await db.insert(people).values({ sub: 'ident!abc' }).returning()
  await db.insert(deletionRequests).values({ personId: me!.id })
  await expect(db.insert(deletionRequests).values({ personId: me!.id }).execute()).rejects.toThrow()
  // once decided, a new one can be asked for
  await db.update(deletionRequests).set({ status: 'rejected' }).where(eq(deletionRequests.personId, me!.id))
  await db.insert(deletionRequests).values({ personId: me!.id })
})

test('secrets are kept as their sha256', async () => {
  expect(await sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
})
