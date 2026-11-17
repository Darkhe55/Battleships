/**
 * 战舰 —— 规则引擎
 *
 * 这里只放「可证明」的定式：每一步赋值都能由题目规则直接推出，不依赖猜测。
 * 回溯搜索（solver.ts）只作为兜底。
 *
 * 规则分类：
 *   adj   战舰之间不能相邻：斜向邻格必须是水；已确定方向的直线舰段的侧向邻格必须是水
 *   sum   行/列舰格数上下界（该行/列已放满 → 其余全水；剩余格刚好够 → 全放舰格）
 *   fleet 舰队总格数守恒：行和 = 列和 = 舰队总格数；放满总格数后其余全水
 *   seg   舰段端点定式：可行舰长集合为空即矛盾；不可能再变长时端点封水；
 *         必须变长时，按「另一端最多能延伸多少」强制端点延伸格为舰格
 *   comp  舰段与舰队库存匹配：封闭舰段必须精确命中某个库存舰长；
 *         相互独立（两端都无法再与别的舰段合并）的舰段必须能一一分配到不重复的库存舰长
 *   place 最长舰唯一位置：舰队只有一艘最长舰时，枚举它所有合法摆放位置；
 *         一个位置都没有即矛盾，所有位置都覆盖的格子必为舰格
 *
 * 关键安全条件：两段共线舰格之间只隔空格时，未来可能合并成一艘更长的船。
 * 因此「舰段长度 / 库存匹配 / 强制延伸」只对两端都已封死（水或边界）的独立舰段生效；
 * 只要有一端还可能和别的舰段合并，就只做「侧向封水」与「已达最长舰长封水」这类
 * 与合并无关的保守定式。
 */

import { EMPTY, SHIP, WATER } from './types.ts'

export type RuleKind = 'adj' | 'sum' | 'fleet' | 'seg' | 'comp' | 'place'

export type SetCallback = (index: number, value: number, rule: RuleKind) => void

type SetFn = (index: number, value: number, kind: RuleKind) => boolean

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

interface EndInfo {
  /** 沿该方向连续空格的个数 */
  run: number
  /** 空格走完后是否被封死（水或边界）；false 表示尽头是另一段共线舰格，未来可能合并 */
  sealed: boolean
}

function endInfo(
  cells: ArrayLike<number>,
  w: number,
  h: number,
  x: number,
  y: number,
  dx: number,
  dy: number,
): EndInfo {
  let run = 0
  let cx = x + dx
  let cy = y + dy
  while (cx >= 0 && cy >= 0 && cx < w && cy < h && cells[cy * w + cx] === EMPTY) {
    run++
    cx += dx
    cy += dy
  }
  if (cx < 0 || cy < 0 || cx >= w || cy >= h) return { run, sealed: true }
  return { run, sealed: cells[cy * w + cx] === WATER }
}

/**
 * 舰段（舰格正交连通块）定式。
 *
 * 每一步都可由规则推出：
 *   - 舰船是直线 → 非直线连通块矛盾；直线舰段的侧向邻格只能是水（否则并成非直线）；
 *   - 舰长必须来自舰队库存 → 可行舰长集合为空即矛盾；
 *   - 已达库存最长舰长 → 任何延伸/合并都会超长，端点必须封水；
 *   - 两端封死的独立舰段：封闭时舰长已定，必须精确命中某个库存舰长；
 *     必须变长时，一端最多贡献「该端连续空格数」，不够的部分只能由另一端强制延伸；
 *     所有独立舰段必须能一一分配给互不重复的库存舰长。
 */
