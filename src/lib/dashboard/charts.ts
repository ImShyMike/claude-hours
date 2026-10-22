// The overview's charts, drawn by Chart.js. Colors come from the CSS tokens,
// read at draw time, so a theme flip only needs a redraw
import {
  BarController,
  BarElement,
  CategoryScale,
  Chart,
  LinearScale,
  Tooltip,
  type Scale,
  type ScriptableContext,
  type TooltipModel,
} from 'chart.js'
import { MatrixController, MatrixElement } from 'chartjs-chart-matrix'
import { MIN, hideTip, showTip } from './shared'

Chart.register(BarController, BarElement, CategoryScale, LinearScale, Tooltip, MatrixController, MatrixElement)

// "var(--p3)" or "--p3" to the color it holds right now
export function token(color: string) {
  const name = /^var\((--[\w-]+)\)$/.exec(color)?.[1] ?? (color.startsWith('--') ? color : undefined)
  return name ? getComputedStyle(document.documentElement).getPropertyValue(name).trim() : color
}

// clean duration ticks: the smallest step that keeps it to about four lines
const STEPS_MIN = [1, 2, 5, 10, 15, 30, 60, 120, 180, 240, 360, 480, 720, 1440]
function niceStep(maxMs: number) {
  const maxMin = maxMs / MIN
  return (STEPS_MIN.find(step => maxMin / step <= 4) ?? 1440) * MIN
}
const tickLabel = (ms: number) => (ms >= 60 * MIN ? `${ms / (60 * MIN)}h` : `${ms / MIN}m`)

// one canvas per chart element, replaced on every draw
function canvas(el: HTMLElement, height: number) {
  Chart.getChart(el.querySelector('canvas') ?? '')?.destroy()
  el.style.height = `${height}px`
  el.innerHTML = '<canvas></canvas>'
  return el.querySelector('canvas')!
}

function theme() {
  Chart.defaults.color = token('--muted')
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily
  Chart.defaults.font.size = 11
}

// our own tooltip, so it looks like every other one on the page
const tip = (html: (i: number) => string | undefined) =>
  ({
    enabled: false,
    external: ({ chart, tooltip }: { chart: Chart; tooltip: TooltipModel<any> }) => {
      const point = tooltip.dataPoints?.[0]
      const content = point && tooltip.opacity ? html(point.dataIndex) : undefined
      if (!content) return hideTip()
      const box = chart.canvas.getBoundingClientRect()
      showTip({ clientX: box.left + tooltip.caretX, clientY: box.top + tooltip.caretY } as MouseEvent, content)
    },
  }) as const

export type Series = { name: string; color: string; values: number[] }

// Columns from one baseline, each stacked by project bottom up, with a 2px
// surface gap between segments and a 4px rounded top
export function stackedColumns(el: HTMLElement, labels: string[], series: Series[], tips: string[], maxTicks = 12) {
  theme()
  const totals = labels.map((_, i) => series.reduce((sum, s) => sum + s.values[i]!, 0))
  const step = niceStep(Math.max(...totals, 0) || MIN)
  const top = Math.max(step, Math.ceil(Math.max(...totals, 0) / step) * step)
  // the highest segment with time in each column gets the rounded top
  const topmost = labels.map((_, i) => series.findLastIndex(s => s.values[i]! > 0))
  const surface = token('--surface')
  const chart = new Chart(canvas(el, 200), {
    type: 'bar',
    data: {
      labels,
      datasets: series.map((s, d) => ({
        label: s.name,
        data: s.values,
        backgroundColor: token(s.color),
        hoverBackgroundColor: token(s.color),
        borderColor: surface,
        borderWidth: { top: 2, right: 0, bottom: 0, left: 0 },
        borderSkipped: 'bottom',
        borderRadius: (ctx: ScriptableContext<'bar'>) =>
          topmost[ctx.dataIndex] === d ? { topLeft: 4, topRight: 4, bottomLeft: 0, bottomRight: 0 } : 0,
        maxBarThickness: 24,
        categoryPercentage: 0.7,
        barPercentage: 1,
      })),
    },
    options: {
      animation: false,
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: false }, tooltip: tip(i => (totals[i] ? tips[i] : undefined)) },
      scales: {
        x: {
          stacked: true,
          grid: { display: false },
          border: { color: token('--axis') },
          ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: maxTicks },
        },
        y: {
          stacked: true,
          min: 0,
          max: top,
          grid: { color: token('--grid') },
          border: { display: false },
          ticks: { stepSize: step, callback: (v: string | number) => tickLabel(Number(v)) },
        },
      },
    },
  })
  el.onmouseleave = hideTip
  return chart
}

export type Cell = { week: number; dow: number; level: number; today: boolean; tip: string }

// A GitHub-style calendar: a column per week, Monday on top
export function calendar(el: HTMLElement, weeks: number, months: string[], cells: Cell[]) {
  theme()
  const width = Math.max(el.clientWidth, 200)
  const step = Math.min(22, (width - 30) / weeks)
  const ink = token('--ink')
  const heat = [0, 1, 2, 3, 4, 5].map(k => token(`--heat-${k}`))
  new Chart(canvas(el, step * 7 + 22), {
    type: 'matrix',
    data: {
      datasets: [
        {
          data: cells.map(c => ({ x: c.week, y: c.dow, v: c.level })),
          backgroundColor: (ctx: ScriptableContext<'matrix'>) => heat[cells[ctx.dataIndex]?.level ?? 0]!,
          borderColor: ink,
          borderWidth: (ctx: ScriptableContext<'matrix'>) => (cells[ctx.dataIndex]?.today ? 1 : 0),
          hoverBorderWidth: 1,
          hoverBorderColor: ink,
          borderRadius: 2,
          width: ({ chart }) => (chart.chartArea?.width ?? 0) / weeks - 3,
          height: ({ chart }) => (chart.chartArea?.height ?? 0) / 7 - 3,
        },
      ],
    },
    options: {
      animation: false,
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: tip(i => cells[i]?.tip) },
      scales: {
        x: {
          type: 'linear',
          position: 'top',
          offset: false,
          min: -0.5,
          max: weeks - 0.5,
          grid: { display: false },
          border: { display: false },
          afterBuildTicks: (scale: Scale) => void (scale.ticks = months.flatMap((m, week) => (m ? [{ value: week }] : []))),
          ticks: { autoSkip: false, maxRotation: 0, padding: 2, callback: (v: string | number) => months[Number(v)] ?? '' },
        },
        y: {
          type: 'linear',
          reverse: true,
          offset: false,
          min: -0.5,
          max: 6.5,
          grid: { display: false },
          border: { display: false },
          afterBuildTicks: (scale: Scale) => void (scale.ticks = [0, 2, 4].map(value => ({ value }))),
          ticks: { padding: 2, callback: (v: string | number) => ({ 0: 'Mon', 2: 'Wed', 4: 'Fri' })[Number(v)] ?? '' },
        },
      },
    },
  })
  el.onmouseleave = hideTip
}
