<script lang="ts">
  import { onMount } from 'svelte'
  import Nav from '#lib/dashboard/Nav.svelte'
  import type { PageProps } from './$types'

  let { data }: PageProps = $props()

  onMount(() => {
    import('#lib/dashboard/timeline.js')
  })
</script>

<svelte:head><title>claude-hours timeline</title></svelte:head>

<main class="wide">
  <header>
    <div>
      <h1>claude-hours</h1>
      <Nav current="timeline" admin={data.admin} />
    </div>
    <div class="controls">
      <div class="segmented" role="group" aria-label="Range">
        <button data-range="today">Today</button>
        <button data-range="7">7 days</button>
        <button data-range="30">30 days</button>
        <button data-range="all">All</button>
      </div>
    </div>
  </header>

  <p class="empty muted" id="empty" hidden>nothing logged in this range yet</p>

  <section class="card" id="content" hidden>
    <div class="card-head">
      <h2>Every session <span class="muted">a row per day, click a bar to open it</span></h2>
      <div class="zoom" role="group" aria-label="Zoom">
        <label class="muted"><input type="checkbox" id="fit" /> fit to active hours</label>
        <button id="zoom-out" aria-label="Zoom out" title="Zoom out (or ctrl + scroll)">&minus;</button>
        <button id="zoom-in" aria-label="Zoom in" title="Zoom in (or ctrl + scroll)">+</button>
      </div>
    </div>
    <div class="legend" id="legend"></div>
    <div class="tl-scroll" id="scroll"><div class="tl" id="timeline"></div></div>
    <p class="muted tl-note">a thin bar under a session is a subagent working in another repo at the same time</p>
  </section>
</main>
