<script lang="ts">
  import type { Shape } from '../../session'
  import { hideTip, showTip } from '../../shared'

  let { shapes }: { shapes: Shape[] } = $props()
  const tip = (s: Shape) => (s.tip ? (e: MouseEvent) => showTip(e, s.tip!) : undefined)
</script>

{#each shapes as s, i (i)}
  {#if s.kind === 'rect'}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <rect
      class={s.class}
      x={s.x}
      y={s.y}
      width={s.width}
      height={s.height}
      rx={s.rx}
      onmousemove={tip(s)}
      onmouseleave={s.tip ? hideTip : undefined}
    />
  {:else if s.kind === 'line'}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <line class={s.class} x1={s.x1} x2={s.x2} y1={s.y1} y2={s.y2} onmousemove={tip(s)} onmouseleave={s.tip ? hideTip : undefined} />
  {:else}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <text
      class={['text-[11px] tabular-nums', s.class]}
      x={s.x}
      y={s.y}
      text-anchor="middle"
      onmousemove={tip(s)}
      onmouseleave={s.tip ? hideTip : undefined}>{s.text}</text
    >
  {/if}
{/each}
