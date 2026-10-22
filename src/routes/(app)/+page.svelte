<script lang="ts">
  import { Button } from '#lib/components/ui/button/index.js'
  import * as Card from '#lib/components/ui/card/index.js'
  import Overview from '#lib/dashboard/ui/Overview.svelte'
  import type { PageProps } from './$types'

  let { data }: PageProps = $props()
</script>

<svelte:head><title>claude-hours</title></svelte:head>

{#if !data.person}
  <Card.Root class="mx-auto mt-16 max-w-md">
    <Card.Header>
      <Card.Title class="text-xl">claude-hours</Card.Title>
      <Card.Description>How long you spend with Claude Code, and where the time goes.</Card.Description>
    </Card.Header>
    <Card.Footer>
      <Button href="/auth/login">Log in with Hack Club</Button>
    </Card.Footer>
  </Card.Root>
{:else}
  <Overview />
{/if}
