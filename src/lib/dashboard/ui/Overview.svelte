<script lang="ts">
  import { page } from '$app/state'
  import { dayKey, type Summary } from '#lib/analytics/aggregate.js'
  import * as Card from '#lib/components/ui/card/index.js'
  import { Skeleton } from '#lib/components/ui/skeleton/index.js'
  import * as Table from '#lib/components/ui/table/index.js'
  import { liveDigest, stored, whoIsLooking } from '../live.svelte'
  import { HEAT_LABELS, hourLabel, longDay, modeName, series, shortDay, tipLines, toolName } from '../overview'
  import {
    MIN,
    attachments,
    compact,
    duration,
    esc,
    hideTip,
    modelName,
    palette,
    rangeWindow,
    seconds,
    showTip,
    withPerson,
    type Range,
  } from '../shared'
  import BarList from './BarList.svelte'
  import Calendar from './Calendar.svelte'
  import Columns from './Columns.svelte'
  import Legend from './Legend.svelte'
  import Pager from './Pager.svelte'
  import PersonPicker from './PersonPicker.svelte'
  import ProjectChip from './ProjectChip.svelte'
  import RangePicker from './RangePicker.svelte'
  import Stat from './Stat.svelte'

  // the overview of someone logged in; the page shows a welcome otherwise
  const who = whoIsLooking()
  const range = stored<Range>('range', '7')
  const live = liveDigest(() => range.value)
  const person = $derived(page.url.searchParams.get('person') ?? '')
  // the sessions table a page at a time, back to the newest whenever the
  // range or whose dashboard it is changes
  const SESSIONS = 15
  let paged = $state<{ key: string; page: number }>()
  const sessionPage = $derived(paged?.key === `${range.value} ${person}` ? paged.page : 0)
  const turnTo = (next: number) => (paged = { key: `${range.value} ${person}`, page: next })

  const period = $derived(rangeWindow(range.value))
  const s = $derived(live.value?.range)
  // most setups never let the mod see the mode, so its card waits for a
  // range that has some
  const modesSeen = $derived(!!s?.modes.some(m => m.mode !== 'unknown'))
  const modelsSeen = $derived(!!s?.models.length)
  // all time picks each project's color and fills the calendar
  const ever = $derived(live.value)
  const colors = $derived(palette(ever?.projects ?? []))
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

  function tiles(s: Summary) {
    const w = s.writing
    const totalTurns = s.turns + s.interrupts
    const avgWords = Math.round(s.prompts.avgWords)
    // the usual 5 characters a word, over the time actually typing
    const wpm = w.typingMs ? Math.round(w.typedChars / 5 / (w.typingMs / MIN)) : 0
    const sent = w.typedChars + w.pastedChars
    return [
      { label: 'Prompts', value: compact(s.prompts.count), sub: s.prompts.count ? `avg ${plural(avgWords, 'word')}` : '' },
      { label: 'Turns', value: compact(s.turns), sub: s.prompts.midTurn ? `${plural(s.prompts.midTurn, 'prompt')} sent mid-turn` : '' },
      {
        label: 'Interrupts',
        value: compact(s.interrupts),
        sub: totalTurns
          ? `${Math.round((s.interrupts / totalTurns) * 100)}% of turns${s.interruptsMidTool ? `, ${compact(s.interruptsMidTool)} mid-tool` : ''}`
          : '',
      },
      { label: 'Tokens out', value: compact(s.tokens.output), sub: s.tokens.cacheRead ? `${compact(s.tokens.cacheRead)} cache reads` : '' },
      w.sent || w.abandoned
        ? { label: 'Writing', value: duration(w.typingMs), sub: [`${w.abandoned} abandoned`, wpm && `${wpm} wpm`].filter(Boolean).join(' · ') }
        : { label: 'Writing', value: '-', sub: 'no typing data yet' },
      {
        label: 'Pasted',
        value: compact(w.pastedChars),
        sub: [sent && `${Math.round((w.pastedChars / sent) * 100)}% of chars`, attachments(w)].filter(Boolean).join(' · '),
      },
    ]
  }

  function writingStats(w: Summary['writing']) {
    const per = (n: number) => (n / w.measured).toFixed(1)
    return [
      { label: 'Typo fixes', value: per(w.fixes), sub: `${w.fixes} in all, 3 chars or fewer` },
      { label: 'Rewrites', value: per(w.rewrites), sub: `${w.rewrites} in all, ${compact(w.rewrittenChars)} chars redone` },
      {
        label: 'Deleted',
        value: per(w.deletedChars),
        sub: `chars${w.typedChars ? `, ${Math.round((w.deletedChars / w.typedChars) * 100)}% of what you typed` : ''}`,
      },
      {
        label: 'Word deletes',
        value: per(w.wordDeletes),
        sub: `ctrl+w or alt+backspace${w.lineKills ? `, plus ${plural(w.lineKills, 'line')} at once` : ''}`,
      },
      {
        label: 'Pastes',
        value: `${Math.round((w.pastes / w.measured) * 100)}%`,
        sub: [w.pastes ? `of prompts, ${compact(Math.round(w.pasteChars / w.pastes))} chars each` : 'of prompts', attachments(w)]
          .filter(Boolean)
          .join(' · '),
      },
      { label: 'Thinking pauses', value: per(w.pauses), sub: '2 to 30 seconds' },
      { label: 'Breaks', value: per(w.breaks), sub: 'pauses over 30 seconds' },
      { label: 'Longest pause', value: seconds(w.longestPauseMs), sub: `over ${plural(w.measured, 'draft')}` },
      {
        label: 'Typing time',
        value: seconds(w.typingMs / (w.sent + w.abandoned)),
        sub: w.typingMs ? `${Math.round(w.typedChars / 5 / (w.typingMs / MIN))} wpm while typing` : '',
      },
    ]
  }

  const today = dayKey(Date.now())
  const when = (ms: number) => new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  // the times can add up to more than Active: a stretch two projects shared counts in full for each
  const sharedTip = (ms: number) => `<strong>${duration(ms)} active</strong>time two projects shared counts for each`
