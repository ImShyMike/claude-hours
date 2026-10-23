import { fail } from '@sveltejs/kit'
import { db } from '#lib/server/db/client.js'
import { latestDeletion, requestDeletion, withdrawDeletion } from '#lib/server/deletion.js'
import { listDevices, loginCode, revokeDevice } from '#lib/server/devices.js'
import { requirePerson } from '#lib/server/guard.js'
import type { Actions, PageServerLoad } from './$types'

export const load: PageServerLoad = async ({ locals, url }) => {
  const person = requirePerson(locals, url)
  const [devices, deletion] = await Promise.all([listDevices(db, person.id), latestDeletion(db, person.id)])
  return { devices, deletion, hub: url.origin }
}

export const actions: Actions = {
  // a login command for Claude Code, approved already: it works once, for
  // as long as a device code does
  connect: async ({ locals, url }) => {
    const { deviceCode } = await loginCode(db, requirePerson(locals, url).id)
    return { login: `/hook-analytics login ${url.origin} ${deviceCode}` }
  },
  revoke: async ({ locals, url, request }) => {
    const person = requirePerson(locals, url)
    const id = Number((await request.formData()).get('id'))
    if (!Number.isSafeInteger(id) || !(await revokeDevice(db, person.id, id))) return fail(404, { problem: 'That device is already gone' })
  },
  requestDeletion: async ({ locals, url, request }) => {
    const person = requirePerson(locals, url)
    const reason = String((await request.formData()).get('reason') ?? '')
      .trim()
      .slice(0, 1000)
    if (!(await requestDeletion(db, person.id, reason || null))) return fail(409, { problem: 'You already have a request waiting' })
  },
  withdrawDeletion: async ({ locals, url }) => {
    await withdrawDeletion(db, requirePerson(locals, url).id)
  },
}
