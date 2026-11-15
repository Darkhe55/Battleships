/**
 * 战舰（Battleships）—— 游戏专用类型
 *
 * 规则：
 *   1. 按给定舰队数量放置若干直线战舰；
 *   2. 战舰之间不能上下左右或斜向相邻；
 *   3. 盘外数字表示该行/列被战舰占据的格子数。
 *
 * 状态：0 = 未定，1 = 战舰，2 = 水。
 */

import type { GameState, Puzzle, ValidationResult } from '../core/types'

export const EMPTY = 0
export const SHIP = 1
export const WATER = 2

export type CellValue = 0 | 1 | 2

export interface BattleshipPuzzle extends Puzzle {
  /** 舰队长度（每艘船一格数） */
  fleet: number[]
  /** 题面预填：0 空，1 战舰，2 水 */
  givens: number[]
  rowSums: number[]
  colSums: number[]
  /** 参考解：1 战舰 / 2 水 */
  solution?: number[]
}

export interface BattleshipState extends GameState {
  cells: number[]
  givens: number[]
}

export interface FleetIssue {
  kind: 'lengths' | 'adjacent' | 'total'
  detail: string
}

export interface LineIssue {
  orientation: 'row' | 'col'
  index: number
  ships: number
  target: number
}

export interface BattleshipResult extends ValidationResult {
  empty: number
  complete: boolean
  shipCount: number
  /** 八邻接的舰格对数 */
  adjacentPairs: number
  adjacentCells: number[]
  fleetIssues: FleetIssue[]
  sumIssues: LineIssue[]
  badCells: number[]
  changedGivens: number[]
}

export function asShipPuzzle(p: Puzzle): BattleshipPuzzle {
  return p as BattleshipPuzzle
}

export function asShipState(s: GameState): BattleshipState {
  return s as BattleshipState
}

export function encodeBoard(
  givens: ArrayLike<number>,
  fleet: number[],
  rowSums: number[],
  colSums: number[],
): string {
  let out = ''
  for (let i = 0; i < givens.length; i++) out += String(givens[i]! | 0)
  return `${out}|${fleet.join(',')}|${rowSums.join(',')}|${colSums.join(',')}`
}

export function decodeBoard(
  text: string,
  expected: number,
  w: number,
  h: number,
): { givens: number[]; fleet: number[]; rowSums: number[]; colSums: number[] } | null {
  if (typeof text !== 'string') return null
  const parts = text.split('|')
  if (parts.length !== 4) return null
  const givenText = parts[0]!
  if (givenText.length !== expected) return null
  const givens = new Array<number>(expected).fill(0)
  for (let i = 0; i < expected; i++) {
    const v = givenText.charCodeAt(i) - 48
    if (v < 0 || v > 2) return null
    givens[i] = v
  }
  const parseNums = (s: string, len: number | undefined, allowZero: boolean): number[] | null => {
    const out: number[] = []
    if (s !== '') {
      for (const part of s.split(',')) {
        const n = Number(part)
        if (!Number.isInteger(n) || n < 0 || (!allowZero && n === 0)) return null
        out.push(n)
      }
    }
    return len === undefined || out.length === len ? out : null
  }
  const fleet = parseNums(parts[1]!, undefined, false)
  const rowSums = parseNums(parts[2]!, h, true)
  const colSums = parseNums(parts[3]!, w, true)
  if (!fleet || !rowSums || !colSums) return null
  return { givens, fleet, rowSums, colSums }
}

export function encodeCells(cells: ArrayLike<number>): string {
  let out = ''
  for (let i = 0; i < cells.length; i++) out += String(cells[i]! | 0)
  return out
}

export function decodeCells(text: string, expected: number): number[] | null {
  if (typeof text !== 'string' || text.length !== expected) return null
  const out = new Array<number>(expected)
  for (let i = 0; i < expected; i++) {
    const ch = text[i]!
    if (ch === '0' || ch === '.') out[i] = EMPTY
    else if (ch === '1' || ch === 'S' || ch === 's' || ch === '#') out[i] = SHIP
    else if (ch === '2' || ch === 'W' || ch === 'w' || ch === '~') out[i] = WATER
    else return null
  }
  return out
}
