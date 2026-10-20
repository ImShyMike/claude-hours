import { dayKey, summarize, type Event, type Summary } from '../src/aggregate'
import {
  $,
  MIN,
  api,
  chip,
  compact,
  duration,
  esc,
  hideTip,
  load,
  palette,
  projectLegend,
  rangeWindow,
  save,
  seconds,
  showTip,
  withPerson,
  type Me,
  type Palette,
  type Range,
} from './shared'

const REFRESH_MS = 30_000

let range = load<Range>('range', '7')
let idleMin = Number(load('idle', '5'))
// undefined until the first fetch, so nothing claims the log is empty early
let events: Event[] | undefined

// --- charts --------------------------------------------------------------

// clean duration ticks: the smallest step that keeps it to about four lines
const STEPS_MIN = [1, 2, 5, 10, 15, 30, 60, 120, 180, 240, 360, 480, 720, 1440]
function niceStep(maxMs: number) {
  const maxMin = maxMs / MIN
  return (STEPS_MIN.find(step => maxMin / step <= 4) ?? 1440) * MIN
}

const tickLabel = (ms: number) => (ms >= 60 * MIN ? `${ms / (60 * MIN)}h` : `${ms / MIN}m`)

type Column = { label: string; segments: { color: string; value: number }[]; tip: string }

// Columns from a single baseline, each stacked by project bottom up: thin
// bars, a 2px surface gap between segments, a 4px rounded top, hairline grid,
// and a hit target the full width of each band.
const GAP = 2
function columns(el: HTMLElement, data: Column[], labelEvery = 1) {
  // drawn at the measured size so text never scales with the viewBox
  const width = Math.max(el.clientWidth, 200)
  const height = 200
  const pad = { top: 8, right: 4, bottom: 22, left: 40 }
  const plotW = width - pad.left - pad.right
  const plotH = height - pad.top - pad.bottom
  const total = (d: Column) => d.segments.reduce((sum, seg) => sum + seg.value, 0)
  const max = Math.max(...data.map(total), 0)
  const step = niceStep(max || MIN)
  const top = Math.max(step, Math.ceil(max / step) * step)
  const y = (v: number) => pad.top + plotH - (v / top) * plotH
  const band = plotW / Math.max(data.length, 1)
  const barW = Math.max(2, Math.min(24, band * 0.6))

  let svg = ''
  for (let v = 0; v <= top; v += step) {
    svg += `<line class="${v === 0 ? 'baseline' : 'gridline'}" x1="${pad.left}" x2="${width - pad.right}" y1="${y(v)}" y2="${y(v)}"/>`
    svg += `<text x="${pad.left - 6}" y="${y(v) + 4}" text-anchor="end">${tickLabel(v)}</text>`
  }
  data.forEach((d, i) => {
    const cx = pad.left + band * i + band / 2
    if (i % labelEvery === 0) svg += `<text x="${cx}" y="${height - 6}" text-anchor="middle">${esc(d.label)}</text>`
    svg += `<rect class="hit" data-i="${i}" x="${cx - band / 2}" y="${pad.top}" width="${band}" height="${plotH}"/>`
    const x0 = cx - barW / 2
    const x1 = cx + barW / 2
    // segments too thin to see after the gap fold into the one above them
    const segs = d.segments.filter(seg => seg.value > 0)
    let base = y(0)
    let carried = 0
    let bar = ''
    segs.forEach((seg, k) => {
      const h = y(0) - y(seg.value + carried)
      const last = k === segs.length - 1
      if (!last && h < GAP + 1) {
        carried += seg.value
        return
      }
      carried = 0
      const yt = base - h
      if (last) {
        const r = Math.min(4, h, barW / 2)
        bar += `<path fill="${seg.color}" d="M${x0},${base} V${yt + r} Q${x0},${yt} ${x0 + r},${yt} H${x1 - r} Q${x1},${yt} ${x1},${yt + r} V${base} Z"/>`
      } else {
        bar += `<rect fill="${seg.color}" x="${x0}" y="${yt + GAP}" width="${barW}" height="${h - GAP}"/>`
      }
      base = yt
    })
    if (bar) svg += `<g class="bar" data-i="${i}">${bar}</g>`
  })
  el.innerHTML = `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img">${svg}</svg>`

  el.querySelectorAll<SVGRectElement>('.hit').forEach(hit => {
    const i = Number(hit.dataset.i)
    const bar = el.querySelector(`.bar[data-i="${i}"]`)
    hit.addEventListener('mousemove', e => {
      bar?.classList.add('hover')
      showTip(e, data[i]!.tip)
    })
    hit.addEventListener('mouseleave', () => {
      bar?.classList.remove('hover')
      hideTip()
    })
  })
}

