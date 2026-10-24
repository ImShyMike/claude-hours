import { expect, test } from 'vitest'
import { gzipped } from './compress'

const asking = (encoding?: string) => new Request('http://hub/api/summary', { headers: encoding ? { 'accept-encoding': encoding } : {} })
const answer = { range: { totalMs: 1 }, days: Array.from({ length: 50 }, (_, i) => ({ day: `2026-10-${i}`, ms: i })) }

test('a JSON answer goes out gzipped to a browser that takes it, and reads back the same', async () => {
  const res = gzipped(asking('gzip, deflate, br'), Response.json(answer, { headers: { 'server-timing': 'sum;dur=1' } }))
  expect(res.headers.get('content-encoding')).toBe('gzip')
  expect(res.headers.get('vary')).toContain('accept-encoding')
  expect(res.headers.get('server-timing')).toBe('sum;dur=1')
  const text = await new Response(res.body!.pipeThrough(new DecompressionStream('gzip'))).text()
  expect(JSON.parse(text)).toEqual(answer)
})

test('without gzip in Accept-Encoding, or for anything but JSON, the answer is untouched', () => {
  const json = Response.json(answer)
  expect(gzipped(asking(), json)).toBe(json)
  expect(gzipped(asking('br'), json)).toBe(json)
  const html = new Response('<p>hi</p>', { headers: { 'content-type': 'text/html' } })
  expect(gzipped(asking('gzip'), html)).toBe(html)
})
