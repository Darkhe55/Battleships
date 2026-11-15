/**
 * 战舰题库生成器
 *
 * 1. 随机放置舰队（不重叠、八邻接不接触）；
 * 2. 计算行列和；
 * 3. 随机顺序揭示预填格，二分查找最小唯一解前缀；
 * 4. 简单题再补一些预填格。
 */

import type { Difficulty } from '../core/types'
import { SHIP, WATER, encodeBoard, encodeCells } from './types.ts'
import { solveByRules } from './rules.ts'
import { countSolutions } from './solver.ts'

export interface RawPuzzleOut {
  id: string
  name: string
  width: number
  height: number
  difficulty: Difficulty
  series: string
  board: string
  solution: string
}

interface GenSpec {
  w: number
  h: number
  fleet: number[]
  seed: number
  difficulty: Difficulty
  name: string
  series: string
  extra: number
  attempts: number
  maxNodes: number
  requireLogic: boolean
}

function mulberry32(a: number): () => number {
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function shuffle<T>(list: T[], rng: () => number): T[] {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const tmp = list[i]!
    list[i] = list[j]!
    list[j] = tmp
  }
  return list
}

const DX8 = [1, -1, 0, 0, 1, 1, -1, -1]
const DY8 = [0, 0, 1, -1, 1, -1, 1, -1]

export function placeFleet(w: number, h: number, fleet: number[], rng: () => number): number[] | null {
  const occupied = new Set<number>()
  const forbidden = new Set<number>()
  const cells = new Array<number>(w * h).fill(0)

  const addShip = (placement: number[]): void => {
    for (const i of placement) {
      occupied.add(i)
      cells[i] = 1
      forbidden.add(i)
      const x = i % w
      const y = (i / w) | 0
      for (let d = 0; d < 8; d++) {
        const nx = x + DX8[d]!
        const ny = y + DY8[d]!
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
        forbidden.add(ny * w + nx)
      }
    }
  }
  const removeShip = (placement: number[]): void => {
    // 重新计算 forbidden：仅用于回溯，简单重建
    for (const i of placement) {
      occupied.delete(i)
      cells[i] = 0
    }
    forbidden.clear()
    for (const i of occupied) {
      forbidden.add(i)
      const x = i % w
      const y = (i / w) | 0
      for (let d = 0; d < 8; d++) {
        const nx = x + DX8[d]!
        const ny = y + DY8[d]!
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
        forbidden.add(ny * w + nx)
      }
    }
  }

  const lengths = fleet.slice().sort((a, b) => b - a)

  const dfs = (index: number): boolean => {
    if (index === lengths.length) return true
    const len = lengths[index]!
    const options: number[][] = []
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        // 水平
        if (x + len <= w) {
          const placement: number[] = []
          let ok = true
          for (let k = 0; k < len; k++) {
            const c = y * w + x + k
            if (forbidden.has(c)) {
              ok = false
              break
            }
            placement.push(c)
          }
          if (ok) options.push(placement)
        }
        // 竖直
        if (y + len <= h) {
          const placement: number[] = []
          let ok = true
          for (let k = 0; k < len; k++) {
            const c = (y + k) * w + x
            if (forbidden.has(c)) {
              ok = false
              break
            }
            placement.push(c)
          }
          if (ok) options.push(placement)
        }
      }
    }
    shuffle(options, rng)
    for (const placement of options) {
      addShip(placement)
      if (dfs(index + 1)) return true
      removeShip(placement)
    }
    return false
  }

  if (!dfs(0)) return null
  return cells.map((v) => (v === 1 ? SHIP : WATER))
}

function applyPrefix(
  solution: number[],
  order: number[],
  count: number,
): number[] {
  const givens = new Array<number>(solution.length).fill(0)
  for (let i = 0; i < count; i++) {
    const idx = order[i]!
    givens[idx] = solution[idx]!
  }
  return givens
}

interface AttemptStats {
  placeFail: number
  notUnique: number
  timeout: number
}

