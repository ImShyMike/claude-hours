<script lang="ts">
  import '#lib/dashboard/style.css'
  import type { LayoutProps } from './$types'

  let { children }: LayoutProps = $props()
</script>

<!-- the session page runs its script once per load, and its CSS mustn't follow
     a client-side navigation back into the shadcn pages, so its links reload -->
<div data-sveltekit-reload style="display: contents">
  {@render children()}
</div>
<div class="tooltip" id="tooltip" hidden></div>
