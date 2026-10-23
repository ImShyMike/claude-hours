import { error } from '@sveltejs/kit'
import plugin from '../../../../mod/.claude-plugin/plugin.json?raw'
import hooks from '../../../../mod/hooks/hooks.json?raw'
import register from '../../../../mod/hooks/register.ts?raw'
import types from '../../../../mod/types/index.d.ts?raw'
import tsconfig from '../../../../mod/tsconfig.json?raw'
import settings from '../../../../scripts/settings.py?raw'
import type { RequestHandler } from './$types'

// What install.sh downloads: the mod as it was when this hub was built, and
// the helper that adds it to settings.json. Named one by one, so tests and
// generated types never go out
const FILES: Record<string, string> = {
  'mod/.claude-plugin/plugin.json': plugin,
  'mod/hooks/hooks.json': hooks,
  'mod/hooks/register.ts': register,
  'mod/types/index.d.ts': types,
  'mod/tsconfig.json': tsconfig,
  'settings.py': settings,
}

export const GET: RequestHandler = ({ params }) => {
  const text = FILES[params.file]
  if (text === undefined) error(404, 'Not a file the installer needs')
  return new Response(text, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache' } })
}
