// the dashboard is drawn in the browser, from /api/summary, which a hovered
// link starts fetching ahead
import type { Counting } from '#lib/analytics/aggregate.js'
import { prefetchDigest } from '#lib/dashboard/live.svelte.js'
import { load as setting } from '#lib/dashboard/shared.js'
import type { PageLoad } from './$types'

export const ssr = false

export const load: PageLoad = ({ url, fetch }) => {
  prefetchDigest({ url, fetch }, true, setting<Counting>('counting', 'all'))
}
