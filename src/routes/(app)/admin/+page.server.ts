import { fail } from '@sveltejs/kit'
import { count, desc, eq, getTableColumns } from 'drizzle-orm'
import { deviceTokens, people } from '#lib/server/db/index.js'
import { db } from '#lib/server/db/client.js'
import { decideDeletion, pendingDeletions } from '#lib/server/deletion.js'
import { requireAdmin } from '#lib/server/guard.js'
import { IDLE_CAPS, idleCapMs, setIdleCap } from '#lib/server/settings.js'
import type { Actions, PageServerLoad, RequestEvent } from './$types'

export const load: PageServerLoad = async ({ locals, url }) => {
  requireAdmin(locals, url)
  const [everyone, deletions, cap] = await Promise.all([
    db
      .select({ ...getTableColumns(people), devices: count(deviceTokens.id) })
      .from(people)
      .leftJoin(deviceTokens, eq(deviceTokens.personId, people.id))
      .groupBy(people.id)
      .orderBy(desc(people.createdAt)),
    pendingDeletions(db),
    idleCapMs(db),
  ])
  return { people: everyone, deletions, idleCapMin: cap / 60_000, idleCaps: IDLE_CAPS }
}

const decide =
  (approve: boolean) =>
  async ({ locals, url, request }: RequestEvent) => {
    const admin = requireAdmin(locals, url)
    const id = Number((await request.formData()).get('id'))
    if (!Number.isSafeInteger(id) || !(await decideDeletion(db, id, admin.id, approve)))
      return fail(409, { problem: 'That request was already decided' })
  }

// the idle cap everyone's time is counted with
async function idleCap({ locals, url, request }: RequestEvent) {
  requireAdmin(locals, url)
  if (!(await setIdleCap(db, Number((await request.formData()).get('minutes')))))
    return fail(400, { problem: `The idle cap is one of ${IDLE_CAPS.join(', ')} minutes` })
}

export const actions: Actions = { approve: decide(true), reject: decide(false), idleCap }
