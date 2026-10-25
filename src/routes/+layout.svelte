<script lang="ts">
  import favicon from '#lib/assets/favicon.svg'
  import type { LayoutProps } from './$types'

  // no styles here: the dashboard pages bring the old dashboard's, the rest
  // Tailwind's, and every link is a whole page load, so they never meet
  let { children }: LayoutProps = $props()
</script>

<svelte:head>
  <link rel="icon" href={favicon} />
  <title>claude-hours</title>
  <meta name="description" content="Detailed Claude Code time tracking: where your hours with Claude went, day by day and project by project" />
</svelte:head>

{@render children()}