// mcp__helium-devtools__new_page reads better as "helium-devtools · new_page"
const toolName = (tool: string) => tool.replace(/^mcp__(.+?)__(.+)$/, '$1 · $2')

type BarItem = { name: string; value: number; amount: string; tip: string; color?: string }

function barList(el: HTMLElement, items: BarItem[], limit = 10) {
  if (!items.length) {
    el.innerHTML = '<p class="muted">nothing yet</p>'
    return
  }
  const max = Math.max(...items.map(i => i.value))
  const shown = items.slice(0, limit)
  el.classList.add('bars')
  // two columns read top to bottom, then over
  el.style.setProperty('--rows', String(Math.ceil(shown.length / 2)))
  el.innerHTML = shown
    .map(
      (item, i) => `<div class="bar-row" data-i="${i}">
        <span class="name" title="${esc(item.name)}">${esc(item.name)}</span>
        <span class="track"><span class="fill" style="display:block;width:${(item.value / max) * 100}%${item.color ? `;background:${item.color}` : ''}"></span></span>
        <span class="amount">${esc(item.amount)}</span>
      </div>`,
    )
    .join('')
  if (items.length > limit) {
    el.insertAdjacentHTML('beforeend', `<p class="muted more" ${el.classList.contains('two') ? ` style="grid-row:${Math.ceil(shown.length / 2) + 1}"` : ''}>+ ${items.length - limit} more</p>`)
  }
  el.querySelectorAll<HTMLElement>('.bar-row').forEach(row => {
    const item = shown[Number(row.dataset.i)]!
    row.addEventListener('mousemove', e => showTip(e, item.tip))
    row.addEventListener('mouseleave', hideTip)
  })
}

// --- render --------------------------------------------------------------

const shortDay = (day: string) =>
  new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
const longDay = (day: string) =>
  new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
const hourLabel = (h: number) => new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: 'numeric' })

function tile(label: string, value: string, sub = '') {
  return `<div class="tile"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`
}

function writingTile(w: Summary['writing']) {
  if (!w.sent && !w.abandoned) return tile('Writing', '-', 'no typing data yet')
  // the usual 5 characters a word, over the time actually typing
  const wpm = w.typingMs ? Math.round(w.typedChars / 5 / (w.typingMs / MIN)) : 0
  const gaveUp = `${w.abandoned} abandoned`
  return tile('Writing', duration(w.typingMs), wpm ? `${gaveUp} · ${wpm} wpm` : gaveUp)
}

function writingCard(w: Summary['writing']) {
  const card = $('writing-card')
  card.hidden = !w.measured
  if (!w.measured) return
  const per = (n: number) => (n / w.measured).toFixed(1)
  const stat = (label: string, value: string, sub: string) =>
    `<div><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`
  $('writing').innerHTML = [
    stat('Typo fixes', per(w.fixes), `${w.fixes} in all, 3 chars or fewer`),
    stat('Rewrites', per(w.rewrites), `${w.rewrites} in all, ${compact(w.rewrittenChars)} chars redone`),
    stat('Thinking pauses', per(w.pauses), '2 to 30 seconds'),
    stat('Breaks', per(w.breaks), 'pauses over 30 seconds'),
    stat('Longest pause', seconds(w.longestPauseMs), `over ${w.measured} draft${w.measured === 1 ? '' : 's'}`),
  ].join('')
}

