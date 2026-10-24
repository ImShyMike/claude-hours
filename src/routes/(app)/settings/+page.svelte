<script lang="ts">
  import { enhance } from '$app/forms'
  import * as Alert from '#lib/components/ui/alert/index.js'
  import TerminalIcon from '@lucide/svelte/icons/terminal'
  import { Badge } from '#lib/components/ui/badge/index.js'
  import { Button } from '#lib/components/ui/button/index.js'
  import * as Card from '#lib/components/ui/card/index.js'
  import { Input } from '#lib/components/ui/input/index.js'
  import { Label } from '#lib/components/ui/label/index.js'
  import * as Table from '#lib/components/ui/table/index.js'
  import CopyCommand from '#lib/dashboard/ui/CopyCommand.svelte'
  import { day } from '#lib/format.js'
  import type { PageProps } from './$types'

  let { data, form }: PageProps = $props()
</script>

<div class="flex flex-col gap-6">
  {#if form?.problem}
    <Alert.Root variant="destructive">
      <Alert.Description>{form.problem}</Alert.Description>
    </Alert.Root>
  {/if}

  <Card.Root>
    <Card.Header>
      <Card.Title>Connect Claude Code</Card.Title>
      <Card.Description>Two commands to start sending your sessions here from another computer.</Card.Description>
    </Card.Header>
    <Card.Content class="flex flex-col gap-5">
      <div class="flex flex-col gap-2">
        <p class="text-sm">1. Install the mod, in a terminal (macOS or Linux):</p>
        <CopyCommand command={`curl -fsSL ${data.hub}/install.sh | sh`} />
      </div>
      <div class="flex flex-col gap-2">
        <p class="text-sm">2. Start a new Claude Code session and paste in a login command:</p>
        {#if form?.login}
          <CopyCommand command={form.login} />
          <p class="text-xs text-muted-foreground">Works once, for the next 10 minutes.</p>
        {:else}
          <form method="post" action="?/connect" use:enhance>
            <Button type="submit" variant="outline" size="sm"><TerminalIcon /> Make a login command</Button>
          </form>
        {/if}
      </div>
    </Card.Content>
  </Card.Root>

  <Card.Root>
    <Card.Header>
      <Card.Title>Devices</Card.Title>
      <Card.Description>Computers syncing to your account. Revoking one stops it from sending anything new.</Card.Description>
    </Card.Header>
    <Card.Content>
      {#if data.devices.length}
        <Table.Root>
          <Table.Header>
            <Table.Row>
              <Table.Head>Name</Table.Head>
              <Table.Head>Connected</Table.Head>
              <Table.Head>Last seen</Table.Head>
              <Table.Head></Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {#each data.devices as device (device.id)}
              <Table.Row>
                <Table.Cell class="font-medium">{device.name}</Table.Cell>
                <Table.Cell>{day(device.createdAt)}</Table.Cell>
                <Table.Cell>{day(device.lastSeenAt)}</Table.Cell>
                <Table.Cell class="text-right">
                  <form method="post" action="?/revoke" use:enhance>
                    <input type="hidden" name="id" value={device.id} />
                    <Button type="submit" variant="outline" size="sm">Revoke</Button>
                  </form>
                </Table.Cell>
              </Table.Row>
            {/each}
          </Table.Body>
        </Table.Root>
      {:else}
        <p class="text-sm text-muted-foreground">No devices yet. Connect one with the commands above.</p>
      {/if}
    </Card.Content>
  </Card.Root>

  <Card.Root>
    <Card.Header>
      <Card.Title>Delete my data</Card.Title>
      <Card.Description>Ask for your account and everything you've sent here to be deleted. An admin looks at each request.</Card.Description>
    </Card.Header>
    <Card.Content>
      {#if data.deletion?.status === 'pending'}
        <div class="flex items-center gap-3">
          <Badge variant="secondary">Pending</Badge>
          <span class="text-sm">Requested {day(data.deletion.requestedAt)}</span>
          <form method="post" action="?/withdrawDeletion" use:enhance class="ml-auto">
            <Button type="submit" variant="outline" size="sm">Withdraw</Button>
          </form>
        </div>
      {:else}
        {#if data.deletion}
          <p class="mb-4 text-sm text-muted-foreground">
            Your last request was {data.deletion.status} on {day(data.deletion.decidedAt)}.
          </p>
        {/if}
        <form method="post" action="?/requestDeletion" use:enhance class="flex flex-col gap-2">
          <Label for="reason">Anything we should know? (optional)</Label>
          <Input id="reason" name="reason" maxlength={1000} />
          <Button type="submit" variant="destructive" class="self-start">Request deletion</Button>
        </form>
      {/if}
    </Card.Content>
  </Card.Root>
</div>
