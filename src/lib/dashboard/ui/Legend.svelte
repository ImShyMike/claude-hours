<script lang="ts">
  import type { Palette } from '../shared'
  import Swatch from './Swatch.svelte'

  // the projects in view, in palette order with Other last
  let { colors, projects }: { colors: Palette; projects: string[] } = $props()
  const shown = $derived(new Set(projects.map(colors.group)))
</script>

<div class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
  {#each colors.order.filter(p => shown.has(p)) as project (project)}
    <span class="inline-flex items-center gap-1.5"><Swatch color={colors.color(project)} />{project}</span>
  {/each}
</div>
