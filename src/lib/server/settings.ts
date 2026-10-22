// Hub-wide settings, changed by an admin on /admin. For now that's the idle
// cap: how long a quiet stretch still counts as active, the same for
// everyone so their hours add up the same way
import { eq } from 'drizzle-orm'
import { settings, type Db } from './db/index'

const MIN = 60_000
// the caps an admin can pick from, in minutes
export const IDLE_CAPS = [2, 5, 10, 15]
const DEFAULT_IDLE_MIN = 5

// read once per database and kept, since every dashboard request needs it;
// setting it here updates the copy (one server process, like the rate limits)
const idleMin = new WeakMap<Db, number>()

export async function idleCapMs(db: Db) {
  let minutes = idleMin.get(db)
  if (minutes === undefined) {
    const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, 'idle_cap_min'))
    minutes = typeof row?.value === 'number' && IDLE_CAPS.includes(row.value) ? row.value : DEFAULT_IDLE_MIN
    idleMin.set(db, minutes)
  }
  return minutes * MIN
}

// false for a cap that isn't on the list
export async function setIdleCap(db: Db, minutes: number) {
  if (!IDLE_CAPS.includes(minutes)) return false
  await db
    .insert(settings)
    .values({ key: 'idle_cap_min', value: minutes })
    .onConflictDoUpdate({ target: settings.key, set: { value: minutes, updatedAt: new Date() } })
  idleMin.set(db, minutes)
  return true
}
