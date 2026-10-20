import { expect, test } from 'bun:test'
import { addMod, removeMod } from './settings'

const home = '/home/me'
const none = () => false

test('addMod sets the dir and keeps the rest of settings', () => {
  const next = addMod({ theme: 'dark', env: { FOO: '1' } }, '/repo/mod', home, none)
  expect(next).toEqual({ theme: 'dark', env: { FOO: '1', CLAUDE_CODE_PLUGIN_DIRS: '/repo/mod' } })
})

test('addMod keeps other plugins, skips duplicates and drops other copies of the mod', () => {
  const settings = { env: { CLAUDE_CODE_PLUGIN_DIRS: '~/other:~/.claude/mods/hook-analytics:/repo/mod' } }
  const isMod = (dir: string) => dir.includes('hook-analytics')
  expect(addMod(settings, '/repo/mod', home, isMod).env).toEqual({ CLAUDE_CODE_PLUGIN_DIRS: '~/other:/repo/mod' })
})

test('removeMod takes out only the mod, and empty env goes away', () => {
  expect(removeMod({ env: { CLAUDE_CODE_PLUGIN_DIRS: '~/other:/repo/mod' } }, '/repo/mod', home).env).toEqual({
    CLAUDE_CODE_PLUGIN_DIRS: '~/other',
  })
  expect(removeMod({ theme: 'dark', env: { CLAUDE_CODE_PLUGIN_DIRS: '/repo/mod' } }, '/repo/mod', home)).toEqual({ theme: 'dark' })
  // ~ and trailing slashes still match
  expect(removeMod({ env: { CLAUDE_CODE_PLUGIN_DIRS: '~/repo/mod/' } }, '/home/me/repo/mod', home)).toEqual({})
})
