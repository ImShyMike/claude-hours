import { readFileSync } from 'node:fs'
import { files, mod } from 'virtual:installer'
import { expect, test } from 'vitest'

test('the mod the hub hands out names its build, and install.sh downloads all of it', () => {
  expect(mod.version).toMatch(/^[0-9a-f]{12}$/)
  expect(JSON.parse(files['mod/.claude-plugin/release.json']!)).toEqual({ version: mod.version })
  // every file /time-track update asks for is one /install/ serves
  for (const file of mod.files) expect(files[`mod/${file}`]).toBeDefined()
  expect(Object.keys(files).filter(f => f.startsWith('mod/'))).toHaveLength(mod.files.length)

  const loop = /for file in ([^;]+); do\s+fetch "mod\/\$file"/.exec(readFileSync('install.sh', 'utf8'))
  expect(loop?.[1]?.split(/\s+/).sort()).toEqual([...mod.files].sort())
})
