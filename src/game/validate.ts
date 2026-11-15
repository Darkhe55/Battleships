/**
 * 战舰 —— 实时校验
 */

import type { GameState, Puzzle, ValidationResult } from '../core/types'
import { diagonalNeighbors, isValidSolution } from './rules'
import {
  asShipPuzzle,
  asShipState,
  EMPTY,
  SHIP,
  WATER,
  type BattleshipResult,
  type FleetIssue,
  type LineIssue,
} from './types'

export function validate(state: GameState, puzzle: Puzzle): BattleshipResult {
  const s = asShipState(state)
  const p = asShipPuzzle(puzzle)
  const w = s.width
  const h = s.height
  const size = w * h
  const cells = s.cells
  const fleet = p.fleet ?? []
  const rowSums = p.rowSums ?? []
  const colSums = p.colSums ?? []
  const total = fleet.reduce((a, b) => a + b, 0)

  let empty = 0
  let shipCount = 0
  const changed = new Set<number>()
  for (let i = 0; i < size; i++) {
    if (cells[i] === EMPTY) empty++
    else if (cells[i] === SHIP) shipCount++
    const given = p.givens?.[i] ?? EMPTY
    if (given !== EMPTY && cells[i] !== given) changed.add(i)
  }

  const bad = new Set<number>()
  for (const i of changed) bad.add(i)

  let adjacentPairs = 0
  const adjacent = new Set<number>()
  for (let i = 0; i < size; i++) {
    if (cells[i] !== SHIP) continue
    for (const j of diagonalNeighbors(i, w, h)) {
      if (j < i) continue
      if (cells[j] === SHIP) {
        adjacentPairs++
        adjacent.add(i)
        adjacent.add(j)
      }
    }
  }
  for (const i of adjacent) bad.add(i)

  const sumIssues: LineIssue[] = []
  for (let y = 0; y < h; y++) {
    const target = rowSums[y] ?? 0
    let count = 0
    let unknown = 0
    for (let x = 0; x < w; x++) {
      const v = cells[y * w + x]
      if (v === SHIP) count++
      else if (v === EMPTY) unknown++
    }
    if (count > target || count + unknown < target || (unknown === 0 && count !== target)) {
      sumIssues.push({ orientation: 'row', index: y, ships: count, target })
      if (unknown === 0 || count + unknown < target) {
        for (let x = 0; x < w; x++) bad.add(y * w + x)
      }
    }
  }
  for (let x = 0; x < w; x++) {
    const target = colSums[x] ?? 0
    let count = 0
    let unknown = 0
    for (let y = 0; y < h; y++) {
      const v = cells[y * w + x]
      if (v === SHIP) count++
      else if (v === EMPTY) unknown++
    }
    if (count > target || count + unknown < target || (unknown === 0 && count !== target)) {
      sumIssues.push({ orientation: 'col', index: x, ships: count, target })
      if (unknown === 0 || count + unknown < target) {
        for (let y = 0; y < h; y++) bad.add(y * w + x)
      }
    }
  }

  const fleetIssues: FleetIssue[] = []
  if (shipCount > total) {
    fleetIssues.push({ kind: 'total', detail: `舰格数 ${shipCount} 超过舰队总数 ${total}` })
  }
  if (adjacentPairs > 0) {
    fleetIssues.push({ kind: 'adjacent', detail: `${adjacentPairs} 处战舰相邻` })
  }

  const normalized = cells.map((v) => (v === SHIP ? SHIP : WATER))
  const solved =
    changed.size === 0 &&
    isValidSolution(normalized, fleet, rowSums, colSums, w, h)

  return {
    solved,
    empty,
    complete: empty === 0,
    shipCount,
    adjacentPairs,
    adjacentCells: Array.from(adjacent),
    fleetIssues,
    sumIssues,
    badCells: Array.from(bad),
    changedGivens: Array.from(changed),
  }
}

export function statusBits(result: ValidationResult): string[] {
  const r = result as BattleshipResult
  if (r.solved) return ['完成']
  const bits: string[] = []
  if (typeof r.empty === 'number' && r.empty > 0) bits.push(`还需填 ${r.empty} 格`)
  if (r.adjacentPairs > 0) bits.push(`${r.adjacentPairs} 处战舰相邻`)
  if (r.fleetIssues.some((x) => x.kind === 'total')) bits.push('舰格数超过舰队总数')
  if (r.sumIssues.length > 0) {
    const rows = r.sumIssues.filter((x) => x.orientation === 'row').length
    const cols = r.sumIssues.length - rows
    if (rows > 0) bits.push(`${rows} 行数字不满足`)
    if (cols > 0) bits.push(`${cols} 列数字不满足`)
  }
  if (r.changedGivens.length > 0) bits.push('题面预填格被改动')
  if (bits.length === 0) bits.push('继续放置战舰')
  return bits
}
