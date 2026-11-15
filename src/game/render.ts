/**
 * 战舰 —— SVG 渲染与命中
 */

import type { BoardMetrics, GameState, Puzzle, ValidationResult } from '../core/types'
import { cellAtPoint, cellCenter, squareMetrics } from '../core/board'
import {
  asShipPuzzle,
  asShipState,
  EMPTY,
  SHIP,
  WATER,
  type BattleshipResult,
} from './types'

export function metricsFor(puzzle: Puzzle): BoardMetrics {
  return squareMetrics(puzzle.width, puzzle.height, {
    cell: 46,
    padLeft: 62,
    padTop: 62,
    padRight: 26,
    padBottom: 52,
    targetKind: 'cell',
  })
}

export function renderBoard(
  puzzle: Puzzle,
  state: GameState,
  result: ValidationResult,
  _colorGrid?: unknown,
): string {
  const m = metricsFor(puzzle)
  const p = asShipPuzzle(puzzle)
  const s = asShipState(state)
  const r = result as BattleshipResult
  const w = puzzle.width
  const h = puzzle.height
  const rowSums = p.rowSums ?? []
  const colSums = p.colSums ?? []
  const fleet = p.fleet ?? []
  const bad = new Set<number>(r.badCells ?? [])
  const badRows = new Set<number>()
  const badCols = new Set<number>()
  for (const issue of r.sumIssues ?? []) {
    if (issue.orientation === 'row') badRows.add(issue.index)
    else badCols.add(issue.index)
  }

  const cell = m.cell
  const ox = m.originX ?? m.pad
  const oy = m.originY ?? m.pad
  const gap = Math.max(1, cell * 0.03)
  const inner = cell - gap
  const parts: string[] = []

  parts.push(
    `<rect class="bs-board-bg" x="${ox - 10}" y="${oy - 10}" width="${w * cell + 20}" height="${h * cell + 20}" rx="${(cell * 0.2).toFixed(2)}" />`,
  )

  for (let i = 0; i < w * h; i++) {
    const x = ox + (i % w) * cell + gap / 2
    const y = oy + Math.floor(i / w) * cell + gap / 2
    const v = s.cells[i] ?? EMPTY
    const given = (s.givens[i] ?? EMPTY) !== EMPTY

    let cls = 'bs-cell'
    if (v === SHIP) cls += ' ship'
    else if (v === WATER) cls += ' water'
    else cls += ' empty'
    if (given) cls += ' given'
    if (bad.has(i)) cls += ' bad'

    let content = `<rect class="${cls}" x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${inner.toFixed(2)}" height="${inner.toFixed(2)}" rx="${(cell * 0.12).toFixed(2)}" />`
    if (v === SHIP) {
      content += `<circle class="bs-ship-dot" cx="${(x + inner / 2).toFixed(2)}" cy="${(y + inner / 2).toFixed(2)}" r="${(inner * 0.16).toFixed(2)}" />`
    }
    if (given) {
      content += `<circle class="bs-given-ring" cx="${(x + inner / 2).toFixed(2)}" cy="${(y + inner / 2).toFixed(2)}" r="${(inner * 0.4).toFixed(2)}" />`
    }
    if (bad.has(i)) {
      content += `<rect class="bs-error" x="${(x + 1.1).toFixed(2)}" y="${(y + 1.1).toFixed(2)}" width="${(inner - 2.2).toFixed(2)}" height="${(inner - 2.2).toFixed(2)}" rx="${(cell * 0.1).toFixed(2)}" />`
    }
    parts.push(`<g data-index="${i}">${content}</g>`)
  }

  const labels: string[] = []
  for (let y = 0; y < h; y++) {
    const c = cellCenter(m, y * w)
    labels.push(
      `<text class="bs-sum${badRows.has(y) ? ' issue' : ''}" x="${(c.x - cell / 2 - 10).toFixed(2)}" y="${c.y.toFixed(2)}" style="font-size:${(cell * 0.32).toFixed(2)}px">${rowSums[y] ?? 0}</text>`,
    )
  }
  for (let x = 0; x < w; x++) {
    const c = cellCenter(m, x)
    labels.push(
      `<text class="bs-sum col${badCols.has(x) ? ' issue' : ''}" x="${c.x.toFixed(2)}" y="${(c.y - cell / 2 - 12).toFixed(2)}" style="font-size:${(cell * 0.32).toFixed(2)}px">${colSums[x] ?? 0}</text>`,
    )
  }
  parts.push(`<g class="bs-sums">${labels.join('')}</g>`)

  const legend = `舰队：${fleet.join(' · ')}`
  parts.push(
    `<text class="bs-fleet" x="${(ox).toFixed(2)}" y="${(oy + h * cell + 28).toFixed(2)}" style="font-size:${(cell * 0.26).toFixed(2)}px">${legend}</text>`,
  )

  for (let i = 0; i < w * h; i++) {
    const x = ox + (i % w) * cell
    const y = oy + Math.floor(i / w) * cell
    parts.push(
      `<rect class="cell-hit" data-index="${i}" x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${cell.toFixed(2)}" height="${cell.toFixed(2)}" />`,
    )
  }

  return `<svg class="board-svg bs-board" viewBox="0 0 ${m.svgWidth} ${m.svgHeight}" width="${m.svgWidth}" height="${m.svgHeight}" xmlns="http://www.w3.org/2000/svg">${parts.join('')}</svg>`
}

export function hitTest(
  m: BoardMetrics,
  _puzzle: Puzzle,
  x: number,
  y: number,
): { index: number } | null {
  const index = cellAtPoint(m, x, y)
  return index == null ? null : { index }
}
