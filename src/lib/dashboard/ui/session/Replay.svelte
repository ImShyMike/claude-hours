<script lang="ts">
  import { untrack } from 'svelte'
  import ChevronsLeftIcon from '@lucide/svelte/icons/chevrons-left'
  import ChevronsRightIcon from '@lucide/svelte/icons/chevrons-right'
  import PauseIcon from '@lucide/svelte/icons/pause'
  import PlayIcon from '@lucide/svelte/icons/play'
  import { countGroups, durationOf, squash } from '#lib/analytics/replay.js'
  import { Button } from '#lib/components/ui/button/index.js'
  import * as Card from '#lib/components/ui/card/index.js'
  import { Checkbox } from '#lib/components/ui/checkbox/index.js'
  import { Label } from '#lib/components/ui/label/index.js'
  import * as Select from '#lib/components/ui/select/index.js'
  import { KINDS_LEGEND, STRIP_PAD, boxHtml, draftStats, replayer, strip, type Draft } from '../../session'
  import { clockTime, seconds } from '../../shared'
  import Shapes from './Shapes.svelte'

  // keyed by the draft outside, so a new draft starts a fresh player; a
  // refresh of the same draft doesn't touch it. Playing, the speed and
  // squashing can live outside too, so they carry on into the next draft
  // (Play all), and onend says the replay ran to its end
  let {
    draft,
    card = $bindable(),
    playing = $bindable(false),
    speed = $bindable('1'),
    squashed = $bindable(true),
    onend,
  }: { draft: Draft; card?: HTMLElement; playing?: boolean; speed?: string; squashed?: boolean; onend?: () => void } = $props()
  const d = untrack(() => draft)
  const tl = d.timeline
  const replay = tl && replayer(tl)
  // edits as the drafts table counts them, then the cursor moves
  const edits = typeof d.line.edits === 'number' ? d.line.edits : 0
  const moves = tl ? countGroups(tl).move : 0
  const SPEEDS = ['1', '2', '5', '20']

  // squashed: pauses cut to 1.5 s, so a replay doesn't sit through a tea break
  // where the replay is, in replay time (the squashed clock)
  let playMs = $state(0)
  let stripW = $state(0)

  const clock = $derived(tl ? squash(tl, squashed ? 1_500 : Infinity) : { length: 0, toPlay: (ms: number) => ms, toReal: (ms: number) => ms })
  const real = $derived(clock.toReal(playMs))
  // the strip only redraws when the clock or the width changes, never per frame
  const drawnStrip = $derived(tl && strip(tl, clock, stripW))
  const box = $derived(tl && replay && boxHtml(tl, replay(real), real))
  const playheadX = $derived(drawnStrip ? STRIP_PAD + (playMs / Math.max(clock.length, 1)) * (drawnStrip.width - STRIP_PAD * 2) : 0)

  const seek = (play: number) => (playMs = Math.max(0, Math.min(play, clock.length)))

  function setPlaying(on: boolean) {
    if (on && playMs >= clock.length) playMs = 0
    playing = on
  }

  // keeps the same real moment under the playhead when the clock changes
  function setSquashed(on: boolean) {
    const at = real
    squashed = on
    playMs = clock.toPlay(at)
  }

  function jump(dir: 1 | -1) {
    if (!tl) return
    const times = tl.steps.map(st => st[0])
    const target = dir > 0 ? times.find(t => t > real + 0.5) : [...times].reverse().find(t => t < real - 0.5)
    seek(clock.toPlay(target ?? (dir > 0 ? durationOf(tl) : 0)))
  }

  // one frame at a time while playing, stopped on pause or when the page goes;
  // played again from the end, it starts over
  $effect(() => {
    if (!playing) return
    untrack(() => playMs >= clock.length && (playMs = 0))
    let last = performance.now()
    let frame = requestAnimationFrame(function step(now) {
      playMs += (now - last) * Number(speed)
      last = now
      if (playMs >= clock.length) {
        playMs = clock.length
        playing = false
        onend?.()
        return
      }
      frame = requestAnimationFrame(step)
    })
    return () => cancelAnimationFrame(frame)
  })

  // space plays, the arrows step an edit; a focused field, or a button or
  // checkbox that space would press, keeps its own keys
  function onkeydown(e: KeyboardEvent) {
    if (!tl || !(e.target instanceof Element)) return
    if (e.target.closest('input, select, textarea, [contenteditable], [role=listbox], [role=option], [role=slider]')) return
    if (e.key === ' ') {
      if (e.target.closest('button, a, [role=checkbox], [role=button]')) return
      e.preventDefault()
      setPlaying(!playing)
    } else if (e.key === 'ArrowLeft') jump(-1)
    else if (e.key === 'ArrowRight') jump(1)
  }

  function onStripClick(e: MouseEvent & { currentTarget: SVGSVGElement }) {
    const rect = e.currentTarget.getBoundingClientRect()
    const frac = (e.clientX - rect.left - STRIP_PAD) / (rect.width - STRIP_PAD * 2)
    seek(Math.max(0, Math.min(1, frac)) * clock.length)
  }
