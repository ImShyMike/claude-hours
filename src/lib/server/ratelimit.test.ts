import { expect, test } from 'vitest'
import { rateLimiter } from './ratelimit'

test('allows the limit per window, per key', () => {
  const allow = rateLimiter(2, 1000)
  expect([allow('a', 0), allow('a', 1), allow('a', 2), allow('b', 2)]).toEqual([true, true, false, true])
  expect(allow('a', 1000)).toBe(true)
})
