/**
 * 战舰 —— 逻辑解题回放计划
 */

import type { GameState, LogicPlan, PlaybackFrame, Puzzle } from '../core/types'
import { isValidSolution, propagate, type RuleKind } from './rules'
import {
  asShipPuzzle,
  asShipState,
  EMPTY,
  SHIP,
  WATER,
  type BattleshipState,
} from './types'

const RULE_INFO: Record<RuleKind | 'probe' | 'search', { rule: number; label: string }> = {
  adj: { rule: 1, label: '战舰互不接触：斜向/侧向邻格必须是水' },
  sum: { rule: 2, label: '行列舰格数上下界' },
  fleet: { rule: 3, label: '舰队总格数守恒' },
  seg: { rule: 4, label: '舰段端点定式：强制延伸 / 封水' },
  comp: { rule: 5, label: '舰段长度与舰队库存匹配' },
  place: { rule: 6, label: '最长舰唯一位置：所有可能位置共有的舰格' },
  probe: { rule: 7, label: '反证：另一种状态会立刻矛盾' },
  search: { rule: 8, label: '回溯试探：该格最终是这一状态' },
}

function fallbackSolve(
  grid: number[],
  fleet: number[],
  rowSums: number[],
  colSums: number[],
  w: number,
  h: number,
  maxNodes: number,
): number[] | null {
  const size = w * h
  let nodes = 0
  let timedOut = false
  const work = grid.slice()
  const dfs = (): number[] | null => {
    if (timedOut) return null
    nodes++
    if (nodes > maxNodes) {
      timedOut = true
      return null
    }
    if (!propagate(work, fleet, rowSums, colSums, w, h)) return null
    let choice = -1
    for (let i = 0; i < size; i++) {
      if (work[i] === EMPTY) {
        choice = i
        break
      }
    }
    if (choice < 0) {
      return isValidSolution(work, fleet, rowSums, colSums, w, h) ? Array.from(work) : null
    }
    const backup = work.slice()
    for (const value of [SHIP, WATER] as const) {
      work[choice] = value
      const found = dfs()
      if (found) return found
      for (let i = 0; i < size; i++) work[i] = backup[i]!
      if (timedOut) return null
    }
    return null
  }
  return dfs()
}

export function planLogicSolve(puzzle: Puzzle, initialState: GameState): LogicPlan {
  const p = asShipPuzzle(puzzle)
  const s = asShipState(initialState)
  const w = s.width
  const h = s.height
  const size = w * h
  const fleet = p.fleet ?? []
  const rowSums = p.rowSums ?? []
  const colSums = p.colSums ?? []

  const emptyPlan: LogicPlan = {
    puzzleId: p.id,
    frames: [],
    finalState: null,
    ruleSteps: 0,
    saturated: false,
  }
  if (!fleet.length || rowSums.length !== h || colSums.length !== w) return emptyPlan

  const grid = s.cells.slice()
  const displayed = s.cells.slice()
  const frames: PlaybackFrame[] = []
  let lastKind = ''
  let streak = 0
  const emit = (index: number, to: number, kind: RuleKind | 'probe' | 'search'): void => {
    const from = displayed[index] ?? EMPTY
    if (from === to) return
    displayed[index] = to
    if (kind === lastKind) streak++
    else {
      lastKind = kind
      streak = 1
    }
    frames.push({ rule: RULE_INFO[kind].rule, label: RULE_INFO[kind].label, move: { index, from, to }, streak })
  }
  const onSet = (index: number, value: number, kind: RuleKind): void => emit(index, value, kind)

  if (!propagate(grid, fleet, rowSums, colSums, w, h, onSet)) return emptyPlan

  let saturated = true
  for (let round = 0; round < size * 2; round++) {
    let unknown = -1
    for (let i = 0; i < size; i++) {
      if (grid[i] === EMPTY) {
        unknown = i
        break
      }
    }
    if (unknown < 0) break
    if (frames.length > 8000) {
      saturated = false
      break
    }
    const forced: Array<{ index: number; value: number }> = []
    for (let i = 0; i < size; i++) {
      if (grid[i] !== EMPTY) continue
      let shipImpossible = false
      let waterImpossible = false
      {
        const trial = Int8Array.from(grid)
        trial[i] = SHIP
        if (!propagate(trial, fleet, rowSums, colSums, w, h)) shipImpossible = true
      }
      {
        const trial = Int8Array.from(grid)
        trial[i] = WATER
        if (!propagate(trial, fleet, rowSums, colSums, w, h)) waterImpossible = true
      }
      if (shipImpossible && waterImpossible) return emptyPlan
      if (shipImpossible !== waterImpossible) {
        forced.push({ index: i, value: shipImpossible ? WATER : SHIP })
      }
    }
    if (!forced.length) {
      saturated = false
      break
    }
    for (const { index, value } of forced) {
      if (grid[index] === EMPTY) {
        grid[index] = value
        emit(index, value, 'probe')
      }
    }
    if (!propagate(grid, fleet, rowSums, colSums, w, h, onSet)) return emptyPlan
  }

  let stillUnknown = false
  for (let i = 0; i < size; i++) {
    if (grid[i] === EMPTY) {
      stillUnknown = true
      break
    }
  }
  if (stillUnknown) {
    const found = fallbackSolve(grid, fleet, rowSums, colSums, w, h, 800_000)
    if (!found) return emptyPlan
    for (let i = 0; i < size; i++) {
      if (grid[i] === found[i]) continue
      grid[i] = found[i]!
      emit(i, found[i]!, 'search')
    }
    saturated = false
  }

  const finalState: BattleshipState = {
    puzzleId: s.puzzleId,
    width: w,
    height: h,
    cells: Array.from(grid),
    givens: s.givens.slice(),
  }
  return { puzzleId: p.id, frames, finalState, ruleSteps: frames.length, saturated }
}
