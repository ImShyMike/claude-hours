// Data deletion requests: a person asks, an admin approves or rejects.
// Approving only records the decision for now; nothing gets deleted until
// there's event data to delete
import { and, desc, eq } from 'drizzle-orm'
import { deletionRequests, people, type Db } from '@claude-hours/db'

// null when one is already pending
export async function requestDeletion(db: Db, personId: number, reason: string | null) {
  const [row] = await db.insert(deletionRequests).values({ personId, reason }).onConflictDoNothing().returning()
  return row ?? null
}

export async function withdrawDeletion(db: Db, personId: number) {
  await db.delete(deletionRequests).where(and(eq(deletionRequests.personId, personId), eq(deletionRequests.status, 'pending')))
}

export async function latestDeletion(db: Db, personId: number) {
  const [row] = await db
    .select()
    .from(deletionRequests)
    .where(eq(deletionRequests.personId, personId))
    .orderBy(desc(deletionRequests.requestedAt), desc(deletionRequests.id))
    .limit(1)
  return row ?? null
}

export function pendingDeletions(db: Db) {
  return db
    .select({ request: deletionRequests, person: people })
    .from(deletionRequests)
    .innerJoin(people, eq(people.id, deletionRequests.personId))
    .where(eq(deletionRequests.status, 'pending'))
    .orderBy(deletionRequests.requestedAt)
}

// false when the request isn't pending anymore (another admin got there first)
export async function decideDeletion(db: Db, id: number, adminId: number, approve: boolean, now = new Date()) {
  const rows = await db
    .update(deletionRequests)
    .set({ status: approve ? 'approved' : 'rejected', decidedAt: now, decidedBy: adminId })
    .where(and(eq(deletionRequests.id, id), eq(deletionRequests.status, 'pending')))
    .returning({ id: deletionRequests.id })
  return rows.length > 0
}
