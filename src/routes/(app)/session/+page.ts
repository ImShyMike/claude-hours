// the page is drawn in the browser, from /api/session/:id, which a hovered
// link starts fetching ahead
import { prefetchSession } from '#lib/dashboard/live.svelte.js'
import type { PageLoad } from './$types'

export const ssr = false

export const load: PageLoad = ({ url }) => {
  prefetchSession(url)
}
