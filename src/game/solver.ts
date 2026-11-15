/**
 * 战舰 —— 回溯求解器
 */

import type { Puzzle, SolveResult } from '../core/types'
import { initialGrid, isValidSolution, propagate, solveByRules } from './rules.ts'
import { EMPTY, SHIP, WATER, type BattleshipPuzzle, type BattleshipState } from './types.ts'

export interface CountOutcome {
  count: number
  nodes: number
  timedOut: boolean
}

function search(
  givens: number[],
  fleet: number[],
  rowSums: number[],
  colSums: number[],
  size: number,
  w: number,
  h: number,
  limit: number,
  maxNodes: number,
): { solutions: number[][]; nodes: number; timedOut: boolean } {
  const grid = initialGrid(givens, size)
  const solutions: number[][] = []
  let nodes = 0
  let timedOut = false

  const dfs = (): void => {
    if (solutions.length >= limit || timedOut) return
    nodes++
    if (nodes > maxNodes) {
      timedOut = true
      return
    }
    if (!propagate(grid, fleet, rowSums, colSums, w, h)) return
    let choice = -1
    let best = -1
    for (let i = 0; i < size; i++) {
      if (grid[i] !== EMPTY) continue
      const x = i % w
      const y = (i / w) | 0
      let score = 0
      if (x > 0 && grid[i - 1] !== EMPTY) score++
      if (x + 1 < w && grid[i + 1] !== EMPTY) score++
      if (y > 0 && grid[i - w] !== EMPTY) score++
      if (y + 1 < h && grid[i + w] !== EMPTY) score++
      if (score > best) {
        best = score
        choice = i
      }
    }
    if (choice < 0) {
      if (isValidSolution(grid, fleet, rowSums, colSums, w, h)) solutions.push(Array.from(grid))
      return
    }
    const backup = Array.from(grid)
    for (const value of [SHIP, WATER] as const) {
      if (solutions.length >= limit || timedOut) return
      grid[choice] = value
      dfs()
      for (let i = 0; i < size; i++) grid[i] = backup[i]!
    }
  }
  dfs()
  return { solutions, nodes, timedOut }
}

export function countSolutions(
  givens: number[],
  fleet: number[],
  rowSums: number[],
  colSums: number[],
  size: number,
  w: number,
  h: number,
  limit = 2,
  maxNodes = 300_000,
): CountOutcome {
  const out = search(givens, fleet, rowSums, colSums, size, w, h, limit, maxNodes)
  return { count: out.solutions.length, nodes: out.nodes, timedOut: out.timedOut }
}

export function solvePuzzle(puzzle: Puzzle, maxNodes = 1_500_000): SolveResult {
  const p = puzzle as BattleshipPuzzle
  const size = p.width * p.height
  if (!p.fleet || !p.givens || !p.rowSums || !p.colSums) {
    return { solved: false, solution: null, nodes: 0, timedOut: false }
  }
  const byRules = solveByRules(
    p.givens,
    p.fleet,
    p.rowSums,
    p.colSums,
    size,
    p.width,
    p.height,
    true,
    240,
  )
  if (byRules.ok && byRules.solution) {
    return { solved: true, solution: makeState(p, byRules.solution), nodes: 0, timedOut: false }
  }
  if (byRules.contradiction) {
    return { solved: false, solution: null, nodes: 0, timedOut: false }
  }
  const out = search(p.givens, p.fleet, p.rowSums, p.colSums, size, p.width, p.height, 1, maxNodes)
  const solution = out.solutions[0]
  return {
    solved: !!solution,
    solution: solution ? makeState(p, solution) : null,
    nodes: out.nodes,
    timedOut: out.timedOut,
  }
}

export function makeState(puzzle: BattleshipPuzzle, cells: number[]): BattleshipState {
  return {
    puzzleId: puzzle.id,
    width: puzzle.width,
    height: puzzle.height,
    cells: cells.slice(),
    givens: puzzle.givens.slice(),
  }
}
