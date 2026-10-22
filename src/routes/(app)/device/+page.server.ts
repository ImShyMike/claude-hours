import { fail } from '@sveltejs/kit'
import { db } from '#lib/server/db/client.js'
import { decideDeviceCode, findPendingCode, normalizeUserCode } from '#lib/server/devices.js'
import { requirePerson } from '#lib/server/guard.js'
import { rateLimiter } from '#lib/server/ratelimit.js'
import type { Actions, PageServerLoad, RequestEvent } from './$types'

// codes are too many to guess (20^8), but there's no reason to let anyone try
const allow = rateLimiter(20, 10 * 60_000)

export const load: PageServerLoad = async ({ locals, url }) => {
  const person = requirePerson(locals, url)
  const typed = url.searchParams.get('code')
  if (!typed) return { typed: '', request: null, problem: null }
  if (!allow(`device:${person.id}`)) return { typed, request: null, problem: 'Too many tries, wait a few minutes and try again' }
  const code = normalizeUserCode(typed)
  const request = code && (await findPendingCode(db, code))
  if (!request)
    return {
      typed,
      request: null,
      problem: "That code doesn't match a device waiting to connect. It may have expired, try logging in from the mod again",
    }
  return { typed, request, problem: null }
}

const decide =
  (approve: boolean) =>
  async ({ locals, url, request }: RequestEvent) => {
    const person = requirePerson(locals, url)
    if (!allow(`device:${person.id}`)) return fail(429, { problem: 'Too many tries, wait a few minutes and try again' })
    const code = normalizeUserCode(String((await request.formData()).get('code') ?? ''))
    if (!code || !(await decideDeviceCode(db, code, person.id, approve))) return fail(400, { problem: 'That code expired or was already used' })
    return { decided: approve ? 'approved' : 'denied' }
  }

export const actions: Actions = { approve: decide(true), deny: decide(false) }
