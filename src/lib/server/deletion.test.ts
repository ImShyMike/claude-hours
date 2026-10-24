import { expect, test } from 'vitest'
import { eq } from 'drizzle-orm'
import { deletionRequests, people, prompts, runs } from './db/index'
import { testDb } from './db/testing'
import { decideDeletion, latestDeletion, pendingDeletions, requestDeletion, withdrawDeletion } from './deletion'

test('one pending request at a time, decided once', async () => {
  const db = await testDb()
  const [ana] = await db.insert(people).values({ sub: 'ident!ana' }).returning()
  const [admin] = await db.insert(people).values({ sub: 'ident!admin' }).returning()

  const request = await requestDeletion(db, ana!.id, 'bye')
  expect(request).not.toBeNull()
  expect(await requestDeletion(db, ana!.id, null)).toBeNull()
  expect(await pendingDeletions(db)).toMatchObject([{ request: { reason: 'bye' }, person: { sub: 'ident!ana' } }])

  expect(await decideDeletion(db, request!.id, admin!.id, false)).toBe(true)
  expect(await decideDeletion(db, request!.id, admin!.id, true)).toBe(false)
  expect(await latestDeletion(db, ana!.id)).toMatchObject({ status: 'rejected', decidedBy: admin!.id })

  // a rejected one doesn't block asking again, and withdrawing takes it back
  expect(await requestDeletion(db, ana!.id, null)).not.toBeNull()
  await withdrawDeletion(db, ana!.id)
  expect(await pendingDeletions(db)).toEqual([])
})

test("approving deletes the person's account and everything they sent, and nobody else's", async () => {
  const db = await testDb()
  const [ana] = await db.insert(people).values({ sub: 'ident!ana' }).returning()
  const [bo] = await db.insert(people).values({ sub: 'ident!bo' }).returning()
  const [admin] = await db.insert(people).values({ sub: 'ident!admin' }).returning()
  for (const person of [ana!, bo!]) {
    const [run] = await db.insert(runs).values({ personId: person.id, session: 's1', stream: 'events', start: 1 }).returning()
    await db.insert(prompts).values({ runId: run!.id, n: 0, t: 0 })
  }
  // bo asked too, and that request stays
  await requestDeletion(db, bo!.id, null)

  const request = await requestDeletion(db, ana!.id, null)
  expect(await decideDeletion(db, request!.id, admin!.id, true)).toBe(true)
  expect(await decideDeletion(db, request!.id, admin!.id, true)).toBe(false)

  expect(await db.select().from(people).where(eq(people.id, ana!.id))).toEqual([])
  expect((await db.select().from(runs)).map(r => r.personId)).toEqual([bo!.id])
  expect(await db.select().from(prompts)).toHaveLength(1)
  expect((await db.select().from(deletionRequests)).map(r => r.personId)).toEqual([bo!.id])
})
