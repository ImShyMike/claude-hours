<script lang="ts">
  import { stackedColumns, type Series } from '../charts'
  import { themeTick } from '../live.svelte'

  let { labels, series, tips, maxTicks = 8 }: { labels: string[]; series: Series[]; tips: string[]; maxTicks?: number } = $props()
  let el: HTMLDivElement

  $effect(() => {
    themeTick()
    const chart = stackedColumns(el, labels, series, tips, maxTicks)
    return () => chart.destroy()
  })
</script>

<div bind:this={el}></div>
