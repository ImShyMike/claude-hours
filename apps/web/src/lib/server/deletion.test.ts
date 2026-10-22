import { expect, test } from 'vitest'
import { people } from '@claude-hours/db'
import { testDb } from '@claude-hours/db/testing'
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
