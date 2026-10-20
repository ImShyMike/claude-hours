import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ingest, mintToken, upload, viewer, whoIs } from './hub'
import { loadEvents } from './load'

const scratch = () => mkdtempSync(join(tmpdir(), 'hackatime-hub-'))
const bytes = (s: string) => new TextEncoder().encode(s)

test('ingest appends only what it lacks, and repeats are harmless', async () => {
  const path = join(scratch(), 'a.jsonl')
  expect(await ingest(path, 0, bytes('one\ntwo\n'))).toEqual({ status: 200, length: 8 })
  // the same send again, then one that overlaps the end
  expect(await ingest(path, 0, bytes('one\ntwo\n'))).toEqual({ status: 200, length: 8 })
  expect(await ingest(path, 4, bytes('two\nthree\n'))).toEqual({ status: 200, length: 14 })
  expect(readFileSync(path, 'utf8')).toBe('one\ntwo\nthree\n')
  // ahead of the file: told where it ends
  expect(await ingest(path, 99, bytes('x\n'))).toEqual({ status: 409, length: 14 })
  // a send that starts mid-line in the file, or whose overlap ends mid-line
  // in the body, is refused
  expect(await ingest(path, 12, bytes('e\nfour\n'))).toEqual({ status: 409, length: 14 })
  expect(await ingest(path, 8, bytes('thr\nfour\n'))).toEqual({ status: 409, length: 14 })
  expect(readFileSync(path, 'utf8')).toBe('one\ntwo\nthree\n')
})

test('ingest keeps parallel sends to one file in order', async () => {
  const path = join(scratch(), 'a.jsonl')
  const rows = Array.from({ length: 20 }, (_, i) => `${i}\n`)
  let offset = 0
  await Promise.all(
    rows.map(row => {
      const at = offset
      offset += row.length
      return ingest(path, at, bytes(row))
    }),
  )
  expect(readFileSync(path, 'utf8')).toBe(rows.join(''))
})

const post = (token: string | undefined, id: string, kind: string, offset: number | string, body: string) =>
  new Request(`http://hub/v1/sessions/${id}/${kind}?offset=${offset}`, {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body,
  })

test('uploads land under the token\'s person, never one the request names', async () => {
  const hub = scratch()
  const token = await mintToken(hub, 'ada')
  const header = `${JSON.stringify({ v: 1, event: 'session', start: Date.parse('2026-10-19T12:00:00Z'), cwd: '/home/ada/code/x' })}\n`
  const row = `${JSON.stringify({ t: 0, event: 'prompt', words: 3 })}\n`

  const res = await upload(hub, post(token, 'sess-1', 'events', 0, header + row), 'sess-1', 'events')
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ length: bytes(header + row).length })
  expect((await loadEvents(join(hub, 'people', 'ada'))).map(e => [e.sessionId, e.event])).toEqual([['sess-1', 'prompt']])

  // a resumed session's next part, with its own header, reads on from it
  const more = `${JSON.stringify({ v: 1, event: 'session', start: Date.parse('2026-10-19T13:00:00Z'), cwd: '/home/ada/code/x' })}\n${row}`
  await upload(hub, post(token, 'sess-1', 'events', bytes(header + row).length, more), 'sess-1', 'events')
  expect((await loadEvents(join(hub, 'people', 'ada'))).map(e => e.ts)).toEqual(['2026-10-19T12:00:00.000Z', '2026-10-19T13:00:00.000Z'])
})

test('uploads refuse strangers, odd names and torn lines', async () => {
  const hub = scratch()
  const token = await mintToken(hub, 'ada')
  const status = async (req: Request, id: string, kind: string) => (await upload(hub, req, id, kind)).status
  expect(await status(post(undefined, 's', 'events', 0, 'x\n'), 's', 'events')).toBe(401)
  expect(await status(post('nope', 's', 'events', 0, 'x\n'), 's', 'events')).toBe(401)
  expect(await status(post(token, '..', 'events', 0, 'x\n'), '..', 'events')).toBe(404)
  expect(await status(post(token, 's', 'secrets', 0, 'x\n'), 's', 'secrets')).toBe(404)
  expect(await status(post(token, 's', 'events', -1, 'x\n'), 's', 'events')).toBe(400)
  expect(await status(post(token, 's', 'events', 'abc', 'x\n'), 's', 'events')).toBe(400)
  expect(await status(post(token, 's', 'events', 0, '{"half'), 's', 'events')).toBe(400)
  // a browser's cookie is no upload token
  const cookie = new Request('http://hub/v1/sessions/s/events?offset=0', { method: 'POST', headers: { cookie: `hackatime=${token}` }, body: 'x\n' })
  expect(await status(cookie, 's', 'events')).toBe(401)
})

test('people see their own data, and an admin anyone\'s', async () => {
  const hub = scratch()
  const ada = await mintToken(hub, 'ada')
  const boss = await mintToken(hub, 'miggy', true)
  const view = (token: string, person?: string) =>
    viewer(hub, new Request(`http://hub/api/events${person ? `?person=${person}` : ''}`, { headers: { cookie: `hackatime=${token}` } }))
  expect((await view(ada))?.person).toBe('ada')
  expect((await view(ada, 'miggy'))?.person).toBe('ada')
  expect((await view(boss, 'ada'))?.person).toBe('ada')
  expect((await view(boss, '../etc'))?.person).toBe('miggy')
  expect(await view('nope')).toBeUndefined()
  // only hashes are kept
  expect(readFileSync(join(hub, 'tokens.json'), 'utf8')).not.toContain(ada)
  expect(await whoIs(hub, ada)).toEqual({ person: 'ada' })
})
