import { drizzle } from 'drizzle-orm/postgres-js'
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import postgres from 'postgres'
import * as schema from './schema'

export * from './schema'
export { schema }

// The hub's database, whichever driver is under it: postgres.js in the app,
// PGlite in tests (./testing)
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>

export function createDb(url: string): Db {
  return drizzle(postgres(url), { schema })
}

// how every secret is kept: its sha256, hex
export async function sha256(text: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')
}
