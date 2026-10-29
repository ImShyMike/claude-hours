<script lang="ts">
  import type { Counting } from '#lib/analytics/aggregate.js'
  import * as ToggleGroup from '#lib/components/ui/toggle-group/index.js'
  import { prefetchRange } from '../live.svelte'
  import type { Range } from '../shared'

  // spans: the page asks for them (the timeline), so the range fetched ahead
  // does too, counting what the page counts
  let { range = $bindable(), spans = false, counting = 'all' }: { range: Range; spans?: boolean; counting?: Counting } = $props()
  const RANGES: [Range, string][] = [
    ['today', 'Today'],
    ['7', '7 days'],
    ['30', '30 days'],
    ['all', 'All'],
  ]
  const ahead = (value: Range) => value !== range && prefetchRange(value, spans, counting)
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
    <ToggleGroup.Item {value} onpointerenter={() => ahead(value)} onfocus={() => ahead(value)}>{label}</ToggleGroup.Item>
  {/each}
</ToggleGroup.Root>
