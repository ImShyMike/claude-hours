// the dashboard is drawn in the browser, from /api/summary, which a hovered
// link starts fetching ahead
import { prefetchDigest } from '#lib/dashboard/live.svelte.js'
import type { PageLoad } from './$types'

export const ssr = false

export const load: PageLoad = ({ url }) => {
  prefetchDigest(url, true)
}
