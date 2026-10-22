<script lang="ts">
  import './layout.css'
  import favicon from '#lib/assets/favicon.svg'
  import { Button } from '#lib/components/ui/button/index.js'
  import type { LayoutProps } from './$types'

  let { children, data }: LayoutProps = $props()
</script>

<svelte:head>
  <link rel="icon" href={favicon} />
  <title>Claude Hours</title>
</svelte:head>

<header class="border-b">
  <nav class="mx-auto flex max-w-4xl items-center gap-1 px-4 py-3">
    <a href="/" class="mr-auto font-semibold">Claude Hours</a>
    {#if data.person}
      <Button href="/settings" variant="ghost" size="sm">Settings</Button>
      {#if data.admin}
        <Button href="/admin" variant="ghost" size="sm">Admin</Button>
      {/if}
      <form method="post" action="/auth/logout">
        <Button type="submit" variant="ghost" size="sm">Log out</Button>
      </form>
    {/if}
  </nav>
</header>

<main class="mx-auto max-w-4xl px-4 py-8">
  {@render children()}
</main>
