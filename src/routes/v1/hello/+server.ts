import { json } from '@sveltejs/kit'
import { MAX_BYTES, MAX_ROWS, PROTOCOLS } from '#lib/server/ingest.js'
import type { RequestHandler } from './$types'

// what this hub speaks, so a client can check before it sends
export const GET: RequestHandler = () => json({ protocols: PROTOCOLS, maxBatchBytes: MAX_BYTES, maxRows: MAX_ROWS })
