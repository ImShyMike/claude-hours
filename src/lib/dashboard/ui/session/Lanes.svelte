<script lang="ts">
  import type { Event } from '#lib/analytics/aggregate.js'
  import * as Card from '#lib/components/ui/card/index.js'
  import { Checkbox } from '#lib/components/ui/checkbox/index.js'
  import { Label } from '#lib/components/ui/label/index.js'
  import { stored } from '../../live.svelte'
  import { GAP_MS, LANES_LEGEND, laneRows, mostlyQuiet, type Draft, type ProjectPiece } from '../../session'
  import { clockTime, duration, load, type Palette } from '../../shared'
  import TimeRows from '../TimeRows.svelte'

  let {
    events,
    drafts,
    tracks,
    colors,
    selected,
    onpick,
  }: { events: Event[]; drafts: Draft[]; tracks: ProjectPiece[][]; colors: Palette; selected?: string; onpick: (draft: string) => void } = $props()

  const zoom = stored<string>('zoom', '1')
  // auto collapses a session that's mostly quiet; the checkbox pins it either
  // way (the old setting carries over when it was on)
  const gaps = stored<'auto' | '0' | '1'>('gaps', load<string>('collapse', '0') === '1' ? '1' : 'auto')
  const lanes = $derived(laneRows({ events, drafts, tracks, colors, selected, onpick }))
  const collapsed = $derived(gaps.value === 'auto' ? mostlyQuiet(lanes.spans) : gaps.value === '1')
  const gapTip = (from: number, to: number) => `<strong>Nothing for ${duration(to - from)}</strong>${clockTime(from)} to ${clockTime(to)}, collapsed`
</script>

<Card.Root>
  <Card.Header>
    <Card.Title>Session timeline</Card.Title>
    <Card.Description>Click a prompt to replay how it was written</Card.Description>
  </Card.Header>
  <Card.Content>
    <TimeRows
      rows={lanes.rows}
      spans={lanes.spans}
      gapMs={collapsed ? GAP_MS : Infinity}
      {gapTip}
      bind:zoom={() => Number(zoom.value) || 1, next => (zoom.value = String(next))}
      maxZoom={256}
    >
      {#snippet legend()}
        <div class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {#each LANES_LEGEND as [swatch, label] (label)}
            <span class="inline-flex items-center gap-1.5"><span class={['inline-block size-2.5 shrink-0 rounded-sm', swatch]}></span>{label}</span>
          {/each}
        </div>
      {/snippet}
      {#snippet controls()}
        <div class="flex items-center gap-2">
          <Checkbox id="collapse" bind:checked={() => collapsed, on => (gaps.value = on ? '1' : '0')} />
          <Label for="collapse" class="font-normal text-muted-foreground">Collapse gaps</Label>
        </div>
      {/snippet}
    </TimeRows>
  </Card.Content>
</Card.Root>
