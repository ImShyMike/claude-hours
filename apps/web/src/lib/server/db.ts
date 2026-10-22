import { createDb } from '@claude-hours/db'
import { DATABASE_URL } from '$app/env/private'

// postgres.js connects lazily, on the first query
export const db = createDb(DATABASE_URL)
