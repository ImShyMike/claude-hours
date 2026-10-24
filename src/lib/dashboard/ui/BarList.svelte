<script lang="ts" module>
  // part: how much of value to draw solid, the rest of the bar paler
  export type BarItem = { name: string; value: number; amount: string; tip: string; color?: string; part?: number }
</script>

<script lang="ts">
  import { hideTip, showTip } from '../shared'

  // the top items as bars against the biggest, the rest a click away; two
  // columns read top to bottom, then over
  let { items, limit = 10, columns = 1 }: { items: BarItem[]; limit?: number; columns?: 1 | 2 } = $props()
  let all = $state(false)
  const shown = $derived(all ? items : items.slice(0, limit))
  const max = $derived(Math.max(...items.map(i => i.value), 1))
</script>

{#if !items.length}
  <p class="text-sm text-muted-foreground">Nothing yet</p>
{:else}
  <!-- the rows share the list's columns, so the amounts take the widest one's
       room and every bar in the list starts and ends level -->
  <div
    class={[
      'grid grid-cols-[minmax(0,10rem)_1fr_auto] gap-x-8 gap-y-2',
      columns === 2 && 'md:grid-flow-col md:grid-cols-[minmax(0,10rem)_1fr_auto_minmax(0,10rem)_1fr_auto]',
    ]}
    style:grid-template-rows={columns === 2 ? `repeat(${Math.ceil(shown.length / 2)}, auto)` : undefined}
  >
    {#each shown as item, i (i)}
      <div
        class="col-span-3 grid grid-cols-subgrid items-center gap-x-3 text-sm"
        role="presentation"
        onmousemove={e => showTip(e, item.tip)}
        onmouseleave={hideTip}
      >
        <span class="truncate" title={item.name}>{item.name}</span>
        <span class="h-2 rounded-full bg-muted">
          <span
            class={['block h-full min-w-0.5 overflow-hidden rounded-full', !item.color && 'bg-primary', item.part !== undefined && 'bg-primary/35']}
            style:width="{(item.value / max) * 100}%"
            style:background={item.color}
          >
            {#if item.part !== undefined}
              <span class="block h-full bg-primary" style:width="{(item.part / Math.max(item.value, 1)) * 100}%"></span>
            {/if}
          </span>
        </span>
        <span class="text-right text-muted-foreground tabular-nums">{item.amount}</span>
      </div>
    {/each}
  </div>
  {#if items.length > limit}
    <button
      class="mt-3 self-start text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
      onclick={() => (all = !all)}
    >
      {all ? 'Show fewer' : `+ ${items.length - limit} more`}
    </button>
  {/if}
{/if}
