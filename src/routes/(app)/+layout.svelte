<script lang="ts">
  import '../layout.css'
  import { page } from '$app/state'
  import { Button } from '#lib/components/ui/button/index.js'
  import ChartTip from '#lib/dashboard/ui/ChartTip.svelte'
  import type { LayoutProps } from './$types'

  let { children, data }: LayoutProps = $props()

  // an admin looking at someone else's dashboard keeps ?person= between its pages
  const person = $derived(page.url.searchParams.get('person'))
  const withPerson = (path: string) => (person ? `${path}?person=${encodeURIComponent(person)}` : path)
  const links = $derived([
    { href: withPerson('/'), route: '/(app)', label: 'Overview' },
    { href: withPerson('/timeline'), route: '/(app)/timeline', label: 'Timeline' },
    { href: '/settings', route: '/(app)/settings', label: 'Settings' },
    ...(data.admin ? [{ href: '/admin', route: '/(app)/admin', label: 'Admin' }] : []),
  ])
  // the dashboard pages get the room their charts want
  const wide = $derived(page.route.id === '/(app)' || page.route.id === '/(app)/timeline')
</script>

<header class="border-b">
  <!-- always the widest page's width, so the links never move between pages -->
  <nav class="mx-auto flex max-w-6xl flex-wrap items-center gap-x-1 gap-y-2 px-4 py-3">
    <a href={withPerson('/')} class="mr-auto basis-full font-semibold whitespace-nowrap sm:basis-auto">claude-hours</a>
    {#if data.person}
      {#each links as link (link.route)}
        <Button
          href={link.href}
          variant={page.route.id === link.route ? 'secondary' : 'ghost'}
          size="sm"
          aria-current={page.route.id === link.route ? 'page' : undefined}>{link.label}</Button
        >
      {/each}
      <form method="post" action="/auth/logout">
        <Button type="submit" variant="ghost" size="sm">Log out</Button>
      </form>
    {/if}
  </nav>
</header>

<main class={['mx-auto px-4 py-8', wide ? 'max-w-6xl' : 'max-w-4xl']}>
  {@render children()}
</main>
<ChartTip />
