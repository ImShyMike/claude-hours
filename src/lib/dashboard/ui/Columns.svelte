<script lang="ts">
  import { stackedColumns, type Series } from '../charts'
  import { themeTick } from '../live.svelte'

  // fill: stretch to the height the layout gives it (200px at least)
  let {
    labels,
    series,
    tips,
    maxTicks = 8,
    fill = false,
  }: { labels: string[]; series: Series[]; tips: string[]; maxTicks?: number; fill?: boolean } = $props()
  let el: HTMLDivElement

  $effect(() => {
    themeTick()
    const chart = stackedColumns(el, labels, series, tips, maxTicks, fill)
    return () => chart.destroy()
  })
</script>

<div bind:this={el} class={fill ? 'relative min-h-50 flex-1' : undefined}></div>
