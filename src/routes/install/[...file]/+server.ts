import { error } from '@sveltejs/kit'
import { files } from 'virtual:installer'
import type { RequestHandler } from './$types'

// What install.sh downloads: the mod as it was when this hub was built, and
// the helper that adds it to settings.json. Named one by one in
// vite.config.ts, so tests and generated types never go out
export const GET: RequestHandler = ({ params }) => {
  const text = files[params.file]
  if (text === undefined) error(404, 'Not a file the installer needs')
  return new Response(text, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache' } })
}
