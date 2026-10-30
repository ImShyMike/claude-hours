import { fail } from '@sveltejs/kit'
import { db } from '#lib/server/db/client.js'
import { latestDeletion, requestDeletion, withdrawDeletion } from '#lib/server/deletion.js'
import { listDevices, loginCode, revokeDevice } from '#lib/server/devices.js'
import { requirePerson } from '#lib/server/guard.js'
import { IDLE_CAPS, idleCapMs, setIdleCap } from '#lib/server/settings.js'
import type { Actions, PageServerLoad } from './$types'

export const load: PageServerLoad = async ({ locals, url }) => {
  const person = requirePerson(locals, url)
  const [devices, deletion, cap] = await Promise.all([listDevices(db, person.id), latestDeletion(db, person.id), idleCapMs(db, person.id)])
  return { devices, deletion, hub: url.origin, idleCapMin: cap / 60_000, idleCaps: IDLE_CAPS }
}

export const actions: Actions = {
  // a login command for Claude Code, approved already: it works once, for
  // as long as a device code does
  connect: async ({ locals, url }) => {
    const { deviceCode } = await loginCode(db, requirePerson(locals, url).id)
    return { login: `/time-track login ${url.origin} ${deviceCode}` }
  },
  // how long a quiet stretch still counts as active in their time
  idleCap: async ({ locals, url, request }) => {
    const person = requirePerson(locals, url)
    if (!(await setIdleCap(db, person.id, Number((await request.formData()).get('minutes')))))
      return fail(400, { problem: `The idle timeout is one of ${IDLE_CAPS.join(', ')} minutes` })
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