// a day's or hour's split as stacked segments, palette order bottom up, and
// the same split as tooltip lines, most time first
function stack(colors: Palette, split: Record<string, number>) {
  const grouped = new Map<string, number>()
  for (const [project, ms] of Object.entries(split)) grouped.set(colors.group(project), (grouped.get(colors.group(project)) ?? 0) + ms)
  const segments = colors.order.filter(p => grouped.has(p)).map(p => ({ color: colors.color(p), value: grouped.get(p)! }))
  const lines = [...grouped]
    .sort((a, b) => b[1] - a[1])
    .map(([p, ms]) => `<span class="tip-row"><span class="swatch" style="background:${colors.color(p)}"></span>${esc(p)} <span class="muted">${duration(ms)}</span></span>`)
    .join('')
  return { segments, lines }
}

// how dark a day's cell is: fixed steps, so a cell means the same thing
// whatever else is on the grid
const HEAT_STEPS = [30 * MIN, 60 * MIN, 120 * MIN, 240 * MIN]
const heatLevel = (ms: number) => (ms <= 0 ? 0 : 1 + HEAT_STEPS.filter(step => ms >= step).length)

// A GitHub-style grid of days over all time: a column per week (Monday
// first), as many weeks as fit, ending this week
function heatmap(el: HTMLElement, colors: Palette, days: Summary['days']) {
  const byDay = new Map(days.map(d => [d.day, d]))
  const left = 28
  const top = 16
  const width = Math.max(el.clientWidth, 200)
  // a year of weeks when they fit at 10px or more, cells growing to fill
  // the width; a narrow screen shows fewer weeks instead
  const weeks = Math.max(8, Math.min(53, Math.floor((width - left) / 13)))
  const step = Math.min(22, (width - left) / weeks)
  const cell = step - 3
  const start = new Date()
  start.setHours(12, 0, 0, 0)
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7) - (weeks - 1) * 7)
  const today = dayKey(Date.now())
  let svg = ''
  ;['Mon', 'Wed', 'Fri'].forEach((name, k) => (svg += `<text x="0" y="${top + step * k * 2 + cell - 2}">${name}</text>`))
  let lastMonth = -1
  const cells: { day: string; x: number; y: number }[] = []
  for (let wk = 0; wk < weeks; wk++) {
    for (let dow = 0; dow < 7; dow++) {
      const d = new Date(start)
      d.setDate(start.getDate() + wk * 7 + dow)
      const day = dayKey(d.getTime())
      if (day > today) continue
      if (dow === 0 && d.getMonth() !== lastMonth) {
        if (lastMonth !== -1 || d.getDate() <= 7) svg += `<text x="${left + wk * step}" y="${top - 5}">${d.toLocaleDateString(undefined, { month: 'short' })}</text>`
        lastMonth = d.getMonth()
      }
      const x = left + wk * step
      const y = top + dow * step
      cells.push({ day, x, y })
      svg += `<rect class="heat${day === today ? ' today' : ''}" data-day="${day}" x="${x}" y="${y}" width="${cell}" height="${cell}" rx="2" style="fill:var(--heat-${heatLevel(byDay.get(day)?.ms ?? 0)})"/>`
    }
  }
  const height = top + step * 7
  el.innerHTML = `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Active time per day">${svg}</svg>`
  el.querySelectorAll<SVGRectElement>('.heat').forEach(rect => {
    const d = byDay.get(rect.dataset.day!)
    rect.addEventListener('mousemove', e =>
      showTip(e, `<strong>${longDay(rect.dataset.day!)}</strong>${d?.ms ? `${duration(d.ms)} active${stack(colors, d.projects).lines}` : 'nothing logged'}`),
    )
    rect.addEventListener('mouseleave', hideTip)
  })
  const labels = ['under 30m', '30m to 1h', '1h to 2h', '2h to 4h', '4h or more']
  $('heat-legend').innerHTML =
    '<span>less</span>' +
    labels.map((label, k) => `<span class="swatch" title="${label}" style="background:var(--heat-${k + 1})"></span>`).join('') +
    '<span>more</span>'
}