</script>

<div class="flex flex-col gap-4 md:gap-6">
  <div class="flex flex-wrap items-end justify-between gap-4">
    <div>
      <h1 class="text-2xl font-semibold tracking-tight">Overview</h1>
      <p class="text-sm text-muted-foreground">Time with Claude Code, {period.label}</p>
    </div>
    <div class="flex flex-wrap items-center gap-2">
      <PersonPicker me={who.me} />
      <RangePicker bind:range={range.value} />
    </div>
  </div>

  {#if !s || !ever}
    <div class="grid gap-4 md:max-lg:gap-y-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
      <Skeleton class="h-40 rounded-xl" />
      <Skeleton class="h-40 rounded-xl" />
    </div>
    <Skeleton class="h-64 rounded-xl" />
  {:else}
    <div class="grid gap-4 md:max-lg:gap-y-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
      <Card.Root class="justify-center">
        <Card.Header>
          <Card.Description>Active with Claude</Card.Description>
          <Card.Title class="text-5xl font-semibold tracking-tight tabular-nums">{duration(s.totalMs)}</Card.Title>
        </Card.Header>
        <Card.Content class="text-sm text-muted-foreground">
          {period.label}{s.sessions.length ? `, across ${plural(s.sessions.length, 'session')}` : ''}
        </Card.Content>
      </Card.Root>
      <div class="grid grid-cols-2 gap-4 sm:grid-cols-3">
        {#each tiles(s) as tile (tile.label)}
          <Stat {...tile} />
        {/each}
      </div>
    </div>

    {#if !s.sessions.length}
      <Card.Root>
        <Card.Content class="py-10 text-center text-sm text-muted-foreground">Nothing logged in this range yet</Card.Content>
      </Card.Root>
    {:else}
      <!-- one column per day only makes sense past a single day -->
      {#if s.days.length > 1}
        <Card.Root>
          <Card.Header>
            <Card.Title>Active time per day</Card.Title>
            <Legend {colors} projects={s.projects.map(p => p.project)} />
          </Card.Header>
          <Card.Content>
            <Columns
              labels={s.days.map(d => (d.day === today ? 'today' : shortDay(d.day)))}
              series={series(
                colors,
                s.days.map(d => d.projects),
              )}
              tips={s.days.map(
                d => `<strong>${longDay(d.day)}</strong>${duration(d.ms)} active · ${plural(d.prompts, 'prompt')}${tipLines(colors, d.projects)}`,
              )}
            />
          </Card.Content>
        </Card.Root>
      {/if}

      <div class="grid gap-4 md:grid-cols-2">
        <Card.Root>
          <Card.Header><Card.Title>Projects</Card.Title></Card.Header>
          <Card.Content>
            <BarList
              items={s.projects.map(p => ({
                name: p.project,
                value: p.ms,
                amount: duration(p.ms),
                color: colors.color(p.project),
                tip: `<strong>${esc(p.project)}</strong>${duration(p.ms)} · ${Math.round((p.ms / s.totalMs) * 100)}%`,
              }))}
            />
          </Card.Content>
        </Card.Root>
        <Card.Root>
          <Card.Header>
            <Card.Title>Languages</Card.Title>
            <Card.Description>By files changed</Card.Description>
          </Card.Header>
          <Card.Content>
            {@const edits = s.languages.reduce((sum, l) => sum + l.edits, 0)}
            <BarList
              limit={8}
              items={s.languages.map(l => ({
                name: l.language,
                value: l.edits,
                amount: String(l.edits),
                tip: `<strong>${esc(l.language)}</strong>${plural(l.edits, 'file change')} · ${Math.round((l.edits / edits) * 100)}%`,
              }))}
            />
          </Card.Content>
        </Card.Root>
      </div>

      <div class="grid gap-4 md:grid-cols-2">
        <Card.Root>
          <Card.Header>
            <Card.Title>Time of day</Card.Title>
            <Legend {colors} projects={s.projects.map(p => p.project)} />
          </Card.Header>
          <!-- as tall as the card beside it -->
          <Card.Content class="flex flex-1 flex-col">
            <Columns
              fill
              labels={s.hours.map((_, h) => hourLabel(h))}
              series={series(colors, s.hourProjects)}
              tips={s.hours.map((ms, h) => `<strong>${hourLabel(h)}</strong>${duration(ms)} active${tipLines(colors, s.hourProjects[h]!)}`)}
            />
          </Card.Content>
        </Card.Root>
        {#if s.writing.measured}
          <Card.Root>
            <Card.Header>
              <Card.Title>How you write</Card.Title>
              <Card.Description>Per prompt, sent or not</Card.Description>
            </Card.Header>
            <Card.Content class="grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-3">
              {#each writingStats(s.writing) as stat (stat.label)}
                <div>
                  <div class="text-xs text-muted-foreground">{stat.label}</div>
                  <div class="text-xl font-semibold tabular-nums">{stat.value}</div>
                  <div class="text-xs text-muted-foreground">{stat.sub}</div>
                </div>
              {/each}
            </Card.Content>
          </Card.Root>
        {/if}
      </div>

      <Card.Root>
        <Card.Header>
          <Card.Title>Every day</Card.Title>
          <Card.Description>All time, whatever the range</Card.Description>
          <Card.Action class="flex items-center gap-1 text-xs text-muted-foreground">
            less
            {#each HEAT_LABELS as label, k (label)}
              <span class="size-2.5 rounded-[3px]" title={label} style:background="var(--heat-{k + 1})"></span>
            {/each}
            more
          </Card.Action>
        </Card.Header>
        <Card.Content>
          <Calendar {colors} days={ever.days} />
        </Card.Content>
      </Card.Root>

      <Card.Root>
        <Card.Header><Card.Title>Tools</Card.Title></Card.Header>
        <Card.Content>
          <BarList
            limit={12}
            columns={2}
            items={s.tools.map(t => ({
              name: toolName(t.tool),
              value: t.calls,
              amount: compact(t.calls),
              tip: `<strong>${esc(toolName(t.tool))}</strong>${t.calls} calls · avg ${t.avgMs < 1000 ? `${Math.round(t.avgMs)}ms` : `${(t.avgMs / 1000).toFixed(1)}s`}<span class="muted">${t.errors} errors · ${t.denied} denied</span>`,
            }))}
          />
        </Card.Content>
      </Card.Root>
      {#if modesSeen || modelsSeen}
        <!-- side by side, or one across the width when only one has anything -->
        <div class={['grid gap-4', modesSeen && modelsSeen && 'md:grid-cols-2']}>
          {#if modesSeen}
            <Card.Root>
              <Card.Header>
                <Card.Title>Permission modes</Card.Title>
                <Card.Description>Active time in each</Card.Description>
              </Card.Header>
              <Card.Content>
                <BarList
                  items={s.modes.map(m => ({
                    name: modeName(m.mode),
                    value: m.ms,
                    amount: duration(m.ms),
                    color: m.mode === 'unknown' ? 'var(--muted-foreground)' : undefined,
                    tip: `<strong>${esc(modeName(m.mode))}</strong>${duration(m.ms)} · ${Math.round((m.ms / s.totalMs) * 100)}%${m.mode === 'unknown' ? '<span class="muted">sessions where the mod could not see the mode</span>' : ''}`,
                  }))}
                />
              </Card.Content>
            </Card.Root>
          {/if}
          {#if modelsSeen}
            <Card.Root>
              <Card.Header>
                <Card.Title>Models</Card.Title>
                <Card.Description>Claude's working time with each</Card.Description>
              </Card.Header>
              <Card.Content>
                <BarList
                  items={s.models.map(m => ({
                    name: modelName(m.model),
                    value: m.ms,
                    amount: duration(m.ms),
                    tip: `<strong>${esc(modelName(m.model))}</strong>${duration(m.ms)} · ${m.turns} ${m.turns === 1 ? 'turn' : 'turns'}<span class="muted">${esc(m.model)}</span>`,
                  }))}
                />
              </Card.Content>
            </Card.Root>
          {/if}
        </div>
      {/if}

      <Card.Root>
        <Card.Header>
          <Card.Title>Sessions</Card.Title>
          <Card.Description>Newest first</Card.Description>
        </Card.Header>
        <Card.Content>
          <Table.Root>
            <Table.Header>
              <Table.Row>
                <Table.Head>Started</Table.Head>
                <Table.Head>Projects</Table.Head>
                <Table.Head class="text-right">Active</Table.Head>
                <Table.Head class="text-right">Prompts</Table.Head>
                <Table.Head>Session</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              <!-- a session with no active time in range keeps its home project -->
              {#each s.sessions.slice(sessionPage * SESSIONS, (sessionPage + 1) * SESSIONS) as x (x.sessionId)}
                <Table.Row>
                  <Table.Cell>
                    <a class="font-medium underline-offset-4 hover:underline" href={withPerson(`/session?id=${encodeURIComponent(x.sessionId)}`)}
                      >{when(x.start)}</a
                    >
                  </Table.Cell>
                  <Table.Cell
                    class="whitespace-normal"
                    onmousemove={x.projects.length > 1 ? (e: MouseEvent) => showTip(e, sharedTip(x.activeMs)) : undefined}
                    onmouseleave={x.projects.length > 1 ? hideTip : undefined}
                  >
                    <div class="flex flex-wrap gap-1">
                      {#each x.projects.length ? x.projects : [{ project: x.project, ms: 0 }] as p (p.project)}
                        <ProjectChip {colors} project={p.project} ms={p.ms} />
                      {/each}
                    </div>
                  </Table.Cell>
                  <Table.Cell class="text-right tabular-nums">{duration(x.activeMs)}</Table.Cell>
                  <Table.Cell class="text-right tabular-nums">{x.prompts}</Table.Cell>
                  <Table.Cell class="font-mono text-xs text-muted-foreground">{x.sessionId.slice(0, 8)}</Table.Cell>
                </Table.Row>
              {/each}
            </Table.Body>
          </Table.Root>
          <Pager bind:page={() => sessionPage, turnTo} count={s.sessions.length} size={SESSIONS} back="Newer sessions" on="Older sessions" />
        </Card.Content>
      </Card.Root>
    {/if}
  {/if}
</div>
