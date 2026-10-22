<script lang="ts">
  import { goto } from '$app/navigation'
  import * as Select from '#lib/components/ui/select/index.js'
  import type { Me } from '../shared'

  // an admin picks whose dashboard this is; going back to their own drops ?person
  let { me }: { me: Me } = $props()
  const people = $derived(me.admin && me.people?.length ? me.people : [])
  const current = $derived(people.find(p => p.id === me.person)?.name ?? me.name ?? '')

  function pick(value: string) {
    const url = new URL(location.href)
    if (Number(value) === me.me) url.searchParams.delete('person')
    else url.searchParams.set('person', value)
    goto(url)
  }
</script>

{#if people.length > 1}
  <Select.Root type="single" value={String(me.person)} onValueChange={pick}>
    <Select.Trigger size="sm" aria-label="Whose dashboard">
      <span class="text-muted-foreground">Viewing</span>
      {current}
    </Select.Trigger>
    <Select.Content>
      {#each people as person (person.id)}
        <Select.Item value={String(person.id)} label={person.name}>{person.name}</Select.Item>
      {/each}
    </Select.Content>
  </Select.Root>
{/if}
