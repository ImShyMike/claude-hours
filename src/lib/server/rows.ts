// A row's fields, split between a table's typed columns and its extra jsonb,
// and joined back. A field goes in its column when the table has one and the
// value fits the column's type; anything else (an unknown field, a null, a
// string where a number goes) goes in extra. So joinRow(splitRow(row)) is
// always the row the mod wrote
import { getTableColumns, type Table } from 'drizzle-orm'

// columns every row table has that aren't the row's own fields
const BOOKKEEPING = new Set(['runId', 'n', 'extra'])

function fits(columnType: string, value: unknown) {
  switch (columnType) {
    case 'PgText':
      // Postgres text can't hold a NUL
      return typeof value === 'string' && !value.includes('\0')
    case 'PgInteger':
      return Number.isInteger(value) && Math.abs(value as number) <= 2 ** 31 - 1
    case 'PgBigInt53':
      return Number.isSafeInteger(value)
    case 'PgBoolean':
      return typeof value === 'boolean'
    case 'PgJsonb':
      return value !== null && value !== undefined
    default:
      return false
  }
}

export type Row = Record<string, unknown>

// `implied` fields aren't stored at all (the table says them, like `event`)
export function splitRow(table: Table, row: Row, implied: string[] = []) {
  const columns = getTableColumns(table)
  const values: Row = {}
  const extra: Row = {}
  for (const [key, value] of Object.entries(row)) {
    if (implied.includes(key)) continue
    const column = columns[key]
    if (column && !BOOKKEEPING.has(key) && fits(column.columnType, value)) values[key] = value
    else extra[key] = value
  }
  return { ...values, extra: Object.keys(extra).length ? extra : null }
}

export function joinRow(table: Table, stored: Row, implied: Row = {}): Row {
  const row: Row = { ...implied }
  for (const key of Object.keys(getTableColumns(table))) {
    if (!BOOKKEEPING.has(key) && stored[key] !== null && stored[key] !== undefined) row[key] = stored[key]
  }
  return { ...row, ...(stored.extra as Row | null) }
}
