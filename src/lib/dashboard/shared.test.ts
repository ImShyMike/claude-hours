import { expect, test } from 'vitest'
import { modelName } from './shared'

test('model ids read as their family and version, old and new', () => {
  expect(modelName('claude-opus-5-5')).toBe('Opus 5.5')
  expect(modelName('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
  expect(modelName('claude-sonnet-4-20250514')).toBe('Sonnet 4')
  expect(modelName('claude-3-5-sonnet-20241022')).toBe('Sonnet 3.5')
  expect(modelName('claude-3-opus-20240229')).toBe('Opus 3')
  expect(modelName('some-other-model')).toBe('some-other-model')
})
