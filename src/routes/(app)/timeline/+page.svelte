<script lang="ts">
  import { summarize } from '#lib/analytics/aggregate.js'
  import * as Card from '#lib/components/ui/card/index.js'
  import { Skeleton } from '#lib/components/ui/skeleton/index.js'
  import * as ToggleGroup from '#lib/components/ui/toggle-group/index.js'
  import { liveEvents, stored } from '#lib/dashboard/live.svelte.js'
  import { MIN, duration, palette, rangeWindow, withPerson, type Range } from '#lib/dashboard/shared.js'
  import { MAX_ZOOM, hm, startOfDay, timelineRows, type Hours } from '#lib/dashboard/timeline.js'
  import Legend from '#lib/dashboard/ui/Legend.svelte'
  import RangePicker from '#lib/dashboard/ui/RangePicker.svelte'
  import TimeRows from '#lib/dashboard/ui/TimeRows.svelte'

  const live = liveEvents()
  const range = stored<Range>('range', '7')
  const idle = stored('idle', '5')
  const hours = stored<Hours>('hours', 'fit')

  // all time: each project's color and each session's home
  const ever = $derived(live.events && summarize(live.events, { idleCapMs: Number(idle.value) * MIN }))
  const colors = $derived(palette(ever?.projects ?? []))
  const homes = $derived(new Map(ever?.sessions.map(s => [s.sessionId, s.project])))
  const look = $derived({
    color: colors.color,
    home: (id: string) => homes.get(id) ?? '',
    link: (id: string) => withPerson(`/session?id=${encodeURIComponent(id)}`),
  })
  const tl = $derived(ever && timelineRows(ever.spans, rangeWindow(range.value), look, hours.value))

  // the rows are in ms from each day's midnight; any midnight reads the same on the clock
  const DAY0 = new Date(2000, 0, 1).getTime()
  const clock = (v: number) => DAY0 + v
  const gapTip = (from: number, to: number) =>
    `<strong>Nothing for ${duration(to - from)}</strong>${hm(clock(from))} to ${hm(clock(to))} on any day shown`

  // today's row gets a line at the moment it is
  let now = $state(Date.now())
  $effect(() => {
    const timer = setInterval(() => (now = Date.now()), 30_000)
    return () => clearInterval(timer)
  })
  const rows = $derived(
    tl?.rows.map(r =>
      r.key === String(startOfDay(now))
        ? { ...r, marks: [{ at: now - startOfDay(now), class: 'border-l-2 border-muted-foreground', tip: `<strong>Now</strong>${hm(now)}` }] }
        : r,
    ),
  )
  let zoom = $state(1)
</script>

<svelte:head><title>claude-hours timeline</title></svelte:head>

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
        <TimeRows rows={rows!} spans={tl.spans} gapMs={tl.gapMs} minMs={tl.minMs} {clock} {gapTip} bind:zoom maxZoom={MAX_ZOOM}>
          {#snippet legend()}<Legend {colors} projects={tl.projects} />{/snippet}
          {#snippet controls()}
            <!-- a click on the one already picked would clear it, so that's ignored -->
            <ToggleGroup.Root
              type="single"
              variant="outline"
              size="sm"
              aria-label="Hours shown"
              bind:value={() => hours.value, (next: string) => next && (hours.value = next as Hours)}
            >
              <ToggleGroup.Item value="all" title="Every hour of the day">All day</ToggleGroup.Item>
              <ToggleGroup.Item value="fit" title="From the first active hour to the last">Active</ToggleGroup.Item>
              <ToggleGroup.Item value="squash" title="Only the hours anything happened in, quiet stretches squashed">Squash gaps</ToggleGroup.Item>
            </ToggleGroup.Root>
          {/snippet}
        </TimeRows>
        <p class="text-xs text-muted-foreground">A thin bar under a session is a subagent working in another repo at the same time</p>
      </Card.Content>
    </Card.Root>
  {/if}
</div>
