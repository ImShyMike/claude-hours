import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { defineConfig, type Plugin } from 'vitest/config'
import tailwindcss from '@tailwindcss/vite'
import adapter from '@sveltejs/adapter-node'
import { sveltekit } from '@sveltejs/kit/vite'

// What the hub's installer routes hand out, read as plain text when the hub
// is built: the mod (as install.sh puts it), settings.py and install.sh. Not
// ?raw imports, which still send a .ts file through the TypeScript transform,
// and that wants the mod's tsconfig, whose base is generated and gitignored
const INSTALLER: Record<string, string> = {
  'mod/.claude-plugin/plugin.json': 'mod/.claude-plugin/plugin.json',
  'mod/hooks/hooks.json': 'mod/hooks/hooks.json',
  'mod/hooks/register.ts': 'mod/hooks/register.ts',
  'mod/types/index.d.ts': 'mod/types/index.d.ts',
  'mod/tsconfig.json': 'mod/tsconfig.json',
  'settings.py': 'scripts/settings.py',
}
const installer = (): Plugin => ({
  name: 'installer-files',
  resolveId: id => (id === 'virtual:installer' ? '\0virtual:installer' : undefined),
  load(id) {
    if (id !== '\0virtual:installer') return
    const read = (path: string) => {
      this.addWatchFile(path)
      return readFileSync(path, 'utf8')
    }
    const files = Object.fromEntries(Object.entries(INSTALLER).map(([served, path]) => [served, read(path)]))
    // the mod's version is a hash of its files, so every change is a new one
    // with nobody bumping anything; release.json carries it to the computer
    const served = Object.keys(files).filter(f => f.startsWith('mod/'))
    const version = createHash('sha256')
      .update(JSON.stringify(served.map(f => [f, files[f]])))
      .digest('hex')
      .slice(0, 12)
    files['mod/.claude-plugin/release.json'] = `${JSON.stringify({ version })}\n`
    const mod = { version, files: [...served, 'mod/.claude-plugin/release.json'].map(f => f.slice('mod/'.length)) }
    return [
      `export const files = ${JSON.stringify(files)}`,
      `export const script = ${JSON.stringify(read('install.sh'))}`,
      `export const mod = ${JSON.stringify(mod)}`,
      '',
    ].join('\n')
  },
})

export default defineConfig({
  plugins: [
    installer(),
    tailwindcss(),
    sveltekit({
      compilerOptions: {
        // Force runes mode for the project, except for libraries. Can be removed in svelte 6.
        runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true),
      },
      adapter: adapter(),
    }),
  ],
  test: {
    expect: { requireAssertions: true },
    projects: [
      {
        extends: './vite.config.ts',
        test: {
          name: 'server',
          environment: 'node',
          include: ['src/**/*.{test,spec}.{js,ts}'],
          exclude: ['src/**/*.svelte.{test,spec}.{js,ts}'],
        },
      },
    ],
  },
})
