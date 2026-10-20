// Adds or removes the mod in ~/.claude/settings.json, for install.sh.
// Claude Code loads it from env.CLAUDE_CODE_PLUGIN_DIRS, a ':' separated list
// of folders, so this edits that one entry and leaves the rest alone.
//
//   bun scripts/settings.ts add <mod dir>
//   bun scripts/settings.ts remove <mod dir>

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const KEY = 'CLAUDE_CODE_PLUGIN_DIRS'
const MOD_NAME = 'hook-analytics'

type Settings = { env?: Record<string, string>; [key: string]: unknown }

const expand = (dir: string, home: string) => resolve(dir.replace(/^~(?=$|\/)/, home))

// another copy of this mod, which would log every event twice
export function isOurMod(dir: string, home = homedir()) {
  const manifest = join(expand(dir, home), '.claude-plugin/plugin.json')
  try {
    return JSON.parse(readFileSync(manifest, 'utf8')).name === MOD_NAME
  } catch {
    return false
  }
}

function withDirs(settings: Settings, dirs: string[]): Settings {
  const env = { ...settings.env }
  if (dirs.length) env[KEY] = dirs.join(':')
  else delete env[KEY]
  const next: Settings = { ...settings, env }
  if (!Object.keys(env).length) delete next.env
  return next
}

const dirsOf = (settings: Settings) => (settings.env?.[KEY] ?? '').split(':').filter(Boolean)

// puts `modDir` in the list once, dropping other copies of the mod
export function addMod(settings: Settings, modDir: string, home = homedir(), isMod = isOurMod) {
  const target = expand(modDir, home)
  const kept = dirsOf(settings).filter(dir => expand(dir, home) !== target && !isMod(dir, home))
  return withDirs(settings, [...kept, target])
}

export function removeMod(settings: Settings, modDir: string, home = homedir()) {
  const target = expand(modDir, home)
  return withDirs(settings, dirsOf(settings).filter(dir => expand(dir, home) !== target))
}

if (import.meta.main) {
  const [action, modDir] = process.argv.slice(2)
  if ((action !== 'add' && action !== 'remove') || !modDir) {
    console.error('usage: bun scripts/settings.ts add|remove <mod dir>')
    process.exit(2)
  }
  const path = join(homedir(), '.claude/settings.json')
  const before = existsSync(path) ? readFileSync(path, 'utf8') : '{}'
  const settings = JSON.parse(before) as Settings
  const next = action === 'add' ? addMod(settings, modDir) : removeMod(settings, modDir)
  const text = `${JSON.stringify(next, null, 2)}\n`
  if (text === `${JSON.stringify(settings, null, 2)}\n`) {
    console.log(`  settings.json already ${action === 'add' ? 'has' : 'lacks'} the mod`)
  } else {
    if (existsSync(path)) await Bun.write(`${path}.bak`, before)
    await Bun.write(path, text)
    console.log(`  ${action === 'add' ? 'added the mod to' : 'removed the mod from'} ${path}${existsSync(`${path}.bak`) ? ' (old copy in settings.json.bak)' : ''}`)
  }
}
