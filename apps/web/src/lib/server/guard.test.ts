import { expect, test } from 'vitest'
import { safeNext } from './guard'

test('next only ever points back into the site', () => {
  expect(safeNext('/device?code=WDJB-MJHT')).toBe('/device?code=WDJB-MJHT')
  for (const bad of [null, '', 'https://evil.com', '//evil.com', '/\\evil.com']) expect(safeNext(bad)).toBe('/')
})
