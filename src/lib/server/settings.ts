// What each person picks for themselves on /settings. For now that's the
// idle cap: how long a quiet stretch still counts as active in their time
import { eq } from 'drizzle-orm'
import { people, type Db } from './db/index'

const MIN = 60_000
// the caps someone can pick from, in minutes
export const IDLE_CAPS = [1, 2, 5, 10, 15]
export const DEFAULT_IDLE_MIN = 2

// read once per person and kept, since every dashboard request needs it;
// setting it here updates the copy (one server process, like the rate limits)
const idleMin = new WeakMap<Db, Map<number, number>>()

const kept = (db: Db) => {
  let byPerson = idleMin.get(db)
  if (!byPerson) idleMin.set(db, (byPerson = new Map()))
  return byPerson
}

export async function idleCapMs(db: Db, personId: number) {
  let minutes = kept(db).get(personId)
  if (minutes === undefined) {
    const [row] = await db.select({ value: people.idleCapMin }).from(people).where(eq(people.id, personId))
    minutes = row?.value && IDLE_CAPS.includes(row.value) ? row.value : DEFAULT_IDLE_MIN
    kept(db).set(personId, minutes)
  }
  return minutes * MIN
}

// false for a cap that isn't on the list
export async function setIdleCap(db: Db, personId: number, minutes: number) {
  if (!IDLE_CAPS.includes(minutes)) return false
  await db.update(people).set({ idleCapMin: minutes }).where(eq(people.id, personId))
  kept(db).set(personId, minutes)
  return true
}
