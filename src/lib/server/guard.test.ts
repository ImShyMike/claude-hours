import { expect, test } from 'vitest'
import { people } from './db/index'
import { testDb } from './db/testing'
import { safeNext, viewerOf } from './guard'

test('next only ever points back into the site', () => {
  expect(safeNext('/device?code=WDJB-MJHT')).toBe('/device?code=WDJB-MJHT')
  for (const bad of [null, '', 'https://evil.com', '//evil.com', '/\\evil.com']) expect(safeNext(bad)).toBe('/')
})

test("only an admin's ?person= picks whose data it is", async () => {
  const db = await testDb()
  const [ana] = await db.insert(people).values({ sub: 'ident!ana' }).returning()
  const [bo] = await db.insert(people).values({ sub: 'ident!bo' }).returning()
  const url = new URL(`http://hub/api/events?person=${bo!.id}`)
  expect((await viewerOf(db, { person: ana!, admin: false }, url))?.id).toBe(ana!.id)
  expect((await viewerOf(db, { person: ana!, admin: true }, url))?.id).toBe(bo!.id)
  // nobody by that id, or garbage: your own
  expect((await viewerOf(db, { person: ana!, admin: true }, new URL('http://hub/?person=999')))?.id).toBe(ana!.id)
  expect((await viewerOf(db, { person: ana!, admin: true }, new URL('http://hub/?person=x')))?.id).toBe(ana!.id)
  expect(await viewerOf(db, { person: null, admin: false }, url)).toBeNull()
})
