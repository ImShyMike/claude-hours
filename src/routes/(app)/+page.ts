// the dashboard is drawn in the browser, from /api/summary, which a hovered
// link starts fetching ahead (once someone's logged in to ask for it)
import { prefetchDigest } from '#lib/dashboard/live.svelte.js'
import type { PageLoad } from './$types'

export const ssr = false

export const load: PageLoad = async ({ parent, url, fetch }) => {
  if ((await parent()).person) prefetchDigest({ url, fetch })
}
