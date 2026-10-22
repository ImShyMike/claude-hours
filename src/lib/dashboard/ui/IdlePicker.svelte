<script lang="ts">
  import * as Select from '#lib/components/ui/select/index.js'

  // how long a quiet stretch still counts as active, in minutes
  let { idle = $bindable() }: { idle: string } = $props()
  const CAPS = ['2', '5', '10', '15']
</script>

<Select.Root type="single" bind:value={idle}>
  <Select.Trigger size="sm" aria-label="Idle cap">
    <span class="text-muted-foreground">Idle cap</span>
    {idle} min
  </Select.Trigger>
  <Select.Content>
    {#each CAPS as cap (cap)}
      <Select.Item value={cap} label="{cap} min">{cap} min</Select.Item>
    {/each}
  </Select.Content>
</Select.Root>
