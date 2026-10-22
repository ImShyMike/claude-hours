<script lang="ts">
  // the old dashboard's links, plus the hub's own pages; data-own keeps those
  // out of the ?person= an admin carries from dashboard page to page
  let { current, admin = false }: { current?: 'overview' | 'timeline'; admin?: boolean } = $props()
</script>

<nav class="nav">
  <a href="/" aria-current={current === 'overview' ? 'page' : undefined}>Overview</a>
  <a href="/timeline" aria-current={current === 'timeline' ? 'page' : undefined}>Timeline</a>
  <a href="/settings" data-own>Settings</a>
  {#if admin}<a href="/admin" data-own>Admin</a>{/if}
</nav>
