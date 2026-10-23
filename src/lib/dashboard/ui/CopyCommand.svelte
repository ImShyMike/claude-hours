<script lang="ts">
  import CheckIcon from '@lucide/svelte/icons/check'
  import CopyIcon from '@lucide/svelte/icons/copy'
  import { Button } from '#lib/components/ui/button/index.js'

  // A command to paste somewhere else, with a button that copies it
  let { command }: { command: string } = $props()

  let copied = $state(false)
  let reset: ReturnType<typeof setTimeout> | undefined

  async function copy() {
    await navigator.clipboard.writeText(command)
    copied = true
    clearTimeout(reset)
    reset = setTimeout(() => (copied = false), 1500)
  }

  $effect(() => () => clearTimeout(reset))
</script>

<div class="flex items-center gap-2 rounded-md border bg-muted/50 py-1 pr-1 pl-3">
  <code class="min-w-0 flex-1 overflow-x-auto font-mono text-sm whitespace-nowrap">{command}</code>
  <Button variant="ghost" size="icon-sm" aria-label={copied ? 'Copied' : 'Copy'} onclick={copy}>
    {#if copied}<CheckIcon />{:else}<CopyIcon />{/if}
  </Button>
</div>
