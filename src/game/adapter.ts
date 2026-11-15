/**
 * ════════════════════════════════════════════════════════════════════
 *  战舰（Battleships）—— 游戏适配器
 * ════════════════════════════════════════════════════════════════════
 *
 * 状态用 0/1/2：0 = 未定，1 = 战舰，2 = 水。
 */

import { playDrop, playPluck } from '../core/audio'
import type { CustomSupport, GameAdapter, Move, Puzzle, SolveResult } from '../core/types'
import { planLogicSolve } from './logic'
import { builtinPuzzles, getReferenceSolution } from './puzzles'
import { hitTest, metricsFor, renderBoard } from './render'
import { countSolutions, solvePuzzle } from './solver'
import {
  applyMove,
  cloneState,
  createEmptyState,
  cycleValue,
  deserializeState,
  firstHintMove,
  invertMove,
  rightClickValue,
  serializeState,
  valueAt,
} from './state'
import { statusBits, validate } from './validate'
import { SHIP, decodeBoard, encodeBoard, type BattleshipPuzzle } from './types'

const meta = {
  title: '战舰',
  tagline: '按舰队数量布置战舰 —— 战舰不能互相接触',
  footerNote:
    '规则：按下方舰队数量放置直线战舰；战舰之间不能上下左右或斜向相邻；盘外数字表示该行/列被战舰占据的格子数。',
  storageKeyPrefix: 'battleships',
  customIdPrefix: 'battleships-custom-',
  customMinW: 5,
  customMinH: 5,
  customMaxW: 35,
  customMaxH: 35,
  targetKind: 'cell' as const,
}

/** 默认舰队：长度 1 有 maxL 艘，长度 k 有 maxL-k+1 艘，最长 1 艘 */
function fleetForMaxLength(maxL: number): number[] {
  const fleet: number[] = []
  for (let len = 1; len <= maxL; len++) {
    for (let count = 0; count < maxL - len + 1; count++) fleet.push(len)
  }
  return fleet
}

function readNumberList(id: string, count: number, max: number, fallback: number[]): number[] {
  const el = document.getElementById(id) as HTMLTextAreaElement | null
  const raw = el?.value.trim() ?? ''
  const vals = raw ? raw.split(/[\s,，]+/).filter(Boolean).map(Number) : []
  const out: number[] = []
  for (let i = 0; i < count; i++) {
    const n = Number.isFinite(vals[i]) ? vals[i]! : fallback[i] ?? 0
    out.push(Math.max(0, Math.min(max, Math.round(n))))
  }
  return out
}