function render() {
  if (!events) return
  const w = rangeWindow(range)
  const s: Summary = summarize(events, { from: w.from, to: w.to, idleCapMs: idleMin * MIN })
  // all time picks each project's color and fills the heatmap
  const ever = summarize(events, { idleCapMs: idleMin * MIN })
  const colors = palette(ever.projects)
  const any = s.sessions.length > 0

  $('total').textContent = duration(s.totalMs)
  $('total-label').textContent = `active with Claude, ${w.label}${any ? `, across ${s.sessions.length} session${s.sessions.length === 1 ? '' : 's'}` : ''}`

  const totalTurns = s.turns + s.interrupts
  $('tiles').innerHTML = [
    tile('Prompts', compact(s.prompts.count), s.prompts.count ? `avg ${Math.round(s.prompts.avgWords)} word${Math.round(s.prompts.avgWords) === 1 ? '' : 's'}` : ''),
    tile('Turns', compact(s.turns), s.prompts.midTurn ? `${compact(s.prompts.midTurn)} prompt${s.prompts.midTurn === 1 ? '' : 's'} sent mid-turn` : ''),
    tile('Interrupts', compact(s.interrupts), totalTurns ? `${Math.round((s.interrupts / totalTurns) * 100)}% of turns${s.interruptsMidTool ? `, ${compact(s.interruptsMidTool)} mid-tool` : ''}` : ''),
    tile('Tokens out', compact(s.tokens.output), s.tokens.cacheRead ? `${compact(s.tokens.cacheRead)} cache reads` : ''),
    writingTile(s.writing),
  ].join('')

  $('empty').hidden = any
  $('content').hidden = !any
  if (!any) return

  writingCard(s.writing)
  heatmap($('heat'), colors, ever.days)
  const legend = projectLegend(colors, s.projects.map(p => p.project))
  $('days-legend').innerHTML = legend
  $('hours-legend').innerHTML = legend

  // one column per day only makes sense past a single day
  const daysCard = $('days-card')
  daysCard.hidden = s.days.length <= 1
  if (!daysCard.hidden) {
    const today = dayKey(Date.now())
    columns(
      $('days'),
      s.days.map(d => {
        const { segments, lines } = stack(colors, d.projects)
        return {
          label: d.day === today ? 'today' : shortDay(d.day),
          segments,
          tip: `<strong>${longDay(d.day)}</strong>${duration(d.ms)} active · ${d.prompts} prompt${d.prompts === 1 ? '' : 's'}${lines}`,
        }
      }),
      Math.ceil(s.days.length / 8),
    )
  }

  columns(
    $('hours'),
    s.hours.map((ms, h) => {
      const { segments, lines } = stack(colors, s.hourProjects[h]!)
      return { label: hourLabel(h), segments, tip: `<strong>${hourLabel(h)}</strong>${duration(ms)} active${lines}` }
    }),
    3,
  )

  barList(
    $('projects'),
    s.projects.map(p => ({
      name: p.project,
      value: p.ms,
      amount: duration(p.ms),
      color: colors.color(p.project),
      tip: `<strong>${esc(p.project)}</strong>${duration(p.ms)} · ${Math.round((p.ms / s.totalMs) * 100)}%`,
    })),
  )

  const edits = s.languages.reduce((sum, l) => sum + l.edits, 0)
  barList(
    $('languages'),
    s.languages.map(l => ({
      name: l.language,
      value: l.edits,
      amount: String(l.edits),
      tip: `<strong>${esc(l.language)}</strong>${l.edits} file change${l.edits === 1 ? '' : 's'} · ${Math.round((l.edits / edits) * 100)}%`,
    })),
    8,
  )

  barList(
    $('tools'),
    s.tools.map(t => ({
      name: toolName(t.tool),
      value: t.calls,
      amount: compact(t.calls),
      tip: `<strong>${esc(toolName(t.tool))}</strong>${t.calls} calls · avg ${t.avgMs < 1000 ? `${Math.round(t.avgMs)}ms` : `${(t.avgMs / 1000).toFixed(1)}s`}<br>${t.errors} errors · ${t.denied} denied`,
    })),
    12,
  )

  const when = (ms: number) =>
    new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  // most time first; a session with no active time in range keeps its home
  const shown = s.sessions.slice(0, 25)
  const projectsOf = (x: Summary['sessions'][number]) => (x.projects.length ? x.projects : [{ project: x.project, ms: 0 }])
  $('sessions').innerHTML =
    '<tr><th>Started</th><th>Projects</th><th class="num">Active</th><th class="num">Prompts</th><th>Session</th></tr>' +
    shown
      .map(
        (x, i) => `<tr data-i="${i}"><td><a href="${withPerson(`/session?id=${encodeURIComponent(x.sessionId)}`)}">${when(x.start)}</a></td><td class="chips">${projectsOf(x)
          .map(p => chip(colors, p.project, p.ms))
          .join('')}</td><td class="num">${duration(x.activeMs)}</td><td class="num">${x.prompts}</td><td class="muted"><code>${esc(x.sessionId.slice(0, 8))}</code></td></tr>`,
      )
      .join('')
  $('sessions').querySelectorAll<HTMLElement>('.chips').forEach(cell => {
    const x = shown[Number(cell.parentElement!.dataset.i)]!
    if (x.projects.length < 2) return
    // the times can add up to more than Active: a stretch two projects
    // shared counts in full for each
    const tip = `<strong>${duration(x.activeMs)} active</strong>time two projects shared counts for each`
    cell.addEventListener('mousemove', e => showTip(e, tip))
    cell.addEventListener('mouseleave', hideTip)
  })
}

