import { fail } from '@sveltejs/kit'
import { and, count, countDistinct, desc, eq, getTableColumns, isNull, max } from 'drizzle-orm'
import { deviceTokens, people, runs } from '#lib/server/db/index.js'
import { db } from '#lib/server/db/client.js'
import { decideDeletion, pendingDeletions } from '#lib/server/deletion.js'
import { requireAdmin } from '#lib/server/guard.js'
import type { Actions, PageServerLoad, RequestEvent } from './$types'

export const load: PageServerLoad = async ({ locals, url }) => {
  requireAdmin(locals, url)
  // what each person has sent, summed apart so it doesn't multiply by their devices
  const sent = db
    .select({
      personId: runs.personId,
      sessions: countDistinct(runs.session).as('sessions'),
      lastSync: max(runs.updatedAt).as('last_sync'),
    })
    .from(runs)
    .groupBy(runs.personId)
    .as('sent')
  const [everyone, deletions] = await Promise.all([
    db
      .select({ ...getTableColumns(people), devices: count(deviceTokens.id), sessions: sent.sessions, lastSync: sent.lastSync })
      .from(people)
      .leftJoin(deviceTokens, and(eq(deviceTokens.personId, people.id), isNull(deviceTokens.revokedAt)))
      .leftJoin(sent, eq(sent.personId, people.id))
      .groupBy(people.id, sent.sessions, sent.lastSync)
      .orderBy(desc(people.createdAt)),
    pendingDeletions(db),
  ])
  return { people: everyone, deletions }
}

const decide =
  (approve: boolean) =>
  async ({ locals, url, request }: RequestEvent) => {
    const admin = requireAdmin(locals, url)
    const id = Number((await request.formData()).get('id'))
    if (!Number.isSafeInteger(id) || !(await decideDeletion(db, id, admin.id, approve)))
      return fail(409, { problem: 'That request was already decided' })
  }

export const actions: Actions = { approve: decide(true), reject: decide(false) }