const custom: CustomSupport = {
  mode: 'cell',
  valueCycle: [null, SHIP, 2],
  keyForDigit: (digit) => {
    if (digit === 0) return null
    if (digit === SHIP) return SHIP
    if (digit === 2) return 2
    return undefined
  },
  cellLabel: (v) => (v === SHIP ? '舰' : v === 2 ? '水' : ''),
  cellClass: (v) => (v === SHIP ? 'v-ship' : v === 2 ? 'v-water' : ''),
  hint: '网格涂出题面给定的舰格/水格（可空），再在下方输入行列舰格数与最大舰长。',

  extras: {
    html: () => `
      <div class="custom-extras-grid">
        <label>最大舰长
          <select id="custom-max-ship">${[1,2,3,4,5,6,7,8,9,10].map((n) => `<option value="${n}"${n === 10 ? ' selected' : ''}>${n}</option>`).join('')}</select>
        </label>
        <label>行舰格数（从上到下）
          <textarea id="custom-row-sums" rows="2" spellcheck="false"></textarea>
        </label>
        <label>列舰格数（从左到右）
          <textarea id="custom-col-sums" rows="2" spellcheck="false"></textarea>
        </label>
        <div class="custom-hint" id="custom-fleet-hint"></div>
      </div>`,
    mount: (panel, _ctl) => {
      const sel = panel.querySelector('#custom-max-ship') as HTMLSelectElement | null
      const hint = panel.querySelector('#custom-fleet-hint') as HTMLElement | null
      const update = (): void => {
        if (!hint) return
        const maxL = Math.max(1, Math.min(10, Number(sel?.value) || 10))
        const fleet = fleetForMaxLength(maxL)
        hint.textContent = `默认舰队：${fleet.length} 艘，总格数 ${fleet.reduce((a, b) => a + b, 0)}；长度 1×${maxL}，…，长度 ${maxL}×1。`
      }
      sel?.addEventListener('change', update)
      update()
    },
    reset: (ctl) => {
      const r = document.getElementById('custom-row-sums') as HTMLTextAreaElement | null
      const c = document.getElementById('custom-col-sums') as HTMLTextAreaElement | null
      if (r) r.value = new Array<number>(ctl.height).fill(0).join(' ')
      if (c) c.value = new Array<number>(ctl.width).fill(0).join(' ')
    },
    load: (p) => {
      const bp = p as BattleshipPuzzle
      const fleet = bp.fleet ?? []
      const maxL = fleet.length ? Math.max(...fleet) : 10
      const sel = document.getElementById('custom-max-ship') as HTMLSelectElement | null
      if (sel) sel.value = String(maxL)
      const r = document.getElementById('custom-row-sums') as HTMLTextAreaElement | null
      const c = document.getElementById('custom-col-sums') as HTMLTextAreaElement | null
      if (r) r.value = (bp.rowSums ?? []).join(' ')
      if (c) c.value = (bp.colSums ?? []).join(' ')
    },
  },

  toGrid: (p) => {
    const bp = p as BattleshipPuzzle
    if (!Array.isArray(bp.givens) || bp.givens.length !== p.width * p.height) return null
    return {
      width: p.width,
      height: p.height,
      grid: bp.givens.map((v) => (v === SHIP ? SHIP : v === 2 ? 2 : null)),
    }
  },

  makePuzzle: (w, h, grid, existingId) => {
    const sel = document.getElementById('custom-max-ship') as HTMLSelectElement | null
    const maxL = Math.max(1, Math.min(10, Number(sel?.value) || 10))
    const fleet = fleetForMaxLength(maxL)
    const givens = grid.map((v) => (v === SHIP ? SHIP : v === 2 ? 2 : 0))
    const rowSums = readNumberList('custom-row-sums', h, w, new Array<number>(h).fill(0))
    const colSums = readNumberList('custom-col-sums', w, h, new Array<number>(w).fill(0))
    return {
      id: existingId ?? `${meta.customIdPrefix}${w}x${h}-${Date.now()}`,
      name: `自定义 · ${w}×${h} · 最长 ${maxL}`,
      width: w,
      height: h,
      difficulty: 'custom',
      fleet,
      givens,
      rowSums,
      colSums,
    } satisfies BattleshipPuzzle
  },

  encodePuzzle: (p) => {
    const bp = p as BattleshipPuzzle
    return { board: encodeBoard(bp.givens ?? [], bp.fleet ?? [], bp.rowSums ?? [], bp.colSums ?? []) }
  },

  decodePuzzle: (record) => {
    if (typeof record.id !== 'string') return null
    if (typeof record.width !== 'number' || typeof record.height !== 'number') return null
    const w = record.width
    const h = record.height
    if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) return null
    if (typeof record.board !== 'string') return null
    const decoded = decodeBoard(record.board, w * h, w, h)
    if (!decoded) return null
    return {
      id: record.id,
      name: typeof record.name === 'string' ? record.name : `自定义 · ${w}×${h}`,
      width: w,
      height: h,
      difficulty: 'custom',
      givens: decoded.givens,
      fleet: decoded.fleet,
      rowSums: decoded.rowSums,
      colSums: decoded.colSums,
    } satisfies BattleshipPuzzle
  },

  audit: (p) => {
    const bp = p as BattleshipPuzzle
    const w = bp.width
    const h = bp.height
    if (w * h > 400) return { ok: true, message: '大盘面跳过唯一解校验。' }
    const out = countSolutions(bp.givens ?? [], bp.fleet ?? [], bp.rowSums ?? [], bp.colSums ?? [], w * h, w, h, 2, 300_000)
    if (out.timedOut) return { ok: true, message: '唯一解校验超时，仍可保存。' }
    if (out.count === 0) return { ok: false, message: '当前舰队/行列数字无解。' }
    if (out.count > 1) return { ok: true, message: '注意：当前题面存在多个解。' }
    return { ok: true, message: '唯一解 ✓。' }
  },
}


function playForMove(move: Move, streak: number): void {
  if (move.to === SHIP) playPluck(streak, 1.1)
  else playDrop(streak)
}

export const adapter: GameAdapter = {
  meta,
  builtinPuzzles,
  getReferenceSolution,
  createEmptyState,
  cloneState,
  cycleValue,
  rightClickValue,
  applyMove,
  invertMove,
  valueAt,
  serializeState,
  deserializeState,
  validate,
  statusBits,
  metricsFor,
  renderBoard,
  hitTest,
  planLogicSolve,
  solvePuzzle: (puzzle: Puzzle, maxNodes?: number): SolveResult => solvePuzzle(puzzle, maxNodes),
  firstHintMove,
  custom,
  playForMove,
}
