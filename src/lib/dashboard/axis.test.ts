import { expect, test } from 'vitest'
import { axisOf } from './axis'

const MIN = 60_000
const H = 60 * MIN

// what a CSS length comes to at a width, the browser's way
function resolve(css: string, width: number) {
  const js = css
    .replaceAll('calc', '')
    .replace(/min\(([^,]+), ([^)]+)\)/g, 'Math.min($1, $2)')
    .replaceAll('100%', String(width))
    .replace(/(\d+)px/g, '$1')
  return Function(`return ${js}`)() as number
}

test('bars placed in CSS land where the axis puts them, at any width', () => {
  // two busy hours far apart, and a third close behind the second
  const spans: [number, number][] = [
    [0, H],
    [10 * H, 11 * H],
    [11 * H + 30 * MIN, 12 * H],
  ]
  for (const width of [400, 1000, 30_000]) {
    const axis = axisOf(spans, 0, width, 20 * MIN, 48)
    for (const ms of [0, 30 * MIN, 5 * H, 10 * H + 15 * MIN, 11 * H + 10 * MIN, 12 * H]) {
      expect(resolve(axis.css(ms), width)).toBeCloseTo(axis.x(ms), 6)
    }
    expect(resolve(axis.cssLength(30 * MIN, 10 * H + 15 * MIN), width)).toBeCloseTo(axis.x(10 * H + 15 * MIN) - axis.x(30 * MIN), 6)
    expect(axis.at(axis.x(10 * H + 15 * MIN))).toBeCloseTo(10 * H + 15 * MIN, 0)
  }
})

test("a bar's CSS doesn't change with the width, so a zoom leaves it alone", () => {
  const spans: [number, number][] = [
    [0, H],
    [5 * H, 6 * H],
  ]
  const narrow = axisOf(spans, 0, 500, 20 * MIN, 48)
  const wide = axisOf(spans, 0, 16_000, 20 * MIN, 48)
  expect(narrow.css(5 * H + 10 * MIN)).toBe(wide.css(5 * H + 10 * MIN))
  expect(narrow.x(5 * H + 10 * MIN)).not.toBe(wide.x(5 * H + 10 * MIN))
})
