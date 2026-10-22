<script lang="ts">
  import { tick } from 'svelte'
  import MinusIcon from '@lucide/svelte/icons/minus'
  import PlusIcon from '@lucide/svelte/icons/plus'
  import { dayKey, summarize } from '#lib/analytics/aggregate.js'
  import { Button } from '#lib/components/ui/button/index.js'
  import * as Card from '#lib/components/ui/card/index.js'
  import { Checkbox } from '#lib/components/ui/checkbox/index.js'
  import { Label } from '#lib/components/ui/label/index.js'
  import { Skeleton } from '#lib/components/ui/skeleton/index.js'
  import { liveEvents, stored } from '#lib/dashboard/live.svelte.js'
  import { longDay } from '#lib/dashboard/overview.js'
  import { MIN, duration, esc, hideTip, palette, rangeWindow, showTip, withPerson, type Range } from '#lib/dashboard/shared.js'
  import { MAX_ZOOM, hm, nextDay, pct, ticks, timelineRows, type Piece } from '#lib/dashboard/timeline.js'
  import Legend from '#lib/dashboard/ui/Legend.svelte'
  import RangePicker from '#lib/dashboard/ui/RangePicker.svelte'

  const live = liveEvents()
  const range = stored<Range>('range', '7')
  const idle = stored('idle', '5')
  const fit = stored<'0' | '1'>('fit', '1')

  // all time: each project's color and each session's home
  const ever = $derived(live.events && summarize(live.events, { idleCapMs: Number(idle.value) * MIN }))
  const colors = $derived(palette(ever?.projects ?? []))
  const homes = $derived(new Map(ever?.sessions.map(s => [s.sessionId, s.project])))
  const home = (id: string) => homes.get(id) ?? ''
  const tl = $derived(ever && timelineRows(ever.spans, rangeWindow(range.value), home, fit.value === '1'))

  let innerWidth = $state(1024)
  let scroller = $state<HTMLElement>()
  let scrollW = $state(0)
  let zoom = $state(1)
  // the rows stretch with zoom, the bars are in percent so only widths move
  const labelW = $derived(innerWidth < 560 ? 88 : 112)
  const trackW = $derived(Math.max(0, (scrollW - labelW) * zoom))
  const span = $derived(tl ? tl.hours.to - tl.hours.from : 24)

  // the session under the pointer, lit up wherever its bars are
  let lit = $state<string>()
  let now = $state(Date.now())
  $effect(() => {
    const timer = setInterval(() => (now = Date.now()), 30_000)
    return () => clearInterval(timer)
  })

  // zoom keeps whatever's under the anchor (the middle, or the pointer) in place
  async function setZoom(next: number, anchor = (scrollW + labelW) / 2) {
    if (!scroller) return
    const at = (scroller.scrollLeft + anchor - labelW) / trackW
    zoom = Math.min(MAX_ZOOM, Math.max(1, next))
    await tick()
    scroller.scrollLeft = at * trackW - (anchor - labelW)
  }

  // ctrl + scroll zooms; it has to be a non-passive listener to stop the page zooming
  $effect(() => {
    const el = scroller
    if (!el) return
    let wheel = 0
    let wheelX = 0
    let frame = 0
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      wheel += e.deltaY
      wheelX = e.clientX - el.getBoundingClientRect().left
      frame ||= requestAnimationFrame(() => {
        setZoom(zoom * Math.exp(-wheel * 0.002), Math.max(labelW, wheelX))
        wheel = 0
        frame = 0
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  })

  function tip(p: Piece) {
    const from = home(p.sessionId)
    return `<strong>${esc(p.project)}</strong>${hm(p.from)} to ${hm(p.to)} · ${duration(p.to - p.from)}<span class="muted">session ${esc(p.sessionId.slice(0, 8))}${from && from !== p.project ? `, started in ${esc(from)}` : ''}</span>`
  }
</script>

<svelte:head><title>claude-hours timeline</title></svelte:head>
<svelte:window bind:innerWidth />

<div class="flex flex-col gap-6">
  <div class="flex flex-wrap items-end justify-between gap-4">
    <div>
      <h1 class="text-2xl font-semibold tracking-tight">Timeline</h1>
      <p class="text-sm text-muted-foreground">Every session, {rangeWindow(range.value).label}</p>
    </div>
    <RangePicker bind:range={range.value} />
  </div>

  {#if !tl}
    <Skeleton class="h-96 rounded-xl" />
  {:else if !tl.rows.length}
    <Card.Root>
      <Card.Content class="py-10 text-center text-sm text-muted-foreground">Nothing logged in this range yet</Card.Content>
    </Card.Root>
  {:else}
    <Card.Root>
      <Card.Header>
        <Card.Title>Every session</Card.Title>
        <Card.Description>A row per day, click a bar to open it</Card.Description>
      </Card.Header>
      <Card.Content class="flex flex-col gap-3">
        <div class="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
          <div class="flex-[1_1_20rem]"><Legend {colors} projects={tl.projects} /></div>
          <div class="flex items-center gap-3">
            <div class="flex items-center gap-2">
              <Checkbox id="fit" bind:checked={() => fit.value === '1', on => (fit.value = on ? '1' : '0')} />
              <Label for="fit" class="font-normal text-muted-foreground">Fit to active hours</Label>
            </div>
            <div class="flex gap-1" role="group" aria-label="Zoom">
              <Button
                variant="outline"
                size="icon-sm"
                aria-label="Zoom out"
                title="Zoom out (or ctrl + scroll)"
                disabled={zoom <= 1}
                onclick={() => setZoom(zoom / 2)}
              >
                <MinusIcon />
              </Button>
              <Button
                variant="outline"
                size="icon-sm"
                aria-label="Zoom in"
                title="Zoom in (or ctrl + scroll)"
                disabled={zoom >= MAX_ZOOM}
                onclick={() => setZoom(zoom * 2)}
              >
                <PlusIcon />
              </Button>
            </div>
          </div>
        </div>
        <div class="overflow-x-auto" bind:this={scroller} bind:clientWidth={scrollW}>
          <div class="min-w-full overflow-x-clip text-xs" style:width="{labelW + trackW}px">
            <div class="flex">
              <div class="sticky left-0 z-20 shrink-0 bg-card" style:width="{labelW}px"></div>
              <div class="relative h-5 flex-1">
                {#each ticks(tl.hours, trackW) as t (t.left)}
                  <span class="absolute top-0.5 border-l pl-1 whitespace-nowrap text-muted-foreground tabular-nums" style:left="{t.left}%"
                    >{t.label}</span
                  >
                {/each}
              </div>
            </div>
            {#each tl.rows as row (row.day)}
              {#if row.kind === 'quiet'}
                <!-- the padding goes inside the sticky label, so it hides anything scrolled under it -->
                <div class="flex border-t border-dashed">
                  <div class="sticky left-0 z-20 shrink-0 bg-card py-1 text-muted-foreground" style:width="{labelW}px">
                    {row.days} quiet day{row.days === 1 ? '' : 's'}
                  </div>
                </div>
              {:else}
                <div class="flex border-t">
                  <div
                    class="sticky left-0 z-20 flex shrink-0 flex-col justify-center bg-card py-1.5 pr-2 whitespace-nowrap tabular-nums"
                    style:width="{labelW}px"
                  >
                    <span>{longDay(dayKey(row.day))}</span>
                    <span class="text-muted-foreground">{duration(row.activeMs)}</span>
                  </div>
                  <!-- a hairline every hour -->
                  <div
                    class="relative my-1.5 flex-1"
                    style:height="{row.height}px"
                    style:background-image="linear-gradient(to right, var(--border) 1px, transparent 1px)"
                    style:background-size="{trackW / span}px 100%"
                  >
                    {#each row.bars as { piece, top, height }, i (i)}
                      <a
                        class={[
                          'absolute min-w-0.5 rounded-[3px] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-foreground',
                          lit === piece.sessionId
                            ? 'z-10 shadow-[0_0_0_1px_var(--card),0_0_0_2px_var(--foreground)]'
                            : 'shadow-[0_0_0_1px_var(--card)]',
                        ]}
                        href={withPerson(`/session?id=${encodeURIComponent(piece.sessionId)}`)}
                        aria-label="{piece.project}, {hm(piece.from)} to {hm(piece.to)}"
                        style:left="{pct(tl.hours, row.day, piece.from)}%"
                        style:width="{pct(tl.hours, row.day, piece.to) - pct(tl.hours, row.day, piece.from)}%"
                        style:top="{top}px"
                        style:height="{height}px"
                        style:background={colors.color(piece.project)}
                        onmouseenter={() => (lit = piece.sessionId)}
                        onmousemove={e => showTip(e, tip(piece))}
                        onmouseleave={() => {
                          lit = undefined
                          hideTip()
                        }}
                      ></a>
                    {/each}
                    {#if now >= row.day && now < nextDay(row.day) && pct(tl.hours, row.day, now) <= 100}
                      <span
                        class="absolute -top-1.5 -bottom-1.5 border-l-2 border-muted-foreground"
                        style:left="{pct(tl.hours, row.day, now)}%"
                        title="now"
                      ></span>
                    {/if}
                  </div>
                </div>
              {/if}
            {/each}
          </div>
        </div>
        <p class="text-xs text-muted-foreground">A thin bar under a session is a subagent working in another repo at the same time</p>
      </Card.Content>
    </Card.Root>
  {/if}
</div>
