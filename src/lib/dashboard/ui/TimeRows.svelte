<script lang="ts">
  import { tick, type Snippet } from 'svelte'
  import MinusIcon from '@lucide/svelte/icons/minus'
  import PlusIcon from '@lucide/svelte/icons/plus'
  import type { Interval } from '#lib/analytics/aggregate.js'
  import { Button } from '#lib/components/ui/button/index.js'
  import { axisOf } from '../axis'
  import { guides, type Bar, type Row } from '../rows'
  import { hideTip, showTip } from '../shared'

  // The chart the timeline and the session page share: a sticky label per
  // row, one time axis over `spans` (quiet stretches longer than gapMs
  // squashed into breaks), and bars that light up by group. `clock` turns a
  // value on the axis into the moment it stands for, for the tick labels
  let {
    rows,
    spans,
    gapMs = Infinity,
    minMs,
    clock = v => v,
    gapTip,
    zoom = $bindable(1),
    maxZoom = 64,
    legend,
    controls,
  }: {
    rows: Row[]
    spans: Interval[]
    gapMs?: number
    minMs?: number
    clock?: (v: number) => number
    gapTip?: (from: number, to: number) => string
    zoom?: number
    maxZoom?: number
    legend?: Snippet
    controls?: Snippet
  } = $props()

  const GAP_PX = 48
  let innerWidth = $state(1024)
  let scroller = $state<HTMLElement>()
  let scrollW = $state(0)
  let scrolled = $state(false)
  const labelW = $derived(innerWidth < 560 ? 88 : 112)
  // the track stretches with zoom; never so narrow the axis has no room
  const trackW = $derived(Math.max(160, (scrollW - labelW) * zoom))
  const axis = $derived(axisOf(spans, 0, trackW, gapMs, GAP_PX, minMs))
  const g = $derived(guides(axis, trackW, clock))
  const ends = $derived([axis.segments[0]?.[0] ?? 0, axis.segments[axis.segments.length - 1]?.[1] ?? 0])

  // the group under the pointer, lit up wherever its bars are
  let lit = $state<string>()

  // zoom keeps the moment under the anchor (the pointer, or the middle of the track) where it is
  async function setZoom(next: number, offset = labelW + (scrollW - labelW) / 2) {
    if (!scroller) return
    const at = axis.at(scroller.scrollLeft + offset - labelW)
    const clamped = Math.max(1, Math.min(maxZoom, next))
    if (clamped === zoom) return
    zoom = clamped
    await tick()
    scroller.scrollLeft = axis.x(at) + labelW - offset
  }

  // The wheel (or a trackpad pinch, which sends ctrl + wheel) zooms around
  // the cursor, one redraw per frame however many wheel events arrive in it.
  // Sideways scrolling still pans, and once zoom can't go further the wheel
  // scrolls the page again. Non-passive, to stop the page scrolling or zooming
  $effect(() => {
    const el = scroller
    if (!el) return
    let wheel: { by: number; clientX: number } | undefined
    let frame = 0
    const onWheel = (e: WheelEvent) => {
      const pinch = e.ctrlKey || e.metaKey
      if (!pinch && (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY))) return
      const goal = zoom * (wheel?.by ?? 1)
      if ((e.deltaY < 0 && goal >= maxZoom) || (e.deltaY > 0 && goal <= 1)) return
      e.preventDefault()
      wheel = { by: (wheel?.by ?? 1) * Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.002)), clientX: e.clientX }
      frame ||= requestAnimationFrame(() => {
        const { by, clientX } = wheel!
        wheel = undefined
        frame = 0
        setZoom(zoom * by, Math.max(labelW, clientX - el.getBoundingClientRect().left))
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      el.removeEventListener('wheel', onWheel)
      cancelAnimationFrame(frame)
    }
  })

  // Pressing and moving pans it, with a mouse or pen (a finger already does).
  // A press that hardly moves is still a click; one that moved isn't, so
  // letting go over a bar doesn't open it. A press never starts a text
  // selection, and while it drags, one layer over the rows carries the
  // grabbing cursor: a class on the scroller would restyle every bar in it
  const DRAG_PX = 4
  let dragging = $state(false)
  const pannable = $derived(labelW + trackW > scrollW + 1)
  $effect(() => {
    const el = scroller
    if (!el) return
    let press: { id: number; x: number; left: number } | undefined
    let moved = false
    const onDown = (e: PointerEvent) => {
      moved = false
      if (e.pointerType === 'touch' || e.button !== 0 || el.scrollWidth <= el.clientWidth) return
      press = { id: e.pointerId, x: e.clientX, left: el.scrollLeft }
    }
    const onMove = (e: PointerEvent) => {
      if (press?.id !== e.pointerId) return
      const dx = e.clientX - press.x
      if (!moved && Math.abs(dx) < DRAG_PX) return
      if (!moved) {
        moved = dragging = true
        el.setPointerCapture(e.pointerId)
        hideTip()
      }
      el.scrollLeft = press.left - dx
    }
    const onUp = (e: PointerEvent) => {
      if (press?.id !== e.pointerId) return
      press = undefined
      dragging = false
    }
    // the click that ends a drag, caught before the bar it lands on sees it
    const onClick = (e: MouseEvent) => {
      if (!moved) return
      moved = false
      e.preventDefault()
      e.stopPropagation()
    }
    const noNativeDrag = (e: DragEvent) => e.preventDefault()
    const noSelecting = (e: Event) => press && e.preventDefault()
    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onUp)
    el.addEventListener('click', onClick, true)
    el.addEventListener('dragstart', noNativeDrag)
    el.addEventListener('selectstart', noSelecting)
    return () => {
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointercancel', onUp)
      el.removeEventListener('click', onClick, true)
      el.removeEventListener('dragstart', noNativeDrag)
      el.removeEventListener('selectstart', noSelecting)
    }
  })

  const tipOf = (html?: string) => (html ? (e: MouseEvent) => showTip(e, html) : undefined)

  const ringOf = (b: Bar, rest = '') =>
    b.plain
      ? 'z-[11]'
      : b.selected || (b.group && b.group === lit)
        ? 'z-10 shadow-[0_0_0_1px_var(--card),0_0_0_2px_var(--foreground)]'
        : `${rest} shadow-[0_0_0_1px_var(--card)]`

  // The bars that open the same place make one link around them, so a
  // session is one Tab stop and one target for a finger however many pieces
  // it has, and the link is never under 24px a side: thinner ones grow
  // around their middle. Its bars sit over every link's grown edge, so a
  // bar always opens its own session. Bars that only pick something stay loose
  const TARGET_PX = 24
  type Link = { href: string; label?: string; from: number; to: number; top: number; height: number; bars: Bar[] }
  function linksOf(bars: Bar[]) {
    const loose: Bar[] = []
    const links = new Map<string, Link>()
    for (const b of bars) {
      if (!b.href) {
        loose.push(b)
        continue
      }
      const l = links.get(b.href)
      if (!l) {
        links.set(b.href, { href: b.href, label: b.label, from: b.from, to: b.to, top: b.top, height: b.height, bars: [b] })
        continue
      }
      const bottom = Math.max(l.top + l.height, b.top + b.height)
      l.from = Math.min(l.from, b.from)
      l.to = Math.max(l.to, b.to)
      l.top = Math.min(l.top, b.top)
      l.height = bottom - l.top
      l.bars.push(b)
    }
    for (const l of links.values()) {
      const grow = Math.max(0, TARGET_PX - l.height)
      l.top -= grow / 2
      l.height += grow
    }
    return { loose, links: [...links.values()] }
  }
