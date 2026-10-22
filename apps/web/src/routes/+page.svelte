<script lang="ts">
  import { Button } from '#lib/components/ui/button/index.js'
  import * as Card from '#lib/components/ui/card/index.js'
  import type { PageProps } from './$types'

  let { data }: PageProps = $props()
</script>

{#if data.person}
  <h1 class="text-2xl font-semibold">Hi {data.person.name ?? data.person.email ?? 'there'}!</h1>
  <p class="mt-2 text-muted-foreground">
    Your dashboard lands here once the mod can sync. For now, connect a device by logging in from the mod in Claude Code, and manage them in <a
      href="/settings"
      class="underline">settings</a
    >.
  </p>
{:else}
  <Card.Root class="mx-auto mt-16 max-w-md">
    <Card.Header>
      <Card.Title>Claude Hours</Card.Title>
      <Card.Description>See how you spend your time in Claude Code. Log in with your Hack Club account to get started.</Card.Description>
    </Card.Header>
    <Card.Footer>
      <Button href="/auth/login" data-sveltekit-reload class="w-full">Log in with Hack Club</Button>
    </Card.Footer>
  </Card.Root>
{/if}
