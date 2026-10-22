<script lang="ts">
  import * as Card from '#lib/components/ui/card/index.js'

  let { label, value, sub = '' }: { label: string; value: string; sub?: string } = $props()
</script>

<Card.Root size="sm" class="gap-1">
  <Card.Header>
    <Card.Description class="truncate">{label}</Card.Description>
    <div class="text-2xl font-semibold tabular-nums">{value}</div>
  </Card.Header>
  {#if sub}<Card.Content class="text-xs text-muted-foreground">{sub}</Card.Content>{/if}
</Card.Root>
