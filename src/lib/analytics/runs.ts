// A session's files as the sync protocol sees them (docs/how-it-works.md): the
// events stream is a list of runs, each from a header to the next, keyed by
// the header's start; the drafts stream is one run. A row is its index in its
// run. The mod keeps its own copy of this, since it can't import
export type Run = { start: number; header: Record<string, unknown>; rows: unknown[] }

const isHeader = (row: unknown): row is Record<string, unknown> & { start: number } =>
  !!row &&
  typeof row === 'object' &&
  (row as Record<string, unknown>).event === 'session' &&
  Number.isSafeInteger((row as Record<string, unknown>).start)

// Whole lines only: a last line with no newline is still being written. A
// line that isn't JSON stays a string, so it keeps its place (the hub
// quarantines it)
export function rowsOf(text: string): unknown[] {
  const lines = text.split('\n')
  lines.pop()
  return lines.map(line => {
    try {
      return JSON.parse(line)
    } catch {
      return line
    }
  })
}

// Rows before the first header belong to no run and are dropped
export function splitRuns(text: string): Run[] {
  const runs: Run[] = []
  for (const row of rowsOf(text)) {
    if (isHeader(row)) runs.push({ start: row.start, header: row, rows: [] })
    else runs.at(-1)?.rows.push(row)
  }
  return runs
}
