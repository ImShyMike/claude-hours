// The overview's sums turned into what its charts and tooltips show
import { dayKey, type Summary } from '../analytics/aggregate'
import type { Cell, Series } from './charts'
import { MIN, duration, esc, type Palette } from './shared'

// mcp__helium-devtools__new_page reads better as "helium-devtools · new_page"
export const toolName = (tool: string) => tool.replace(/^mcp__(.+?)__(.+)$/, '$1 · $2')

// a permission mode as Claude Code's footer names it; one it adds later as is
const MODES: Record<string, string> = {
  default: 'Default',
  acceptEdits: 'Accept edits',
  plan: 'Plan',
  auto: 'Auto',
  dontAsk: "Don't ask",
  bypassPermissions: 'Bypass permissions',
  unknown: 'Not recorded',
}
export const modeName = (mode: string) => MODES[mode] ?? mode

export const shortDay = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
export const longDay = (day: string) =>
  new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
export const hourLabel = (h: number) => new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: 'numeric' })

// a day's or hour's split grouped by palette slot
function grouped(colors: Palette, split: Record<string, number>) {
  const out = new Map<string, number>()
  for (const [project, ms] of Object.entries(split)) out.set(colors.group(project), (out.get(colors.group(project)) ?? 0) + ms)
  return out
}

// the same split as tooltip lines, most time first
export function tipLines(colors: Palette, split: Record<string, number>) {
  return [...grouped(colors, split)]
    .sort((a, b) => b[1] - a[1])
    .map(
      ([p, ms]) =>
        `<span class="tip-row"><span class="swatch" style="background:${colors.color(p)}"></span>${esc(p)} <span class="muted">${duration(ms)}</span></span>`,
    )
    .join('')
}

// the columns' splits as one series per project, palette order bottom up
export function series(colors: Palette, splits: Record<string, number>[]): Series[] {
  const groups = splits.map(split => grouped(colors, split))
  return colors.order.filter(p => groups.some(g => g.has(p))).map(p => ({ name: p, color: colors.color(p), values: groups.map(g => g.get(p) ?? 0) }))
}

// how dark a day's cell is: fixed steps, so a cell means the same thing
// whatever else is on the grid
const HEAT_STEPS = [30 * MIN, 60 * MIN, 120 * MIN, 240 * MIN]
const heatLevel = (ms: number) => (ms <= 0 ? 0 : 1 + HEAT_STEPS.filter(step => ms >= step).length)
export const HEAT_LABELS = ['under 30m', '30m to 1h', '1h to 2h', '2h to 4h', '4h or more']

// A GitHub-style grid of days over all time: a column per week (Monday
// first), a year of weeks when they fit at 10px or more, ending this week
export function heatCells(width: number, colors: Palette, days: Summary['days']) {
  const byDay = new Map(days.map(d => [d.day, d]))
  const weeks = Math.max(8, Math.min(53, Math.floor((Math.max(width, 200) - 30) / 13)))
  const start = new Date()
  start.setHours(12, 0, 0, 0)
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7) - (weeks - 1) * 7)
  const today = dayKey(Date.now())
  const months: string[] = []
  const cells: Cell[] = []
  let lastMonth = -1
  for (let week = 0; week < weeks; week++) {
    for (let dow = 0; dow < 7; dow++) {
      const d = new Date(start)
      d.setDate(start.getDate() + week * 7 + dow)
      const day = dayKey(d.getTime())
      if (day > today) continue
      if (dow === 0 && d.getMonth() !== lastMonth) {
        if (lastMonth !== -1 || d.getDate() <= 7) months[week] = d.toLocaleDateString(undefined, { month: 'short' })
        lastMonth = d.getMonth()
      }
      const x = byDay.get(day)
      cells.push({
        week,
        dow,
        level: heatLevel(x?.ms ?? 0),
        today: day === today,
        tip: `<strong>${longDay(day)}</strong>${x?.ms ? `${duration(x.ms)} active${tipLines(colors, x.projects)}` : 'nothing logged'}`,
      })
    }
  }
  return { weeks, months, cells }
}
