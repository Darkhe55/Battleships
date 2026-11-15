/**
 * 战舰 —— 规则引擎
 */

import { EMPTY, SHIP, WATER } from './types.ts'

export type RuleKind = 'adj' | 'sum' | 'fleet'

export type SetCallback = (index: number, value: number, rule: RuleKind) => void

const DX8 = [1, -1, 0, 0, 1, 1, -1, -1]
const DY8 = [0, 0, 1, -1, 1, -1, 1, -1]

export function neighbors8(index: number, w: number, h: number): number[] {
  const x = index % w
  const y = (index / w) | 0
  const out: number[] = []
  for (let d = 0; d < 8; d++) {
    const nx = x + DX8[d]!
    const ny = y + DY8[d]!
    if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
    out.push(ny * w + nx)
  }
  return out
}

/** 四个斜向邻居：战舰之间斜向接触是非法的，正交相邻可能是同一艘船 */
export function diagonalNeighbors(index: number, w: number, h: number): number[] {
  const x = index % w
  const y = (index / w) | 0
  const out: number[] = []
  for (let dy = -1; dy <= 1; dy += 2) {
    for (let dx = -1; dx <= 1; dx += 2) {
      const nx = x + dx
      const ny = y + dy
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
      out.push(ny * w + nx)
    }
  }
  return out
}

export function initialGrid(givens: ArrayLike<number>, size: number): number[] {
  const grid = new Array<number>(size).fill(EMPTY)
  for (let i = 0; i < size; i++) {
    const v = givens[i] ?? EMPTY
    if (v === SHIP || v === WATER) grid[i] = v
  }
  return grid
}

export function propagate(
  cells: Int8Array | number[],
  fleet: number[],
  rowSums: number[],
  colSums: number[],
  w: number,
  h: number,
  onSet?: SetCallback,
): boolean {
  const size = w * h
  const total = fleet.reduce((a, b) => a + b, 0)
  let changed = true

  const set = (i: number, value: number, kind: RuleKind): boolean => {
    if (cells[i] === value) return true
    if (cells[i] !== EMPTY) return false
    cells[i] = value
    onSet?.(i, value, kind)
    changed = true
    return true
  }

  // 总舰格数上限
  let ships = 0
  for (let i = 0; i < size; i++) if (cells[i] === SHIP) ships++
  if (ships > total) return false

  while (changed) {
    changed = false

    for (let i = 0; i < size; i++) {
      if (cells[i] !== SHIP) continue
      for (const j of diagonalNeighbors(i, w, h)) {
        if (cells[j] === SHIP) return false
        if (cells[j] === EMPTY && !set(j, WATER, 'adj')) return false
      }
    }

    for (let y = 0; y < h; y++) {
      const target = rowSums[y] ?? 0
      let count = 0
      const unknown: number[] = []
      for (let x = 0; x < w; x++) {
        const i = y * w + x
        if (cells[i] === SHIP) count++
        else if (cells[i] === EMPTY) unknown.push(i)
      }
      if (count > target || count + unknown.length < target) return false
      if (count === target) {
        for (const i of unknown) if (!set(i, WATER, 'sum')) return false
      } else if (count + unknown.length === target) {
        for (const i of unknown) if (!set(i, SHIP, 'sum')) return false
      }
    }

    for (let x = 0; x < w; x++) {
      const target = colSums[x] ?? 0
      let count = 0
      const unknown: number[] = []
      for (let y = 0; y < h; y++) {
        const i = y * w + x
        if (cells[i] === SHIP) count++
        else if (cells[i] === EMPTY) unknown.push(i)
      }
      if (count > target || count + unknown.length < target) return false
      if (count === target) {
        for (const i of unknown) if (!set(i, WATER, 'sum')) return false
      } else if (count + unknown.length === target) {
        for (const i of unknown) if (!set(i, SHIP, 'sum')) return false
      }
    }

    // 总舰格数：达到总数后其余全水
    let shipCount = 0
    const unknown: number[] = []
    for (let i = 0; i < size; i++) {
      if (cells[i] === SHIP) shipCount++
      else if (cells[i] === EMPTY) unknown.push(i)
    }
    if (shipCount > total) return false
    if (shipCount + unknown.length < total) return false
    if (shipCount === total) {
      for (const i of unknown) if (!set(i, WATER, 'fleet')) return false
    }
  }

  return true
}

