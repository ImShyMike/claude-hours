import { createDb } from './index'
import { DATABASE_URL } from '$app/env/private'

// postgres.js connects lazily, on the first query
export const db = createDb(DATABASE_URL)
