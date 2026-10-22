import { requirePerson } from '#lib/server/guard.js'
import type { LayoutServerLoad } from './$types'

// the overview says hello to someone logged out; the rest send them to log in
export const load: LayoutServerLoad = ({ locals, url }) => {
  if (url.pathname !== '/') requirePerson(locals, url)
}
