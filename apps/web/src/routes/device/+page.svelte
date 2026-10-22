<script lang="ts">
  import { enhance } from '$app/forms'
  import * as Alert from '#lib/components/ui/alert/index.js'
  import { Button } from '#lib/components/ui/button/index.js'
  import * as Card from '#lib/components/ui/card/index.js'
  import { Input } from '#lib/components/ui/input/index.js'
  import { Label } from '#lib/components/ui/label/index.js'
  import type { PageProps } from './$types'

  let { data, form }: PageProps = $props()
</script>

<Card.Root class="mx-auto max-w-md">
  <Card.Header>
    <Card.Title>Connect a device</Card.Title>
    <Card.Description>Type the code the mod showed you in Claude Code.</Card.Description>
  </Card.Header>
  <Card.Content class="flex flex-col gap-4">
    {#if form?.decided === 'approved'}
      <Alert.Root>
        <Alert.Title>Connected!</Alert.Title>
        <Alert.Description>You can head back to Claude Code, it picks this up in a few seconds.</Alert.Description>
      </Alert.Root>
    {:else if form?.decided === 'denied'}
      <Alert.Root>
        <Alert.Title>Denied</Alert.Title>
        <Alert.Description>That device won't be connected.</Alert.Description>
      </Alert.Root>
    {:else if data.request}
      <p>
        <span class="font-medium">{data.request.deviceName}</span> wants to sync its Claude Code activity to your account. Only approve it if you just ran
        the login there.
      </p>
      <p class="text-center font-mono text-2xl tracking-widest">{data.request.userCode}</p>
      <div class="flex gap-2">
        <form method="post" action="?/approve" use:enhance class="flex-1">
          <input type="hidden" name="code" value={data.request.userCode} />
          <Button type="submit" class="w-full">Approve</Button>
        </form>
        <form method="post" action="?/deny" use:enhance class="flex-1">
          <input type="hidden" name="code" value={data.request.userCode} />
          <Button type="submit" variant="outline" class="w-full">Deny</Button>
        </form>
      </div>
    {:else}
      {#if data.problem || form?.problem}
        <Alert.Root variant="destructive">
          <Alert.Description>{form?.problem ?? data.problem}</Alert.Description>
        </Alert.Root>
      {/if}
      <form method="get" class="flex flex-col gap-2">
        <Label for="code">Code</Label>
        <Input id="code" name="code" value={data.typed} placeholder="WDJB-MJHT" autocomplete="off" autocapitalize="characters" class="font-mono" />
        <Button type="submit">Continue</Button>
      </form>
    {/if}
  </Card.Content>
</Card.Root>
