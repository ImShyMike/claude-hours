// A fresh database per test: PGlite (Postgres in WASM, in memory) with the
// real migrations applied, so tests need no server
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { fileURLToPath } from 'node:url'
import type { Db } from './index'
import * as schema from './schema'

const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url))

export async function testDb(): Promise<Db> {
  const db = drizzle(new PGlite(), { schema })
  await migrate(db, { migrationsFolder })
  return db
}
