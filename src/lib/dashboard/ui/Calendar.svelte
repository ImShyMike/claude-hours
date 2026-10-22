<script lang="ts">
  import type { Summary } from '../../analytics/aggregate'
  import { calendar } from '../charts'
  import { themeTick } from '../live.svelte'
  import { heatCells } from '../overview'
  import type { Palette } from '../shared'

  let { colors, days }: { colors: Palette; days: Summary['days'] } = $props()
  let el: HTMLDivElement
  let width = $state(0)

  // as many weeks as the width holds, so it's drawn again when that changes
  $effect(() => {
    themeTick()
    if (!width) return
    const { weeks, months, cells } = heatCells(width, colors, days)
    const chart = calendar(el, weeks, months, cells)
    return () => chart.destroy()
  })
</script>

<div bind:clientWidth={width}><div bind:this={el}></div></div>
