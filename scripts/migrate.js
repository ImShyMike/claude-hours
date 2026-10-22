// Brings DATABASE_URL up to the newest migration in drizzle/, before the hub
// starts (the Dockerfile runs it). Plain JS on drizzle-orm alone, so the
// image needs neither drizzle-kit nor bun
//
//   DATABASE_URL=postgres://... node scripts/migrate.js
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

const client = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} })
await migrate(drizzle(client), { migrationsFolder: new URL('../drizzle', import.meta.url).pathname })
await client.end()
console.log('migrations applied')