// --- wiring --------------------------------------------------------------

async function refresh() {
  try {
    events = await api<Event[]>('/api/events')
  } catch (err) {
    console.error('could not load events', err)
    events ??= []
  }
  render()
}

function syncControls() {
  document.querySelectorAll<HTMLButtonElement>('[data-range]').forEach(b => {
    b.setAttribute('aria-pressed', String(b.dataset.range === range))
  })
  $<HTMLSelectElement>('idle').value = String(idleMin)
}

document.querySelectorAll<HTMLButtonElement>('[data-range]').forEach(b =>
  b.addEventListener('click', () => {
    range = b.dataset.range as Range
    save('range', range)
    syncControls()
    render()
  }),
)
$<HTMLSelectElement>('idle').addEventListener('change', e => {
  idleMin = Number((e.target as HTMLSelectElement).value)
  save('idle', String(idleMin))
  render()
})

// charts are drawn at a measured width, so redraw when it changes. That
// includes a scrollbar showing up after the first render
let lastWidth = 0
let resizeTimer: ReturnType<typeof setTimeout> | undefined
new ResizeObserver(([entry]) => {
  const width = Math.round(entry!.contentRect.width)
  if (width === lastWidth) return
  lastWidth = width
  clearTimeout(resizeTimer)
  resizeTimer = setTimeout(render, 50)
}).observe(document.querySelector('main')!)

// On the hub: whose dashboard this is, a picker for an admin, and log out
document.querySelectorAll<HTMLAnchorElement>('nav a').forEach(a => (a.href = withPerson(a.getAttribute('href')!)))

async function who() {
  const me = await api<Me>('/api/me').catch((): Me => ({}))
  if (!me.me) return
  $('who').hidden = false
  const pick = $<HTMLSelectElement>('person')
  const names = me.admin && me.people?.length ? me.people : [me.person!]
  pick.innerHTML = names.map(name => `<option${name === me.person ? ' selected' : ''}>${esc(name)}</option>`).join('')
  pick.disabled = names.length < 2
  pick.addEventListener('change', () => {
    const url = new URL(location.href)
    if (pick.value === me.me) url.searchParams.delete('person')
    else url.searchParams.set('person', pick.value)
    location.href = url.toString()
  })
}

syncControls()
who()
refresh()
setInterval(refresh, REFRESH_MS)
