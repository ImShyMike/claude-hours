<script lang="ts">
  import { tick } from 'svelte'
  import { page } from '$app/state'
  import { summarize } from '#lib/analytics/aggregate.js'
  import * as Card from '#lib/components/ui/card/index.js'
  import { Skeleton } from '#lib/components/ui/skeleton/index.js'
  import * as Table from '#lib/components/ui/table/index.js'
  import { liveSession } from '#lib/dashboard/live.svelte.js'
  import { DRAFT_HEAD, buildDrafts, draftRow, projectTracks, time } from '#lib/dashboard/session.js'
  import { duration, palette } from '#lib/dashboard/shared.js'
  import Pager from '#lib/dashboard/ui/Pager.svelte'
  import ProjectChip from '#lib/dashboard/ui/ProjectChip.svelte'
  import Lanes from '#lib/dashboard/ui/session/Lanes.svelte'
  import Replay from '#lib/dashboard/ui/session/Replay.svelte'

  // going from one session to another keeps this page mounted, so everything
  // below follows the id. Its events and the drafts' replays come together,
  // so a live session's new drafts get theirs
  const id = $derived(page.url.searchParams.get('id') ?? '')
  const live = liveSession(() => id)
  const idleCapMs = $derived(live.value?.idleCapMs ?? 0)

  const events = $derived([...(live.value?.events ?? [])].sort((a, b) => time(a) - time(b)))
  const ready = $derived(!!live.value)
  const drafts = $derived(live.value ? buildDrafts(events, live.value.timelines) : [])
  // named after where most of its time went, with the rest under it
  const split = $derived(summarize(events, { idleCapMs }).sessions[0]?.projects ?? [])
  const project = $derived(split[0]?.project ?? events.find(e => e.project)?.project ?? 'session')
  // the same colors as the overview, from all of the person's sessions
  const colors = $derived(palette(live.value?.projects ?? []))
  const tracks = $derived(projectTracks(events, idleCapMs, String(project)))

  // the draft being replayed, by id so a refresh keeps it; until one's
  // picked, the last one with a replay
  let picked = $state<{ session: string; draft: string }>()
  const selectedId = $derived(picked?.session === id ? picked.draft : [...drafts].reverse().find(d => d.timeline)?.id)
  const selected = $derived(drafts.find(d => d.id === selectedId))
  let replayCard = $state<HTMLElement>()

  // the drafts table a page at a time, on the page with the one being
  // replayed until another page is picked
  const PAGE = 15
  const pages = $derived(Math.max(1, Math.ceil(drafts.length / PAGE)))
  const pageOf = (draft?: string) => Math.max(0, Math.floor(drafts.findIndex(d => d.id === draft) / PAGE))
  let paged = $state<{ session: string; page: number }>()
  const current = $derived(Math.min(pages - 1, paged?.session === id ? paged.page : pageOf(selectedId)))
  const shown = $derived(drafts.slice(current * PAGE, (current + 1) * PAGE))
  const turnTo = (next: number) => (paged = { session: id, page: Math.max(0, Math.min(pages - 1, next)) })

  async function pick(draft: string) {
    picked = { session: id, draft }
    turnTo(pageOf(draft))
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
            {#each shown as d (d.id)}
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
        <Pager bind:page={() => current, turnTo} count={drafts.length} size={PAGE} back="Earlier drafts" on="Later drafts" />
      </Card.Content>
    </Card.Root>

    {#if selected}
      {#key `${id}/${selected.id}`}
        <Replay draft={selected} bind:card={replayCard} />
      {/key}
    {/if}
  {/if}
</div>
