<script lang="ts" module>
  export type BarItem = { name: string; value: number; amount: string; tip: string; color?: string }
</script>

<script lang="ts">
  import { hideTip, showTip } from '../shared'

  // the top items as bars against the biggest; two columns read top to
  // bottom, then over
  let { items, limit = 10, columns = 1 }: { items: BarItem[]; limit?: number; columns?: 1 | 2 } = $props()
  const shown = $derived(items.slice(0, limit))
  const max = $derived(Math.max(...items.map(i => i.value), 1))
</script>

{#if !items.length}
  <p class="text-sm text-muted-foreground">Nothing yet</p>
{:else}
  <div
    class={['grid gap-x-8 gap-y-2', columns === 2 && 'md:grid-flow-col md:grid-cols-2']}
    style:grid-template-rows={columns === 2 ? `repeat(${Math.ceil(shown.length / 2)}, auto)` : undefined}
  >
    {#each shown as item, i (i)}
      <div
        class="grid grid-cols-[minmax(0,10rem)_1fr_auto] items-center gap-3 text-sm"
        role="presentation"
        onmousemove={e => showTip(e, item.tip)}
        onmouseleave={hideTip}
      >
        <span class="truncate" title={item.name}>{item.name}</span>
        <span class="h-2 rounded-full bg-muted">
          <span
            class={['block h-full min-w-0.5 rounded-full', !item.color && 'bg-primary']}
            style:width="{(item.value / max) * 100}%"
            style:background={item.color}
          ></span>
        </span>
        <span class="text-right text-muted-foreground tabular-nums">{item.amount}</span>
      </div>
    {/each}
  </div>
  {#if items.length > limit}
    <p class="mt-3 text-xs text-muted-foreground">+ {items.length - limit} more</p>
  {/if}
{/if}
