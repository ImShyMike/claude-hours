import { requirePerson } from '#lib/server/guard.js'
import type { PageServerLoad } from './$types'

export const load: PageServerLoad = ({ locals, url }) => {
  requirePerson(locals, url)
}
