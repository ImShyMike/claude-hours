import { requirePerson } from '#lib/server/guard.js'
import type { LayoutServerLoad } from './$types'

export const load: LayoutServerLoad = ({ locals, url }) => {
  requirePerson(locals, url)
}
