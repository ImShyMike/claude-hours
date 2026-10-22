<script lang="ts">
  import { tick } from 'svelte'
  import { page } from '$app/state'
  import { summarize } from '#lib/analytics/aggregate.js'
  import type { Timeline } from '#lib/analytics/replay.js'
  import * as Card from '#lib/components/ui/card/index.js'
  import { Skeleton } from '#lib/components/ui/skeleton/index.js'
  import * as Table from '#lib/components/ui/table/index.js'
  import { liveEvents, stored } from '#lib/dashboard/live.svelte.js'
  import { DRAFT_HEAD, buildDrafts, draftRow, projectTracks, time } from '#lib/dashboard/session.js'
  import { MIN, api, duration, palette } from '#lib/dashboard/shared.js'
  import ProjectChip from '#lib/dashboard/ui/ProjectChip.svelte'
  import Lanes from '#lib/dashboard/ui/session/Lanes.svelte'
  import Replay from '#lib/dashboard/ui/session/Replay.svelte'

  const live = liveEvents()
  const idle = stored('idle', '5')
  // going from one session to another keeps this page mounted, so everything
  // below follows the id
  const id = $derived(page.url.searchParams.get('id') ?? '')
  const idleCapMs = $derived(Number(idle.value) * MIN)

  // the drafts' replays, fetched again whenever the events refresh, so a
  // live session's new drafts get theirs
  let fetched = $state<{ id: string; timelines: Timeline[] }>()
  $effect(() => {
    const want = id
    if (!want || !live.events) return
    let stale = false
    api<Timeline[]>(`/api/session/${encodeURIComponent(want)}`)
      .then(timelines => {
        if (!stale) fetched = { id: want, timelines }
      })
      .catch(err => console.error('could not load the replays', err))
    return () => (stale = true)
  })

  const events = $derived((live.events ?? []).filter(e => e.sessionId === id).sort((a, b) => time(a) - time(b)))
  const ready = $derived(!!live.events && (!events.length || fetched?.id === id))
  const drafts = $derived(fetched?.id === id ? buildDrafts(events, fetched.timelines) : [])
  // named after where most of its time went, with the rest under it
  const split = $derived(summarize(events, { idleCapMs }).sessions[0]?.projects ?? [])
  const project = $derived(split[0]?.project ?? events.find(e => e.project)?.project ?? 'session')
  // the same colors as the overview, from all of the person's sessions
  const colors = $derived(palette(live.events ? summarize(live.events, { idleCapMs }).projects : []))
  const tracks = $derived(projectTracks(events, idleCapMs, String(project)))

  // the draft being replayed, by id so a refresh keeps it; until one's
  // picked, the last one with a replay
  let picked = $state<{ session: string; draft: string }>()
  const selectedId = $derived(picked?.session === id ? picked.draft : [...drafts].reverse().find(d => d.timeline)?.id)
  const selected = $derived(drafts.find(d => d.id === selectedId))
  let replayCard = $state<HTMLElement>()

  async function pick(draft: string) {
    picked = { session: id, draft }
    await tick()
    replayCard?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }

  const subtitle = $derived.by(() => {
    if (!events.length) return ''
    const first = time(events[0]!)
    const last = time(events[events.length - 1]!)
    const sent = drafts.filter(d => d.outcome === 'sent').length
    const when = new Date(first).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    return `${when}, ${duration(last - first)} long · ${sent} sent, ${drafts.length - sent} abandoned · ${id.slice(0, 8)}`
  })
</script>

<svelte:head><title>{events.length ? `${project} session` : 'claude-hours session'}</title></svelte:head>

<div class="flex flex-col gap-6">
  {#if !ready}
    <Skeleton class="h-16 w-80 rounded-xl" />
    <Skeleton class="h-56 rounded-xl" />
    <Skeleton class="h-64 rounded-xl" />
  {:else if !events.length}
    <Card.Root>
      <Card.Content class="py-10 text-center text-sm text-muted-foreground">No events for this session</Card.Content>
    </Card.Root>
  {:else}
    <div class="flex flex-col gap-2">
      <div>
        <h1 class="text-2xl font-semibold tracking-tight">{project}</h1>
        <p class="text-sm text-muted-foreground">{subtitle}</p>
      </div>
      {#if split.length}
        <div class="flex flex-wrap gap-1">
          {#each split as p (p.project)}
            <ProjectChip {colors} project={p.project} ms={p.ms} />
          {/each}
        </div>
      {/if}
    </div>

    <Lanes {events} {drafts} {tracks} {colors} selected={selectedId} onpick={pick} />

    <Card.Root>
      <Card.Header>
        <Card.Title>Drafts</Card.Title>
        <Card.Description>Click one to replay it</Card.Description>
      </Card.Header>
      <Card.Content>
        <Table.Root>
          <Table.Header>
            <Table.Row>
              {#each DRAFT_HEAD as head, j (head)}
                <Table.Head class={j > 1 ? 'text-right' : ''}>{head}</Table.Head>
              {/each}
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {#each drafts as d (d.id)}
              <Table.Row
                class={['cursor-pointer', d.id === selectedId && 'bg-muted font-medium']}
                tabindex={0}
                aria-selected={d.id === selectedId}
                onclick={() => pick(d.id)}
                onkeydown={(e: KeyboardEvent) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), pick(d.id))}
              >
                {#each draftRow(d) as cell, j (j)}
                  <Table.Cell class={j > 1 ? 'text-right tabular-nums' : ''}>{cell}</Table.Cell>
                {/each}
              </Table.Row>
            {:else}
              <Table.Row>
                <Table.Cell colspan={DRAFT_HEAD.length} class="text-muted-foreground">No typed drafts in this session yet</Table.Cell>
              </Table.Row>
            {/each}
          </Table.Body>
        </Table.Root>
      </Card.Content>
    </Card.Root>

    {#if selected}
      {#key `${id}/${selected.id}`}
        <Replay draft={selected} bind:card={replayCard} />
      {/key}
    {/if}
  {/if}
</div>
