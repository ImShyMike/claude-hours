<script lang="ts">
  import '#lib/dashboard/style.css'
  import type { LayoutProps } from './$types'

  let { children }: LayoutProps = $props()
</script>

{@render children()}
<div class="tooltip" id="tooltip" hidden></div>
