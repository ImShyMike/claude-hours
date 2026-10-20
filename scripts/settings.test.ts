import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// runs the installer's settings.py against a throwaway home
const SCRIPT = join(import.meta.dir, 'settings.py')

function setup(settings?: unknown) {
  const home = mkdtempSync(join(tmpdir(), 'hackatime-install-'))
  mkdirSync(join(home, '.claude'))
  if (settings !== undefined) writeFileSync(join(home, '.claude/settings.json'), JSON.stringify(settings))
  const run = (action: string, dir: string) => {
    const r = Bun.spawnSync(['python3', SCRIPT, action, dir], { env: { ...process.env, HOME: home } })
    if (r.exitCode !== 0) throw new Error(r.stderr.toString())
    return r.stdout.toString()
  }
  const read = () => JSON.parse(readFileSync(join(home, '.claude/settings.json'), 'utf8'))
  return { home, run, read }
}

test('add sets the dir and keeps the rest of settings', () => {
  const { run, read } = setup({ theme: 'dark', env: { FOO: '1' } })
  run('add', '/repo/mod')
  expect(read()).toEqual({ theme: 'dark', env: { FOO: '1', CLAUDE_CODE_PLUGIN_DIRS: '/repo/mod' } })
  expect(run('add', '/repo/mod')).toContain('already has')
})

test('add works with no settings.json yet', () => {
  const { run, read } = setup()
  run('add', '/repo/mod')
  expect(read()).toEqual({ env: { CLAUDE_CODE_PLUGIN_DIRS: '/repo/mod' } })
})

test('add keeps other plugins and drops other copies of the mod', () => {
  const { home, run, read } = setup({ env: { CLAUDE_CODE_PLUGIN_DIRS: '~/other:~/.claude/mods/hook-analytics' } })
  mkdirSync(join(home, '.claude/mods/hook-analytics/.claude-plugin'), { recursive: true })
  writeFileSync(join(home, '.claude/mods/hook-analytics/.claude-plugin/plugin.json'), '{"name":"hook-analytics"}')
  run('add', '/repo/mod')
  expect(read().env).toEqual({ CLAUDE_CODE_PLUGIN_DIRS: '~/other:/repo/mod' })
})

test('remove takes out only the mod, and an empty env goes away', () => {
  const one = setup({ env: { CLAUDE_CODE_PLUGIN_DIRS: '~/other:/repo/mod' } })
  one.run('remove', '/repo/mod')
  expect(one.read().env).toEqual({ CLAUDE_CODE_PLUGIN_DIRS: '~/other' })

  // ~ and trailing slashes still match
  const two = setup({ theme: 'dark', env: { CLAUDE_CODE_PLUGIN_DIRS: '~/repo/mod/' } })
  two.run('remove', join(two.home, 'repo/mod'))
  expect(two.read()).toEqual({ theme: 'dark' })
})
