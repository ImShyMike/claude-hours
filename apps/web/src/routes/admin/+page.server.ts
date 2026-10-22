import { fail } from '@sveltejs/kit'
import { count, desc, eq, getTableColumns } from 'drizzle-orm'
import { deviceTokens, people } from '@claude-hours/db'
import { db } from '#lib/server/db.js'
import { decideDeletion, pendingDeletions } from '#lib/server/deletion.js'
import { requireAdmin } from '#lib/server/guard.js'
import type { Actions, PageServerLoad, RequestEvent } from './$types'

export const load: PageServerLoad = async ({ locals, url }) => {
  requireAdmin(locals, url)
  const [everyone, deletions] = await Promise.all([
    db
      .select({ ...getTableColumns(people), devices: count(deviceTokens.id) })
      .from(people)
      .leftJoin(deviceTokens, eq(deviceTokens.personId, people.id))
      .groupBy(people.id)
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
