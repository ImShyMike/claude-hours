<script lang="ts">
  import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left'
  import ChevronRightIcon from '@lucide/svelte/icons/chevron-right'
  import { Button } from '#lib/components/ui/button/index.js'

  // Under a long table: which rows are showing, and a page back or on.
  // Nothing at all while everything fits on one page
  let {
    page = $bindable(0),
    count,
    size,
    back,
    on,
  }: {
    page: number
    count: number
    size: number
    // what the buttons lead to, for screen readers ("Earlier drafts")
    back: string
    on: string
  } = $props()

  const pages = $derived(Math.max(1, Math.ceil(count / size)))
</script>

{#if pages > 1}
  <div class="mt-3 flex items-center justify-end gap-2 text-sm text-muted-foreground">
    <span class="tabular-nums">{page * size + 1} to {Math.min(count, (page + 1) * size)} of {count}</span>
    <Button variant="outline" size="icon-sm" aria-label={back} disabled={page === 0} onclick={() => (page = page - 1)}>
      <ChevronLeftIcon />
    </Button>
    <Button variant="outline" size="icon-sm" aria-label={on} disabled={page >= pages - 1} onclick={() => (page = page + 1)}>
      <ChevronRightIcon />
    </Button>
  </div>
{/if}
