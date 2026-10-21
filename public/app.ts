import { dayKey, summarize, type Event, type Summary } from '../src/aggregate'
import {
  $,
  MIN,
  api,
  attachments,
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
import { calendar, stackedColumns, type Cell, type Series } from './charts'

const REFRESH_MS = 30_000

let range = load<Range>('range', '7')
let idleMin = Number(load('idle', '5'))
// undefined until the first fetch, so nothing claims the log is empty early
let events: Event[] | undefined

// --- charts --------------------------------------------------------------

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

// pasted chars (folded pastes, and long keyless inserts) and what came along
function pastedTile(w: Summary['writing']) {
  const sent = w.typedChars + w.pastedChars
  const share = sent ? `${Math.round((w.pastedChars / sent) * 100)}% of chars` : ''
  return tile('Pasted', compact(w.pastedChars), [share, attachments(w)].filter(Boolean).join(' · '))
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

// a day's or hour's split grouped by palette slot, and the same split as
// tooltip lines, most time first
function grouped(colors: Palette, split: Record<string, number>) {
  const out = new Map<string, number>()
  for (const [project, ms] of Object.entries(split)) out.set(colors.group(project), (out.get(colors.group(project)) ?? 0) + ms)
  return out
}
function stack(colors: Palette, split: Record<string, number>) {
  const lines = [...grouped(colors, split)]
    .sort((a, b) => b[1] - a[1])
    .map(([p, ms]) => `<span class="tip-row"><span class="swatch" style="background:${colors.color(p)}"></span>${esc(p)} <span class="muted">${duration(ms)}</span></span>`)
    .join('')
  return { lines }
}

// the columns' splits as one series per project, palette order bottom up
function series(colors: Palette, splits: Record<string, number>[]): Series[] {
  const groups = splits.map(split => grouped(colors, split))
  return colors.order
    .filter(p => groups.some(g => g.has(p)))
    .map(p => ({ name: p, color: colors.color(p), values: groups.map(g => g.get(p) ?? 0) }))
}

// how dark a day's cell is: fixed steps, so a cell means the same thing
// whatever else is on the grid
const HEAT_STEPS = [30 * MIN, 60 * MIN, 120 * MIN, 240 * MIN]
const heatLevel = (ms: number) => (ms <= 0 ? 0 : 1 + HEAT_STEPS.filter(step => ms >= step).length)

// A GitHub-style grid of days over all time: a column per week (Monday
// first), as many weeks as fit, ending this week
function heatmap(el: HTMLElement, colors: Palette, days: Summary['days']) {
  const byDay = new Map(days.map(d => [d.day, d]))
  // a year of weeks when they fit at 10px or more; a narrow screen shows
  // fewer weeks instead
  const weeks = Math.max(8, Math.min(53, Math.floor((Math.max(el.clientWidth, 200) - 30) / 13)))
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
        tip: `<strong>${longDay(day)}</strong>${x?.ms ? `${duration(x.ms)} active${stack(colors, x.projects).lines}` : 'nothing logged'}`,
      })
    }
  }
  calendar(el, weeks, months, cells)
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
    pastedTile(s.writing),
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
    stackedColumns(
      $('days'),
      s.days.map(d => (d.day === today ? 'today' : shortDay(d.day))),
      series(colors, s.days.map(d => d.projects)),
      s.days.map(
        d => `<strong>${longDay(d.day)}</strong>${duration(d.ms)} active · ${d.prompts} prompt${d.prompts === 1 ? '' : 's'}${stack(colors, d.projects).lines}`,
      ),
      8,
    )
  }

  stackedColumns(
    $('hours'),
    s.hours.map((_, h) => hourLabel(h)),
    series(colors, s.hourProjects),
    s.hours.map((ms, h) => `<strong>${hourLabel(h)}</strong>${duration(ms)} active${stack(colors, s.hourProjects[h]!).lines}`),
    8,
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

// the charts read their colors when drawn, so a theme flip redraws them
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', render)

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
