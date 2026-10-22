// A fixed window counter per key, in memory. Fine while the hub is one
// process; it needs to move into Postgres once there's more than one
export function rateLimiter(limit: number, windowMs: number) {
  const windows = new Map<string, { count: number; resetAt: number }>()
  return (key: string, now = Date.now()) => {
    if (windows.size > 10_000) for (const [k, w] of windows) if (w.resetAt <= now) windows.delete(k)
    let w = windows.get(key)
    if (!w || w.resetAt <= now) windows.set(key, (w = { count: 0, resetAt: now + windowMs }))
    return ++w.count <= limit
  }
}
