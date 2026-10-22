<script lang="ts">
  import { tick } from 'svelte'
  import MinusIcon from '@lucide/svelte/icons/minus'
  import PlusIcon from '@lucide/svelte/icons/plus'
  import type { Event } from '#lib/analytics/aggregate.js'
  import { Button } from '#lib/components/ui/button/index.js'
  import * as Card from '#lib/components/ui/card/index.js'
  import { Checkbox } from '#lib/components/ui/checkbox/index.js'
  import { Label } from '#lib/components/ui/label/index.js'
  import { stored } from '../../live.svelte'
  import { LANES_LEGEND, LANES_PAD, LANE_H, LANE_NAMES, lanes, type Draft, type ProjectPiece } from '../../session'
  import type { Palette } from '../../shared'
  import Shapes from './Shapes.svelte'

  let {
    events,
    drafts,
    tracks,
    colors,
    selected,
    onpick,
  }: { events: Event[]; drafts: Draft[]; tracks: ProjectPiece[][]; colors: Palette; selected?: string; onpick: (draft: string) => void } = $props()

  const MAX_ZOOM = 256
  const zoom = stored<string>('zoom', '1')
  const collapse = stored<'0' | '1'>('collapse', '0')
  let scroller = $state<HTMLElement>()
  let fit = $state(0)
  let scrolled = $state(false)

  const drawn = $derived(lanes({ events, drafts, tracks, colors, selected, fit, zoom: Number(zoom.value) || 1, collapse: collapse.value === '1' }))

  // zoom keeps the moment under the anchor (the pointer, or the middle) where it is
  async function setZoom(next: number, offset = (scroller?.clientWidth ?? 0) / 2) {
    if (!scroller) return
    const ms = drawn.axis.at(scroller.scrollLeft + offset)
    const clamped = Math.max(1, Math.min(MAX_ZOOM, next))
    if (clamped === Number(zoom.value)) return
    zoom.value = String(clamped)
    await tick()
    scroller.scrollLeft = drawn.axis.x(ms) - offset
  }

  // ctrl + scroll (a trackpad pinch sends the same) zooms around the cursor,
  // one redraw per frame however many wheel events arrive in it; plain
  // scrolling still scrolls the page. Non-passive, to stop the page zooming
  $effect(() => {
    const el = scroller
    if (!el) return
    let wheel: { by: number; clientX: number } | undefined
    let frame = 0
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      wheel = { by: (wheel?.by ?? 1) * Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.002)), clientX: e.clientX }
      frame ||= requestAnimationFrame(() => {
        const { by, clientX } = wheel!
        wheel = undefined
        frame = 0
        setZoom(Number(zoom.value) * by, clientX - el.getBoundingClientRect().left)
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      el.removeEventListener('wheel', onWheel)
      cancelAnimationFrame(frame)
    }
  })
</script>

<Card.Root>
  <Card.Header>
    <Card.Title>Session timeline</Card.Title>
    <Card.Description>Click a prompt to replay how it was written</Card.Description>
  </Card.Header>
  <Card.Content class="flex flex-col gap-3">
    <div class="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
      <div class="flex flex-[1_1_20rem] flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {#each LANES_LEGEND as [swatch, label] (label)}
          <span class="inline-flex items-center gap-1.5"><span class={['inline-block size-2.5 shrink-0 rounded-sm', swatch]}></span>{label}</span>
        {/each}
      </div>
      <div class="flex items-center gap-3">
        <div class="flex items-center gap-2">
          <Checkbox id="collapse" bind:checked={() => collapse.value === '1', on => (collapse.value = on ? '1' : '0')} />
          <Label for="collapse" class="font-normal text-muted-foreground">Collapse gaps</Label>
        </div>
        <div class="flex gap-1" role="group" aria-label="Zoom">
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Zoom out"
            title="Zoom out (or ctrl + scroll)"
            disabled={Number(zoom.value) <= 1}
            onclick={() => setZoom(Number(zoom.value) / 2)}
          >
            <MinusIcon />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Zoom in"
            title="Zoom in (or ctrl + scroll)"
            disabled={Number(zoom.value) >= MAX_ZOOM}
            onclick={() => setZoom(Number(zoom.value) * 2)}
          >
            <PlusIcon />
          </Button>
        </div>
      </div>
    </div>
    <div class="relative">
      <div class="overflow-x-auto" bind:this={scroller} bind:clientWidth={fit} onscroll={e => (scrolled = e.currentTarget.scrollLeft > 0)}>
        <svg
          class="block overflow-visible"
          viewBox="0 0 {drawn.width} {drawn.height}"
          width={drawn.width}
          height={drawn.height}
          role="img"
          aria-label="Session timeline"
        >
          <!-- a pause shows the card through stripes, tighter for a short pause and wider for a break -->
          <defs>
            {#each [['hatch-pause', 4], ['hatch-break', 8]] as const as [id, gap] (id)}
              <pattern {id} width={gap} height={gap} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <rect class="fill-card" width={gap} height={gap} />
                <line class="stroke-(--typed) stroke-2" x1="0" y1="0" x2="0" y2={gap} />
              </pattern>
            {/each}
          </defs>
          <Shapes shapes={drawn.shapes} {onpick} />
        </svg>
      </div>
      <!-- the lane names stay put over the chart when a zoomed timeline scrolls
           sideways, below the time axis so its ticks scroll by uncovered -->
      <div
        class={['pointer-events-none absolute left-0 bg-card text-xs text-muted-foreground', scrolled && 'shadow-[6px_0_6px_-6px_var(--border)]']}
        style:top="{LANES_PAD.top - 4}px"
        style:width="{LANES_PAD.left - 4}px"
        style:height="{drawn.height - LANES_PAD.top + 4}px"
        aria-hidden="true"
      >
        {#each LANE_NAMES as name, i (name)}
          <span class="absolute left-0" style:top="{drawn.laneY(i) - LANES_PAD.top + 4}px" style:line-height="{LANE_H}px">{name}</span>
        {/each}
      </div>
    </div>
  </Card.Content>
</Card.Root>
