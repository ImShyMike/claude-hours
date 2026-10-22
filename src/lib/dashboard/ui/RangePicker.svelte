<script lang="ts">
  import * as ToggleGroup from '#lib/components/ui/toggle-group/index.js'
  import type { Range } from '../shared'

  let { range = $bindable() }: { range: Range } = $props()
  const RANGES: [Range, string][] = [
    ['today', 'Today'],
    ['7', '7 days'],
    ['30', '30 days'],
    ['all', 'All'],
  ]
</script>

<!-- a click on the one already picked would clear it, so that's ignored -->
<ToggleGroup.Root
  type="single"
  variant="outline"
  size="sm"
  aria-label="Range"
  bind:value={() => range, (next: string) => next && (range = next as Range)}
>
  {#each RANGES as [value, label] (value)}
    <ToggleGroup.Item {value}>{label}</ToggleGroup.Item>
  {/each}
</ToggleGroup.Root>