function segmentRules(
  cells: Int8Array | number[],
  fleet: number[],
  w: number,
  h: number,
  set: SetFn,
): boolean {
  const fleetLengths = fleet.filter((L) => L > 0)
  if (!fleetLengths.length) return true
  const maxFleet = Math.max(...fleetLengths)
  const comps = shipComponents(cells, w, h)
  if (!comps.length) return true

  interface Segment {
    length: number
    minLen: number
    maxLen: number
    closed: boolean
  }
  const segments: Segment[] = []

  for (const comp of comps) {
    const len = comp.length
    if (len > maxFleet) return false
    let axis = -1
    if (len >= 2) {
      if (!isStraight(comp, w)) return false
      const y0 = (comp[0]! / w) | 0
      axis = comp.every((i) => ((i / w) | 0) === y0) ? 0 : 1
    }

    let ends: EndInfo[]
    if (axis === 0) {
      let minX = w
      let maxX = -1
      for (const i of comp) {
        const x = i % w
        if (x < minX) minX = x
        if (x > maxX) maxX = x
      }
      const y = (comp[0]! / w) | 0
      ends = [endInfo(cells, w, h, minX, y, -1, 0), endInfo(cells, w, h, maxX, y, 1, 0)]
      for (const i of comp) {
        const x = i % w
        const yy = (i / w) | 0
        for (let d = -1; d <= 1; d += 2) {
          const ny = yy + d
          if (ny < 0 || ny >= h) continue
          const j = ny * w + x
          if (cells[j] === SHIP) return false
          if (cells[j] === EMPTY && !set(j, WATER, 'adj')) return false
        }
      }
    } else if (axis === 1) {
      let minY = h
      let maxY = -1
      for (const i of comp) {
        const y = (i / w) | 0
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
      const x = comp[0]! % w
      ends = [endInfo(cells, w, h, x, minY, 0, -1), endInfo(cells, w, h, x, maxY, 0, 1)]
      for (const i of comp) {
        const x = i % w
        const yy = (i / w) | 0
        for (let d = -1; d <= 1; d += 2) {
          const nx = x + d
          if (nx < 0 || nx >= w) continue
          const j = yy * w + nx
          if (cells[j] === SHIP) return false
          if (cells[j] === EMPTY && !set(j, WATER, 'adj')) return false
        }
      }
    } else {
      const x = comp[0]! % w
      const y = (comp[0]! / w) | 0
      ends = [
        endInfo(cells, w, h, x, y, -1, 0),
        endInfo(cells, w, h, x, y, 1, 0),
        endInfo(cells, w, h, x, y, 0, -1),
        endInfo(cells, w, h, x, y, 0, 1),
      ]
    }

    // 已达库存最长舰长：任何延伸/合并都会超长 → 所有可延伸方向的紧邻格封水
    if (len === maxFleet) {
      if (axis === 0) {
        const y = (comp[0]! / w) | 0
        let minX = w
        let maxX = -1
        for (const i of comp) {
          const x = i % w
          if (x < minX) minX = x
          if (x > maxX) maxX = x
        }
        if (ends[0]!.run > 0 && !set(y * w + minX - 1, WATER, 'seg')) return false
        if (ends[1]!.run > 0 && !set(y * w + maxX + 1, WATER, 'seg')) return false
      } else if (axis === 1) {
        const x = comp[0]! % w
        let minY = h
        let maxY = -1
        for (const i of comp) {
          const y = (i / w) | 0
          if (y < minY) minY = y
          if (y > maxY) maxY = y
        }
        if (ends[0]!.run > 0 && !set((minY - 1) * w + x, WATER, 'seg')) return false
        if (ends[1]!.run > 0 && !set((maxY + 1) * w + x, WATER, 'seg')) return false
      } else {
        const x = comp[0]! % w
        const y = (comp[0]! / w) | 0
        if (ends[0]!.run > 0 && !set(y * w + x - 1, WATER, 'seg')) return false
        if (ends[1]!.run > 0 && !set(y * w + x + 1, WATER, 'seg')) return false
        if (ends[2]!.run > 0 && !set((y - 1) * w + x, WATER, 'seg')) return false
        if (ends[3]!.run > 0 && !set((y + 1) * w + x, WATER, 'seg')) return false
      }
    }

    const isolated = ends.every((e) => e.sealed)
    if (!isolated) continue

    const runs = ends.map((e) => e.run)
    let feasible: number[]
    if (axis >= 0) {
      const hi = len + runs[0]! + runs[1]!
      feasible = fleetLengths.filter((L) => L >= len && L <= hi)
    } else {
      const hHi = 1 + runs[0]! + runs[1]!
      const vHi = 1 + runs[2]! + runs[3]!
      const hs = fleetLengths.filter((L) => L <= hHi)
      const vs = fleetLengths.filter((L) => L <= vHi)
      feasible = hs.slice()
      for (const L of vs) if (!feasible.includes(L)) feasible.push(L)
      // 单格：某轴连 2 格舰段都不可能 → 该轴两个邻格必须是水
      if (hs.length === 0 || Math.max(...hs) < 2) {
        if (runs[0]! > 0 && !set(comp[0]! - 1, WATER, 'seg')) return false
        if (runs[1]! > 0 && !set(comp[0]! + 1, WATER, 'seg')) return false
      }
      if (vs.length === 0 || Math.max(...vs) < 2) {
        if (runs[2]! > 0 && !set(comp[0]! - w, WATER, 'seg')) return false
        if (runs[3]! > 0 && !set(comp[0]! + w, WATER, 'seg')) return false
      }
    }
    if (!feasible.length) return false

    const minLen = Math.min(...feasible)
    const maxLen = Math.max(...feasible)
    if (axis === 0) {
      const y = (comp[0]! / w) | 0
      let minX = w
      let maxX = -1
      for (const i of comp) {
        const x = i % w
        if (x < minX) minX = x
        if (x > maxX) maxX = x
      }
      if (maxLen === len) {
        if (runs[0]! > 0 && !set(y * w + minX - 1, WATER, 'seg')) return false
        if (runs[1]! > 0 && !set(y * w + maxX + 1, WATER, 'seg')) return false
      } else if (minLen > len) {
        const d = minLen - len
        const needLeft = d - runs[1]!
        const needRight = d - runs[0]!
        for (let k = 0; k < needLeft; k++) {
          if (!set(y * w + minX - 1 - k, SHIP, 'seg')) return false
        }
        for (let k = 0; k < needRight; k++) {
          if (!set(y * w + maxX + 1 + k, SHIP, 'seg')) return false
        }
      }
    } else if (axis === 1) {
      const x = comp[0]! % w
      let minY = h
      let maxY = -1
      for (const i of comp) {
        const y = (i / w) | 0
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
      if (maxLen === len) {
        if (runs[0]! > 0 && !set((minY - 1) * w + x, WATER, 'seg')) return false
        if (runs[1]! > 0 && !set((maxY + 1) * w + x, WATER, 'seg')) return false
      } else if (minLen > len) {
        const d = minLen - len
        const needUp = d - runs[1]!
        const needDown = d - runs[0]!
        for (let k = 0; k < needUp; k++) {
          if (!set((minY - 1 - k) * w + x, SHIP, 'seg')) return false
        }
        for (let k = 0; k < needDown; k++) {
          if (!set((maxY + 1 + k) * w + x, SHIP, 'seg')) return false
        }
      }
    } else {
      // 单格：只有一根轴可行且必须变长 → 沿该轴强制延伸
      const hHi = 1 + runs[0]! + runs[1]!
      const vHi = 1 + runs[2]! + runs[3]!
      const hOk = fleetLengths.some((L) => L <= hHi)
      const vOk = fleetLengths.some((L) => L <= vHi)
      if (minLen > 1 && hOk !== vOk) {
        const x = comp[0]! % w
        const y = (comp[0]! / w) | 0
        const d = minLen - 1
        if (hOk) {
          const needLeft = d - runs[1]!
          const needRight = d - runs[0]!
          for (let k = 0; k < needLeft; k++) {
            if (!set(y * w + x - 1 - k, SHIP, 'seg')) return false
          }
          for (let k = 0; k < needRight; k++) {
            if (!set(y * w + x + 1 + k, SHIP, 'seg')) return false
          }
        } else {
          const needUp = d - runs[3]!
          const needDown = d - runs[2]!
          for (let k = 0; k < needUp; k++) {
            if (!set((y - 1 - k) * w + x, SHIP, 'seg')) return false
          }
          for (let k = 0; k < needDown; k++) {
            if (!set((y + 1 + k) * w + x, SHIP, 'seg')) return false
          }
        }
      }
    }

    segments.push({
      length: len,
      minLen,
      maxLen,
      closed: runs.every((r) => r === 0),
    })
  }

  // 独立舰段 ↔ 舰队库存 一一匹配（可证明的计数约束）
  const used = new Uint8Array(fleetLengths.length)
  const exacts = segments.filter((s) => s.closed).sort((a, b) => b.length - a.length)
  for (const seg of exacts) {
    let pick = -1
    for (let k = 0; k < fleetLengths.length; k++) {
      if (!used[k] && fleetLengths[k] === seg.length) {
        pick = k
        break
      }
    }
    if (pick < 0) return false
    used[pick] = 1
  }
  const opens = segments.filter((s) => !s.closed).sort((a, b) => a.maxLen - b.maxLen)
  for (const seg of opens) {
    let pick = -1
    for (let k = 0; k < fleetLengths.length; k++) {
      if (used[k]) continue
      const L = fleetLengths[k]!
      if (L < seg.minLen || L > seg.maxLen) continue
      if (pick < 0 || L < fleetLengths[pick]!) pick = k
    }
    if (pick < 0) return false
    used[pick] = 1
  }
  return true
}

/**
 * 最长舰唯一位置定式。
 *
 * 舰队里只有一艘最长舰（长度 maxLen）时，它必然占据盘面上一段连续的 maxLen 格。
 * 枚举它所有「仍然可能」的摆放位置：
 *   - 格子不能已是水；
 *   - 横向摆放要求该行舰格数 ≥ maxLen，纵向要求该列舰格数 ≥ maxLen；
 *   - 舰格外的一圈（正交 + 斜向）不能已有舰格，否则会并成一艘更长的船或斜向接触。
 * 枚举出来的是真实摆放位置的超集，所以：
 *   - 一个位置都没有 → 矛盾；
 *   - 所有位置都覆盖的格子 → 必然是舰格（可证明）。
 *
 * 注：行/列剩余容量条件等价于 sum 规则已经保证的「非水格数 ≥ 该行/列舰格数」，
 * 这里不再重复检查。大棋盘（> 20×20）跳过，避免枚举拖慢自定义大盘面。
 */
function longestShipRule(
  cells: Int8Array | number[],
  fleet: number[],
  rowSums: number[],
  colSums: number[],
  w: number,
  h: number,
  set: SetFn,
): boolean {
  if (w * h > 400) return true
  const fleetLengths = fleet.filter((L) => L > 0)
  if (!fleetLengths.length) return true
  const maxLen = Math.max(...fleetLengths)
  let maxCount = 0
  for (const L of fleetLengths) if (L === maxLen) maxCount++
  if (maxCount !== 1) return true
  if (maxLen > w && maxLen > h) return false
  const size = w * h

  const fits = (list: number[]): boolean => {
    const inPlace = new Set(list)
    for (const c of list) {
      if (cells[c] === WATER) return false
      const x = c % w
      const y = (c / w) | 0
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue
          const nx = x + dx
          const ny = y + dy
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
          const j = ny * w + nx
          if (inPlace.has(j)) continue
          if (cells[j] === SHIP) return false
        }
      }
    }
    return true
  }

  const placements: number[][] = []
  if (maxLen <= w) {
    for (let y = 0; y < h; y++) {
      if ((rowSums[y] ?? 0) < maxLen) continue
      for (let x0 = 0; x0 + maxLen <= w; x0++) {
        const list: number[] = []
        for (let k = 0; k < maxLen; k++) list.push(y * w + x0 + k)
        if (fits(list)) placements.push(list)
      }
    }
  }
  if (maxLen <= h) {
    for (let x = 0; x < w; x++) {
      if ((colSums[x] ?? 0) < maxLen) continue
      for (let y0 = 0; y0 + maxLen <= h; y0++) {
        const list: number[] = []
        for (let k = 0; k < maxLen; k++) list.push((y0 + k) * w + x)
        if (fits(list)) placements.push(list)
      }
    }
  }

  if (!placements.length) return false
  const hits = new Uint16Array(size)
  for (const list of placements) for (const c of list) hits[c]!++
  for (let c = 0; c < size; c++) {
    if (hits[c] === placements.length && cells[c] === EMPTY) {
      if (!set(c, SHIP, 'place')) return false
    }
  }
  return true
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

  const set: SetFn = (i, value, kind) => {
    if (cells[i] === value) return true
    if (cells[i] !== EMPTY) return false
    cells[i] = value
    onSet?.(i, value, kind)
    changed = true
    return true
  }

  // 总格数守恒：每艘船的每一格在行和、列和各计一次
  if (rowSums.length === h && colSums.length === w) {
    let rowTotal = 0
    for (let y = 0; y < h; y++) rowTotal += rowSums[y] ?? 0
    let colTotal = 0
    for (let x = 0; x < w; x++) colTotal += colSums[x] ?? 0
    if (rowTotal !== total || colTotal !== total) return false
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

    // 舰段定式 + 舰队库存匹配 + 最长舰唯一位置
    if (!segmentRules(cells, fleet, w, h, set)) return false
    if (!longestShipRule(cells, fleet, rowSums, colSums, w, h, set)) return false
  }

  return true
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
