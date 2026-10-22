import type { LayoutServerLoad } from './$types'

export const load: LayoutServerLoad = ({ locals }) => ({
  person: locals.person && { name: locals.person.name, email: locals.person.email },
  admin: locals.admin,
})
