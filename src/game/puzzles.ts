/**
 * 战舰 —— 题库加载
 */

import { RAW_PUZZLES } from './puzzles-data'
import {
  asShipPuzzle,
  decodeBoard,
  decodeCells,
  type BattleshipPuzzle,
  type BattleshipState,
} from './types'

export const builtinPuzzles: BattleshipPuzzle[] = []
const solutions = new Map<string, number[]>()

for (const raw of RAW_PUZZLES) {
  const size = raw.width * raw.height
  const decoded = decodeBoard(raw.board, size, raw.width, raw.height)
  if (!decoded) {
    console.warn(`[战舰] 题面解码失败：${raw.id}`)
    continue
  }
  const puzzle: BattleshipPuzzle = {
    id: raw.id,
    name: raw.name,
    width: raw.width,
    height: raw.height,
    difficulty: raw.difficulty,
    givens: decoded.givens,
    fleet: decoded.fleet,
    rowSums: decoded.rowSums,
    colSums: decoded.colSums,
  }
  builtinPuzzles.push(puzzle)
  if (raw.solution) {
    const solution = decodeCells(raw.solution, size)
    if (solution) {
      puzzle.solution = solution
      solutions.set(raw.id, solution)
    }
  }
}

export function getReferenceSolution(id: string): BattleshipState | null {
  const cells = solutions.get(id)
  if (!cells) return null
  const puzzle = builtinPuzzles.find((p) => p.id === id)
  if (!puzzle) return null
  return {
    puzzleId: puzzle.id,
    width: puzzle.width,
    height: puzzle.height,
    cells: cells.slice(),
    givens: puzzle.givens.slice(),
  }
}

export function puzzleById(id: string): BattleshipPuzzle | undefined {
  return builtinPuzzles.find((p) => p.id === id)
}

export function referenceFor(puzzle: BattleshipPuzzle): number[] | null {
  return asShipPuzzle(puzzle).solution ?? solutions.get(puzzle.id) ?? null
}
