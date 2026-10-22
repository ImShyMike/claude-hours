<script lang="ts">
  import { enhance } from '$app/forms'
  import * as Alert from '#lib/components/ui/alert/index.js'
  import { Button } from '#lib/components/ui/button/index.js'
  import * as Card from '#lib/components/ui/card/index.js'
  import * as Table from '#lib/components/ui/table/index.js'
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
      <Card.Title>Idle cap</Card.Title>
      <Card.Description>A quiet stretch up to this long still counts as active, for everyone's time.</Card.Description>
    </Card.Header>
    <Card.Content>
      <form method="post" action="?/idleCap" class="flex flex-wrap gap-2" use:enhance>
        {#each data.idleCaps as minutes (minutes)}
          <Button
            type="submit"
            name="minutes"
            value={minutes}
            size="sm"
            variant={minutes === data.idleCapMin ? 'default' : 'outline'}
            aria-pressed={minutes === data.idleCapMin}>{minutes} min</Button
          >
        {/each}
      </form>
    </Card.Content>
  </Card.Root>

  <Card.Root>
    <Card.Header>
      <Card.Title>Deletion requests</Card.Title>
      <Card.Description>Approving records the decision. Nothing is deleted yet, there's no event data to delete.</Card.Description>
    </Card.Header>
    <Card.Content>
      {#if data.deletions.length}
        <Table.Root>
          <Table.Header>
            <Table.Row>
              <Table.Head>Person</Table.Head>
              <Table.Head>Requested</Table.Head>
              <Table.Head>Reason</Table.Head>
              <Table.Head></Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {#each data.deletions as { request, person } (request.id)}
              <Table.Row>
                <Table.Cell class="font-medium">{person.name ?? person.email ?? person.sub}</Table.Cell>
                <Table.Cell>{day(request.requestedAt)}</Table.Cell>
                <Table.Cell class="max-w-xs truncate whitespace-normal">{request.reason ?? ''}</Table.Cell>
                <Table.Cell>
                  <div class="flex justify-end gap-2">
                    <form method="post" action="?/approve" use:enhance>
                      <input type="hidden" name="id" value={request.id} />
                      <Button type="submit" variant="destructive" size="sm">Approve</Button>
                    </form>
                    <form method="post" action="?/reject" use:enhance>
                      <input type="hidden" name="id" value={request.id} />
                      <Button type="submit" variant="outline" size="sm">Reject</Button>
                    </form>
                  </div>
                </Table.Cell>
              </Table.Row>
            {/each}
          </Table.Body>
        </Table.Root>
      {:else}
        <p class="text-sm text-muted-foreground">Nothing waiting.</p>
      {/if}
    </Card.Content>
  </Card.Root>

  <Card.Root>
    <Card.Header>
      <Card.Title>People</Card.Title>
      <Card.Description>{data.people.length} signed up</Card.Description>
    </Card.Header>
    <Card.Content>
      <Table.Root>
        <Table.Header>
          <Table.Row>
            <Table.Head>Name</Table.Head>
            <Table.Head>Email</Table.Head>
            <Table.Head>Devices</Table.Head>
            <Table.Head>Joined</Table.Head>
            <Table.Head>Last login</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {#each data.people as person (person.id)}
            <Table.Row>
              <Table.Cell class="font-medium">{person.name ?? ''}</Table.Cell>
              <Table.Cell>{person.email ?? ''}</Table.Cell>
              <Table.Cell>{person.devices}</Table.Cell>
              <Table.Cell>{day(person.createdAt)}</Table.Cell>
              <Table.Cell>{day(person.lastLoginAt)}</Table.Cell>
            </Table.Row>
          {/each}
        </Table.Body>
      </Table.Root>
    </Card.Content>
  </Card.Root>
</div>