</script>

<svelte:window {onkeydown} />

<div bind:this={card} class="scroll-mt-4">
  <Card.Root>
    <Card.Header>
      <Card.Title>{d.outcome === 'sent' ? 'Prompt' : 'Abandoned draft'} from {clockTime(d.start)}</Card.Title>
      <Card.Description>
        {!tl
          ? 'Logged before replays existed, so stats only'
          : tl.truncated
            ? 'A very long draft: the replay stops where the recording did'
            : `${edits} edits${moves ? `, ${moves} cursor moves` : ''}`}
      </Card.Description>
    </Card.Header>
    <Card.Content class="flex flex-col gap-4">
      {#if tl && box && drawnStrip}
        <div
          class="max-h-80 min-h-24 overflow-y-auto rounded-lg border bg-background px-3.5 py-3 text-[0px] leading-[18px]"
          aria-label="The prompt box, as shapes"
        >
          {@html box.html}
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="icon-sm" aria-label="Previous edit" title="Previous edit (←)" onclick={() => jump(-1)}
            ><ChevronsLeftIcon /></Button
          >
          <Button size="sm" class="w-20" onclick={() => setPlaying(!playing)} title="Play or pause (space)">
            {#if playing}<PauseIcon /> Pause{:else}<PlayIcon /> Play{/if}
          </Button>
          <Button variant="outline" size="icon-sm" aria-label="Next edit" title="Next edit (→)" onclick={() => jump(1)}><ChevronsRightIcon /></Button>
          <input
            type="range"
            class="min-w-32 flex-[1_1_12rem] accent-primary"
            min="0"
            max="1000"
            aria-label="Position in the draft"
            value={clock.length ? Math.round((playMs / clock.length) * 1000) : 0}
            oninput={e => {
              playing = false
              seek((Number(e.currentTarget.value) / 1000) * clock.length)
            }}
          />
          <span class="min-w-24 text-sm text-muted-foreground tabular-nums">{seconds(real)} / {seconds(durationOf(tl))}</span>
          <Select.Root type="single" bind:value={speed}>
            <Select.Trigger size="sm" aria-label="Speed">{speed}×</Select.Trigger>
            <Select.Content>
              {#each SPEEDS as s (s)}
                <Select.Item value={s} label="{s}×">{s}×</Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
          <div class="flex items-center gap-2">
            <Checkbox id="squash" bind:checked={() => squashed, setSquashed} />
            <Label for="squash" class="font-normal text-muted-foreground">Squash pauses</Label>
          </div>
        </div>
        <p class="text-sm text-muted-foreground">{box.step}</p>
        <div class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {#each KINDS_LEGEND as [swatch, label] (label)}
            <span class="inline-flex items-center gap-1.5"><span class={['inline-block size-2.5 shrink-0 rounded-sm', swatch]}></span>{label}</span>
          {/each}
        </div>
        <div class="overflow-x-auto" bind:clientWidth={stripW}>
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
          <svg
            class="block cursor-pointer overflow-visible"
            viewBox="0 0 {drawnStrip.width} {drawnStrip.height}"
            width={drawnStrip.width}
            height={drawnStrip.height}
            role="img"
            aria-label="Every edit over time: typing above the line, deleting below"
            onclick={onStripClick}
          >
            <Shapes shapes={drawnStrip.shapes} />
            <line class="stroke-foreground stroke-[1.5]" x1={playheadX} x2={playheadX} y1="2" y2={drawnStrip.height - 2} />
          </svg>
        </div>
      {/if}
      <div class="grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-3 lg:grid-cols-6">
        {#each draftStats(d) as stat (stat.label)}
          <div>
            <div class="text-xs text-muted-foreground">{stat.label}</div>
            <div class="text-xl font-semibold tabular-nums">{stat.value}</div>
            <div class="text-xs text-muted-foreground">{stat.sub}</div>
          </div>
        {/each}
      </div>
    </Card.Content>
  </Card.Root>
</div>
