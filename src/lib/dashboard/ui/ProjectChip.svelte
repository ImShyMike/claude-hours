<script lang="ts">
  import { Badge } from '#lib/components/ui/badge/index.js'
  import { duration, type Palette } from '../shared'
  import Swatch from './Swatch.svelte'

  // with ms, its time after the name: terra 1h 02m
  let { colors, project, ms }: { colors: Palette; project: string; ms?: number } = $props()
</script>

<Badge variant="outline" class="gap-1.5 font-normal">
  <Swatch color={colors.color(project)} />{project}
  {#if ms}<span class="text-muted-foreground">{duration(ms)}</span>{/if}
</Badge>