</script>

<svelte:window bind:innerWidth />

<div class="flex flex-col gap-3">
  <div class="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
    <div class="flex-[1_1_20rem]">{@render legend?.()}</div>
    <div class="flex items-center gap-3">
      {@render controls?.()}
      <div class="flex gap-1" role="group" aria-label="Zoom">
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="Zoom out"
          title="Zoom out (or scroll)"
          disabled={zoom <= 1}
          onclick={() => setZoom(zoom / 2)}
        >
          <MinusIcon />
        </Button>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="Zoom in"
          title="Zoom in (or scroll)"
          disabled={zoom >= maxZoom}
          onclick={() => setZoom(zoom * 2)}
        >
          <PlusIcon />
        </Button>
      </div>
    </div>
  </div>
  <div
    class={['overflow-x-auto', pannable && 'cursor-grab']}
    bind:this={scroller}
    bind:clientWidth={scrollW}
    onscroll={e => (scrolled = e.currentTarget.scrollLeft > 0)}
  >
    <div class="relative min-w-full overflow-x-clip text-xs" style:width="{labelW + trackW}px">
      {#if dragging}<div class="absolute inset-0 z-30 cursor-grabbing"></div>{/if}
      <!-- behind the rows: a hairline at every tick, and each squashed stretch hatched -->
      <div class="pointer-events-none absolute top-5 bottom-0" style:left="{labelW}px" style:width="{trackW}px">
        {#each g.ticks as t (t.left)}
          <span class="absolute inset-y-0 w-px bg-border" style:left="{t.left}px"></span>
        {/each}
        {#each g.breaks as b (b.from)}
          <span
            class="pointer-events-auto absolute inset-y-0 bg-[repeating-linear-gradient(135deg,var(--border)_0_1px,transparent_1px_6px)]"
            style:left="{b.left}px"
            style:width="{b.width}px"
            role="presentation"
            onmousemove={tipOf(gapTip?.(b.from, b.to))}
            onmouseleave={gapTip ? hideTip : undefined}
          ></span>
        {/each}
      </div>
      <div class="flex">
        <div class="sticky left-0 z-20 shrink-0 bg-card" style:width="{labelW}px"></div>
        <div class="relative h-5 flex-1">
          {#each g.ticks as t (t.left)}
            <span class="absolute top-0.5 border-l pl-1 whitespace-nowrap text-muted-foreground tabular-nums" style:left="{t.left}px">{t.label}</span>
          {/each}
          {#each g.breaks as b (b.from)}
            {#if b.label}
              <span
                class="absolute top-0.5 -translate-x-1/2 font-medium whitespace-nowrap text-muted-foreground tabular-nums"
                style:left="{b.left + b.width / 2}px">{b.label}</span
              >
            {/if}
          {/each}
        </div>
      </div>
      {#each rows as row (row.key)}
        {@const label = ['sticky left-0 z-20 shrink-0 bg-card pr-2 whitespace-nowrap', scrolled && 'shadow-[6px_0_6px_-6px_var(--border)]']}
        <!-- the padding goes inside the sticky label, so it hides anything scrolled under it -->
        {#if row.quiet}
          <div class="flex border-t border-dashed">
            <div class={[label, 'py-1 text-muted-foreground']} style:width="{labelW}px">{row.label}</div>
          </div>
        {:else}
          {@const { loose, links } = linksOf(row.bars)}
          <div class="flex border-t">
            <div class={[label, 'flex flex-col justify-center py-1.5 tabular-nums']} style:width="{labelW}px">
              <span>{row.label}</span>
              {#if row.sub}<span class="text-muted-foreground">{row.sub}</span>{/if}
            </div>
            <!-- a container, so a bar inside a link can still be placed against the track's width (cqw) -->
            <div class="@container pointer-events-none relative my-1.5 flex-1" style:height="{row.height}px">
              {#each loose as b, i (i)}
                <!-- a bar to click picks something the page also offers by keyboard (the drafts table) -->
                <!-- placed in CSS against the track's width, so a zoom doesn't restyle every bar -->
                <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
                <div
                  class={['pointer-events-auto absolute min-w-0.5 rounded-[3px]', b.onclick && 'cursor-pointer', ringOf(b), b.class]}
                  aria-label={b.label}
                  style:left={axis.css(b.from)}
                  style:width={axis.cssLength(b.from, b.to)}
                  style:top="{b.top}px"
                  style:height="{b.height}px"
                  style:background={b.color}
                  onclick={b.onclick}
                  onmouseenter={b.group ? () => (lit = b.group) : undefined}
                  onmousemove={tipOf(b.tip)}
                  onmouseleave={() => {
                    if (b.group) lit = undefined
                    if (b.tip) hideTip()
                  }}
                ></div>
              {/each}
              {#each links as l (l.href)}
                {@const length = axis.cssLength(l.from, l.to, '100cqw')}
                <!-- how far a thin link grows each side to reach TARGET_PX -->
                {@const grow = `max(0px, (${TARGET_PX}px - ${length}) / 2)`}
                {@const start = `calc(${axis.css(l.from, '100cqw')} - ${grow})`}
                <!-- no z-index of its own, so the rings of the bars in it still stack over other links' bars -->
                <a
                  class="pointer-events-auto absolute cursor-pointer rounded-[3px] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-foreground"
                  href={l.href}
                  aria-label={l.label}
                  style:left={start}
                  style:width="max({TARGET_PX}px, {length})"
                  style:top="{l.top}px"
                  style:height="{l.height}px"
                  onmouseenter={l.bars[0]!.group ? () => (lit = l.bars[0]!.group) : undefined}
                  onmouseleave={l.bars[0]!.group ? () => (lit = undefined) : undefined}
                >
                  {#each l.bars as b, i (i)}
                    <div
                      class={['absolute min-w-0.5 rounded-[3px]', ringOf(b, 'z-[1]'), b.class]}
                      role="presentation"
                      style:left="calc({axis.css(b.from, '100cqw')} - {start})"
                      style:width={axis.cssLength(b.from, b.to, '100cqw')}
                      style:top="{b.top - l.top}px"
                      style:height="{b.height}px"
                      style:background={b.color}
                      onmousemove={tipOf(b.tip)}
                      onmouseleave={b.tip ? hideTip : undefined}
                    ></div>
                  {/each}
                </a>
              {/each}
              {#each row.marks ?? [] as m, i (i)}
                {#if m.at >= ends[0]! && m.at <= ends[1]!}
                  <!-- a wider target than the line, so it's easy to hover -->
                  <span
                    class="pointer-events-auto absolute -top-[7px] -bottom-1.5 z-[12] w-2 -translate-x-1/2"
                    style:left="{axis.x(m.at)}px"
                    role="presentation"
                    onmousemove={tipOf(m.tip)}
                    onmouseleave={m.tip ? hideTip : undefined}
                  >
                    <span class={['absolute inset-y-0 left-[3px]', m.class]}></span>
                    {#if m.glyph}<span class={['absolute top-1.5 left-[7px] text-[11px] leading-none font-bold', m.glyphClass]}>{m.glyph}</span>{/if}
                  </span>
                {/if}
              {/each}
            </div>
          </div>
        {/if}
      {/each}
    </div>
  </div>
</div>
