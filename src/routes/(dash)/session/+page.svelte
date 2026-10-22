<script lang="ts">
  import { onMount } from 'svelte'

  onMount(() => {
    import('#lib/dashboard/session.js')
  })
</script>

<svelte:head><title>claude-hours session</title></svelte:head>

<main>
  <header>
    <div>
      <p><a href="/" class="back">&larr; claude-hours</a></p>
      <h1 id="title">Session</h1>
      <p class="muted" id="subtitle"></p>
      <p class="session-projects" id="projects"></p>
    </div>
  </header>

  <p class="empty muted" id="empty" hidden>no events for this session</p>

  <div id="content" hidden>
    <section class="card">
      <div class="card-head">
        <h2>Session timeline</h2>
        <div class="zoom" role="group" aria-label="Zoom">
          <label class="muted"><input type="checkbox" id="collapse" /> collapse gaps</label>
          <button id="zoom-out" aria-label="Zoom out" title="Zoom out (or ctrl + scroll)">&minus;</button>
          <button id="zoom-in" aria-label="Zoom in" title="Zoom in (or ctrl + scroll)">+</button>
        </div>
      </div>
      <div class="legend" id="lanes-legend"></div>
      <div class="lanes-wrap">
        <div class="hscroll" id="lanes-scroll"><div class="chart" id="lanes"></div></div>
        <div class="lane-labels" id="lane-labels" aria-hidden="true"></div>
      </div>
    </section>

    <section class="card">
      <h2>Drafts <span class="muted">click one to replay it</span></h2>
      <div class="scroll"><table id="drafts"></table></div>
    </section>

    <section class="card" id="replay-card" hidden>
      <div class="card-head">
        <h2 id="replay-title">Replay</h2>
        <span class="muted" id="replay-note"></span>
      </div>

      <div class="box" id="box" aria-label="The prompt box, as shapes"></div>

      <div class="player">
        <button id="prev" aria-label="Previous edit">&#9664;&#9664;</button>
        <button id="play" class="primary">Play</button>
        <button id="next" aria-label="Next edit">&#9654;&#9654;</button>
        <input type="range" id="scrub" min="0" max="1000" value="0" aria-label="Position in the draft" />
        <span class="time" id="time">0.0s</span>
        <select id="speed" aria-label="Speed">
          <option value="1">1&times;</option>
          <option value="2">2&times;</option>
          <option value="5">5&times;</option>
          <option value="20">20&times;</option>
        </select>
        <label class="muted"><input type="checkbox" id="squash" checked /> squash pauses</label>
      </div>
      <p class="step muted" id="step">&nbsp;</p>

      <div class="legend" id="kinds-legend"></div>
      <div class="hscroll"><div class="chart" id="strip"></div></div>
      <div class="mini" id="draft-stats"></div>
    </section>
  </div>
</main>