function attemptPuzzle(
  spec: GenSpec,
  rng: () => number,
  stats: AttemptStats,
): { givens: number[]; fleet: number[]; rowSums: number[]; colSums: number[]; solution: number[] } | null {
  const { w, h } = spec
  const size = w * h
  const solution = placeFleet(w, h, spec.fleet, rng)
  if (!solution) {
    stats.placeFail++
    return null
  }

  const rowSums = new Array<number>(h).fill(0)
  const colSums = new Array<number>(w).fill(0)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (solution[y * w + x] === SHIP) {
        rowSums[y]!++
        colSums[x]!++
      }
    }
  }

  const order = shuffle(
    Array.from({ length: size }, (_, i) => i),
    rng,
  )

  const isUnique = (givens: number[]): boolean | null => {
    const out = countSolutions(givens, spec.fleet, rowSums, colSums, size, w, h, 2, spec.maxNodes)
    if (out.timedOut) return null
    return out.count === 1
  }

  // 二分找最小唯一前缀
  let lo = 0
  let hi = size
  const full = applyPrefix(solution, order, hi)
  const fullUnique = isUnique(full)
  if (fullUnique === null) {
    stats.timeout++
    return null
  }
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    const unique = isUnique(applyPrefix(solution, order, mid))
    if (unique === null) {
      stats.timeout++
      return null
    }
    if (unique) hi = mid
    else lo = mid + 1
  }

  let count = lo
  if (spec.extra > 0) {
    count = Math.min(size, count + Math.round((size - count) * spec.extra))
  }
  const givens = applyPrefix(solution, order, count)

  if (spec.requireLogic) {
    solveByRules(givens, spec.fleet, rowSums, colSums, size, w, h, true, 240)
  }

  return { givens, fleet: spec.fleet, rowSums, colSums, solution }
}

const SPECS: GenSpec[] = [
  {
    w: 6,
    h: 6,
    fleet: [3, 2, 2, 1, 1],
    seed: 0x42415401,
    difficulty: 'easy',
    name: '初识舰队',
    series: '入门',
    extra: 0.2,
    attempts: 300,
    maxNodes: 80_000,
    requireLogic: true,
  },
  {
    w: 7,
    h: 7,
    fleet: [3, 3, 2, 1, 1],
    seed: 0x42415402,
    difficulty: 'easy',
    name: '七海巡航',
    series: '入门',
    extra: 0.15,
    attempts: 400,
    maxNodes: 100_000,
    requireLogic: true,
  },
  {
    w: 8,
    h: 8,
    fleet: [4, 3, 2, 2, 1, 1],
    seed: 0x42415403,
    difficulty: 'medium',
    name: '舰队回廊',
    series: '进阶',
    extra: 0.1,
    attempts: 500,
    maxNodes: 120_000,
    requireLogic: false,
  },
  {
    w: 8,
    h: 8,
    fleet: [4, 3, 3, 2, 1, 1],
    seed: 0x42415404,
    difficulty: 'medium',
    name: '深海编队',
    series: '进阶',
    extra: 0,
    attempts: 600,
    maxNodes: 130_000,
    requireLogic: false,
  },
  {
    w: 8,
    h: 8,
    fleet: [4, 3, 3, 2, 2, 1, 1],
    seed: 0x42415405,
    difficulty: 'hard',
    name: '钢铁洪流',
    series: '挑战',
    extra: 0,
    attempts: 800,
    maxNodes: 150_000,
    requireLogic: false,
  },
  {
    w: 8,
    h: 8,
    fleet: [5, 3, 3, 2, 2, 1, 1],
    seed: 0x42415406,
    difficulty: 'hard',
    name: '舰队终局',
    series: '挑战',
    extra: 0,
    attempts: 1000,
    maxNodes: 160_000,
    requireLogic: false,
  },
]

export function generatePuzzles(): RawPuzzleOut[] {
  const out: RawPuzzleOut[] = []
  for (const spec of SPECS) {
    const rng = mulberry32(spec.seed)
    const stats: AttemptStats = { placeFail: 0, notUnique: 0, timeout: 0 }
    let made: {
      givens: number[]
      fleet: number[]
      rowSums: number[]
      colSums: number[]
      solution: number[]
    } | null = null
    const t0 = Date.now()
    for (let attempt = 0; attempt < spec.attempts; attempt++) {
      made = attemptPuzzle(spec, rng, stats)
      if (made) break
    }
    if (!made) {
      console.error(`[战舰 gen] ${spec.name} 失败统计：`, stats)
      throw new Error(`[战舰 gen] ${spec.name} 在 ${spec.attempts} 次尝试内没有生成合法题`)
    }
    const ships = made.solution.filter((v) => v === SHIP).length
    const givens = made.givens.filter((v) => v !== 0).length
    console.log(
      `[战舰 gen] ${spec.name} ${spec.w}×${spec.h}：舰格 ${ships}，预填 ${givens}，${Date.now() - t0}ms`,
    )
    out.push({
      id: `battleships-${spec.w}x${spec.h}-${spec.seed.toString(36)}`,
      name: spec.name,
      width: spec.w,
      height: spec.h,
      difficulty: spec.difficulty,
      series: spec.series,
      board: encodeBoard(made.givens, made.fleet, made.rowSums, made.colSums),
      solution: encodeCells(made.solution),
    })
  }
  return out
}
