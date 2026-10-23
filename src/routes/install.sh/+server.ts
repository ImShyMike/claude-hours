import { script } from 'virtual:installer'
import type { RequestHandler } from './$types'

// The installer for curl -fsSL <hub>/install.sh | sh, with this hub filled
// in so it fetches the mod from here (the repo's private) and the end of it
// says where to log in
export const GET: RequestHandler = ({ url }) =>
  new Response(script.replace(/^hub=''/m, `hub='${url.origin}'`), {
    headers: { 'content-type': 'text/x-shellscript; charset=utf-8', 'cache-control': 'no-cache' },
  })