/** 舰格连通块（正交） */
function shipComponents(cells: ArrayLike<number>, w: number, h: number): number[][] {
  const size = w * h
  const seen = new Uint8Array(size)
  const out: number[][] = []
  for (let start = 0; start < size; start++) {
    if (cells[start] !== SHIP || seen[start]) continue
    const comp: number[] = []
    const stack = [start]
    seen[start] = 1
    while (stack.length) {
      const i = stack.pop()!
      comp.push(i)
      const x = i % w
      const y = (i / w) | 0
      if (x > 0 && cells[i - 1] === SHIP && !seen[i - 1]) {
        seen[i - 1] = 1
        stack.push(i - 1)
      }
      if (x + 1 < w && cells[i + 1] === SHIP && !seen[i + 1]) {
        seen[i + 1] = 1
        stack.push(i + 1)
      }
      if (y > 0 && cells[i - w] === SHIP && !seen[i - w]) {
        seen[i - w] = 1
        stack.push(i - w)
      }
      if (y + 1 < h && cells[i + w] === SHIP && !seen[i + w]) {
        seen[i + w] = 1
        stack.push(i + w)
      }
    }
    out.push(comp)
  }
  return out
}

function isStraight(comp: number[], w: number): boolean {
  const ys = new Set(comp.map((i) => (i / w) | 0))
  const xs = new Set(comp.map((i) => i % w))
  return ys.size === 1 || xs.size === 1
}

export function isValidSolution(
  cells: ArrayLike<number>,
  fleet: number[],
  rowSums: number[],
  colSums: number[],
  w: number,
  h: number,
): boolean {
  const size = w * h
  for (let i = 0; i < size; i++) {
    if (cells[i] !== SHIP && cells[i] !== WATER) return false
  }

  for (let y = 0; y < h; y++) {
    let count = 0
    for (let x = 0; x < w; x++) if (cells[y * w + x] === SHIP) count++
    if (count !== (rowSums[y] ?? 0)) return false
  }
  for (let x = 0; x < w; x++) {
    let count = 0
    for (let y = 0; y < h; y++) if (cells[y * w + x] === SHIP) count++
    if (count !== (colSums[x] ?? 0)) return false
  }

  for (let i = 0; i < size; i++) {
    if (cells[i] !== SHIP) continue
    for (const j of diagonalNeighbors(i, w, h)) {
      if (cells[j] === SHIP) return false
    }
  }

  const comps = shipComponents(cells, w, h)
  const lengths: number[] = []
  for (const comp of comps) {
    if (!isStraight(comp, w)) return false
    lengths.push(comp.length)
  }
  lengths.sort((a, b) => b - a)
  const expected = fleet.slice().sort((a, b) => b - a)
  if (lengths.length !== expected.length) return false
  for (let i = 0; i < lengths.length; i++) {
    if (lengths[i] !== expected[i]) return false
  }
  return true
}

export interface RuleSolveResult {
  ok: boolean
  solution: number[] | null
  contradiction: boolean
  saturated: boolean
  usedProbing: boolean
}

export function solveByRules(
  givens: ArrayLike<number>,
  fleet: number[],
  rowSums: number[],
  colSums: number[],
  size: number,
  w: number,
  h: number,
  probing = true,
  maxRounds = 400,
): RuleSolveResult {
  const grid = initialGrid(givens, size)
  let usedProbing = false
  for (let round = 0; round < maxRounds; round++) {
    if (!propagate(grid, fleet, rowSums, colSums, w, h)) {
      return { ok: false, solution: null, contradiction: true, saturated: false, usedProbing }
    }
    let unknown = -1
    for (let i = 0; i < size; i++) {
      if (grid[i] === EMPTY) {
        unknown = i
        break
      }
    }
    if (unknown < 0) {
      const solution = Array.from(grid)
      const ok = isValidSolution(solution, fleet, rowSums, colSums, w, h)
      return { ok, solution: ok ? solution : null, contradiction: false, saturated: ok, usedProbing }
    }
    if (!probing) {
      return { ok: false, solution: null, contradiction: false, saturated: false, usedProbing }
    }
    usedProbing = true
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
      if (shipImpossible && waterImpossible) {
        return { ok: false, solution: null, contradiction: true, saturated: false, usedProbing }
      }
      if (shipImpossible !== waterImpossible) {
        forced.push({ index: i, value: shipImpossible ? WATER : SHIP })
      }
    }
    if (!forced.length) {
      return { ok: false, solution: null, contradiction: false, saturated: false, usedProbing }
    }
    for (const { index, value } of forced) {
      if (grid[index] === EMPTY) grid[index] = value
    }
  }
  return { ok: false, solution: null, contradiction: false, saturated: false, usedProbing }
}
