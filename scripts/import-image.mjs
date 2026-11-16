/**
 * 战舰（Battleships）题面图片导入（自动识图 + 数字 OCR + 舰队图例识别）
 *
 * 用法：
 *   node scripts/import-image.mjs <图片路径>
 *        [--size N | --width W --height H]
 *        [--name 名称] [--id ID] [--series 分组]
 *        [--rows "a,b,…"] [--cols "a,b,…"] [--fleet "9,8,8,…"]
 *        [--givens "…"] [--map 修正.json] [--solution "…"]
 *        [--append] [--verify] [--solve] [--dry] [--force]
 *
 * 识图原理：
 *   1. Playwright + Edge 把图片画进 canvas，逐像素取亮度/颜色；
 *   2. 用「最长连续深色笔画」找横竖网格线（题板边框最粗、内部网格线最细，
 *      若有更粗的内部线会被识别为「粗线分块」仅作提示，不影响解题数据）；
 *   3. 由首尾网格线中心等分得到 nCols×nRows 个格子，逐格取中心区域：
 *      深色占比高 → 给定舰格（1）；浅蓝占比高 → 给定水格（2）；否则空（0）；
 *   4. 盘外数字用「多字体模板匹配」OCR：左侧=行和、上方=列和；
 *   5. 右侧舰队图例：方块=一艘该长度舰船、空心框=该长度的条数，由此还原 fleet；
 *   6. 生成项目现有 RawPuzzle 格式（board = 预填|舰队|行和|列和），
 *      默认只预览；--append 写入 src/game/imported-puzzles.ts（npm run gen 不会覆盖）；
 *   7. --verify 用项目求解器做唯一解检查（30×30 大题常超时，只警告）；
 *      --solve 用项目求解器尝试求一组解并写入 solution（超时只警告）。
 *
 * 识别不确定时：--dump 打印逐格识别结果，用 --map 修正个别格子，
 * 或直接用 --rows/--cols/--fleet/--givens 覆盖。
 *
 * 说明：本图里的「粗线分块」不是战舰规则的一部分，只作为题板装饰提示；
 * 脚本会报告粗线条数，但不会把它们当成规则数据。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

import { countSolutions, solvePuzzle } from '../src/game/solver.ts'
import { isValidSolution, propagate, solveByRules } from '../src/game/rules.ts'
import {
  EMPTY,
  SHIP,
  WATER,
  decodeBoard,
  decodeCells,
  encodeBoard,
  encodeCells,
} from '../src/game/types.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EDGE_PATH =
  process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'

/* ───────────────────────── 命令行参数 ───────────────────────── */

const VALUE_OPTS = new Set([
  '--size',
  '--width',
  '--height',
  '--name',
  '--id',
  '--series',
  '--difficulty',
  '--rows',
  '--cols',
  '--fleet',
  '--givens',
  '--map',
  '--solution',
  '--max-nodes',
  '--solve-nodes',
])

const opts = new Map()
const positional = []
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a.startsWith('--')) {
    if (VALUE_OPTS.has(a)) opts.set(a, argv[++i])
    else opts.set(a, true)
  } else {
    positional.push(a)
  }
}
const arg = (name, fallback = null) => (opts.has(name) ? opts.get(name) : fallback)
const has = (name) => opts.has(name)

const imageArg = positional[0]
if (!imageArg) {
  console.error(
    [
      '用法：node scripts/import-image.mjs <图片路径> [--size N | --width W --height H]',
      '      [--name 名称] [--id ID] [--series 分组]',
      '      [--rows "a,b,…"] [--cols "a,b,…"] [--fleet "9,8,8,…"]',
      '      [--givens "…"] [--map 修正.json] [--solution "…"]',
      '      [--append] [--verify] [--solve] [--dry] [--force] [--max-nodes N]',
    ].join('\n'),
  )
  process.exit(1)
}

const imagePath = path.resolve(process.cwd(), imageArg)
if (!existsSync(imagePath)) {
  console.error(`[import] 找不到图片：${imagePath}`)
  process.exit(1)
}

const sizeOpt = Number(arg('--size', '0')) || 0
const widthOpt = Number(arg('--width', '0')) || 0
const heightOpt = Number(arg('--height', '0')) || 0
const name = String(arg('--name', path.basename(imagePath, path.extname(imagePath))))
const id = String(arg('--id', `battleships-import-${Date.now().toString(36)}`))
const series = String(arg('--series', '导入'))
const difficulty = String(arg('--difficulty', 'custom'))
const append = has('--append')
const verify = has('--verify')
const solveRequested = has('--solve')
const dry = has('--dry')
const force = has('--force')
const maxNodes = Math.max(1000, Number(arg('--max-nodes', '300000')) || 300000)
const solveNodes = Math.max(1000, Number(arg('--solve-nodes', '1500000')) || 1500000)

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
}
const mime = MIME[path.extname(imagePath).toLowerCase()] || 'image/png'
const dataUrl = `data:${mime};base64,${readFileSync(imagePath).toString('base64')}`

/* ───────────────────────── 浏览器内识图 ───────────────────────── */

const browser = await chromium.launch({ headless: true, executablePath: EDGE_PATH })
const page = await browser.newPage()
await page.setContent('<!doctype html><canvas id="c"></canvas>')

const analyzed = await page.evaluate(async ({ dataUrl }) => {
  const img = new Image()
  img.src = dataUrl
  await img.decode()
  const W = img.naturalWidth
  const H = img.naturalHeight
  const cv = document.getElementById('c')
  cv.width = W
  cv.height = H
  const ctx = cv.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(img, 0, 0)
  const px = ctx.getImageData(0, 0, W, H).data

  const lumAt = (x, y) => {
    const i = (y * W + x) * 4
    return 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]
  }
  const inkAt = (x, y) => {
    const xi = x < 0 ? 0 : x >= W ? W - 1 : x
    const yi = y < 0 ? 0 : y >= H ? H - 1 : y
    const i = (yi * W + xi) * 4
    const l = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]
    return Math.max(0, Math.min(1, (255 - l) / 255))
  }
  const rgbAt = (x, y) => {
    const i = (y * W + x) * 4
    return [px[i], px[i + 1], px[i + 2]]
  }
  const isDark = (x, y) => lumAt(x, y) < 100

  const clampInt = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)

  /* ── 1) 找网格线：每列/每行最长连续深色笔画 ── */
  const colRun = new Int32Array(W)
  const colRunY = new Int32Array(W) // 最长笔画起点
  for (let x = 0; x < W; x++) {
    let run = 0
    let start = 0
    for (let y = 0; y < H; y++) {
      if (isDark(x, y)) {
        if (run === 0) start = y
        run++
        if (run > colRun[x]) {
          colRun[x] = run
          colRunY[x] = start
        }
      } else run = 0
    }
  }
  const rowRun = new Int32Array(H)
  const rowRunX = new Int32Array(H)
  for (let y = 0; y < H; y++) {
    let run = 0
    let start = 0
    for (let x = 0; x < W; x++) {
      if (isDark(x, y)) {
        if (run === 0) start = x
        run++
        if (run > rowRun[y]) {
          rowRun[y] = run
          rowRunX[y] = start
        }
      } else run = 0
    }
  }

  const groupBands = (arr, thr) => {
    const out = []
    for (let i = 0; i < arr.length; i++) {
      if (arr[i] < thr) continue
      let j = i
      while (j + 1 < arr.length && arr[j + 1] >= thr) j++
      out.push({ start: i, end: j, center: (i + j) / 2, width: j - i + 1 })
      i = j
    }
    return out
  }

  const med = (arr) => {
    if (!arr.length) return 0
    const s = arr.slice().sort((a, b) => a - b)
    return s[Math.floor(s.length / 2)]
  }

  // 竖线候选：足够长的竖直笔画；再用「同一段 y 范围」筛掉图例/装饰
  let vCand = groupBands(colRun, Math.max(24, H * 0.22))
  let hCand = groupBands(rowRun, Math.max(24, W * 0.22))
  if (!vCand.length || !hCand.length) {
    return { error: '没找到题板网格线，请确认图片是战舰（Battleships）题面' }
  }
  const ySpans = vCand.map((b) => {
    const x = Math.round(b.center)
    const ys = colRunY[x]
    return { x, y0: ys, y1: ys + colRun[x] - 1 }
  })
  const xSpans = hCand.map((b) => {
    const y = Math.round(b.center)
    const xs = rowRunX[y]
    return { y, x0: xs, x1: xs + rowRun[y] - 1 }
  })
  const topMed = med(ySpans.map((s) => s.y0))
  const botMed = med(ySpans.map((s) => s.y1))
  const leftMed = med(xSpans.map((s) => s.x0))
  const rightMed = med(xSpans.map((s) => s.x1))
  const near = (a, b) => Math.abs(a - b) <= Math.max(6, H * 0.02)
  const nearX = (a, b) => Math.abs(a - b) <= Math.max(6, W * 0.02)
  const vLines = vCand.filter(
    (b) => near(ySpans[vCand.indexOf(b)].y0, topMed) && near(ySpans[vCand.indexOf(b)].y1, botMed),
  )
  const hLines = hCand.filter(
    (b) => nearX(xSpans[hCand.indexOf(b)].x0, leftMed) && nearX(xSpans[hCand.indexOf(b)].x1, rightMed),
  )
  if (vLines.length < 3 || hLines.length < 3) {
    return {
      error: `网格线数量异常：竖线 ${vLines.length} 条、横线 ${hLines.length} 条；可用 --width/--height 指定尺寸后再试`,
    }
  }

  const nCols = vLines.length - 1
  const nRows = hLines.length - 1
  const xL = vLines[0].center
  const xR = vLines[vLines.length - 1].center
  const yT = hLines[0].center
  const yB = hLines[hLines.length - 1].center
  const cellW = (xR - xL) / nCols
  const cellH = (yB - yT) / nRows

  // 网格线均匀性（粗线会让中心略微偏移，允许 25% 格距误差）
  const vGaps = []
  for (let i = 1; i < vLines.length; i++) vGaps.push(vLines[i].center - vLines[i - 1].center)
  const hGaps = []
  for (let i = 1; i < hLines.length; i++) hGaps.push(hLines[i].center - hLines[i - 1].center)
  const skew = Math.max(
    ...vGaps.map((g) => Math.abs(g - cellW) / cellW),
    ...hGaps.map((g) => Math.abs(g - cellH) / cellH),
  )

  // 粗线分块：内部网格线明显比中位线宽 → 视为题板「粗线分块」装饰
  const innerV = vLines.slice(1, -1)
  const innerH = hLines.slice(1, -1)
  const thinV = med(innerV.map((b) => b.width))
  const thinH = med(innerH.map((b) => b.width))
  const thickV = innerV
    .filter((b) => b.width >= Math.max(3, thinV * 2 + 1))
    .map((b) => Math.round(((b.center - xL) / cellW) * 10) / 10)
  const thickH = innerH
    .filter((b) => b.width >= Math.max(3, thinH * 2 + 1))
    .map((b) => Math.round(((b.center - yT) / cellH) * 10) / 10)

  /* ── 2) 逐格分类：给定舰格 / 给定水格 / 空 ── */
  const total = nCols * nRows
  const givens = new Array(total).fill(0)
  const uncertain = []
  const box = 0.3 // 取格子中心 ±30% 区域，避开网格线与图标边框
  const darkFracs = []
  const blueFracs = []
  for (let r = 0; r < nRows; r++) {
    for (let c = 0; c < nCols; c++) {
      const cx = xL + (c + 0.5) * cellW
      const cy = yT + (r + 0.5) * cellH
      const hw = Math.max(3, cellW * box)
      const hh = Math.max(3, cellH * box)
      const x0 = clampInt(Math.round(cx - hw), 0, W - 1)
      const x1 = clampInt(Math.round(cx + hw), 0, W - 1)
      const y0 = clampInt(Math.round(cy - hh), 0, H - 1)
      const y1 = clampInt(Math.round(cy + hh), 0, H - 1)
      let dark = 0
      let blue = 0
      let n = 0
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          n++
          if (isDark(x, y)) dark++
          else {
            const [rr, gg, bb] = rgbAt(x, y)
            if (bb > 185 && bb - rr > 35 && rr < 215 && gg > 120) blue++
          }
        }
      }
      const darkFrac = dark / n
      const blueFrac = blue / n
      const idx = r * nCols + c
      darkFracs.push(darkFrac)
      if (blueFrac > 0.5) givens[idx] = 2
      else if (darkFrac > 0.5) givens[idx] = 1
      else givens[idx] = 0
      if (darkFrac > 0.15 && darkFrac <= 0.62) uncertain.push([c, r, 'dark', +darkFrac.toFixed(2)])
      else if (blueFrac > 0.2 && blueFrac <= 0.55) uncertain.push([c, r, 'blue', +blueFrac.toFixed(2)])
      else if (blueFrac > 0.5 && darkFrac > 0.3) uncertain.push([c, r, 'both', +darkFrac.toFixed(2)])
    }
  }

  /* ── 3) 盘外数字 OCR（多字体模板匹配） ── */
  const N = 20
  const bitmapFromImage = (minX, minY, maxX, maxY) => {
    const bw = maxX - minX + 1
    const bh = maxY - minY + 1
    const bm = new Float32Array(N * N)
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        let sum = 0
        for (let sy = 0; sy < 2; sy++) {
          for (let sx = 0; sx < 2; sx++) {
            const fx = minX + (i + (sx + 0.5) / 2) * (bw / N)
            const fy = minY + (j + (sy + 0.5) / 2) * (bh / N)
            sum += inkAt(Math.round(fx), Math.round(fy))
          }
        }
        bm[j * N + i] = sum / 4
      }
    }
    return bm
  }
  const bitmapDiff = (a, b) => {
    let s = 0
    for (let i = 0; i < N * N; i++) s += Math.abs(a[i] - b[i])
    return s / (N * N)
  }

  const compsIn = (x0, x1, y0, y1) => {
    const bx0 = clampInt(x0, 0, W - 1)
    const bx1 = clampInt(x1, 0, W - 1)
    const by0 = clampInt(y0, 0, H - 1)
    const by1 = clampInt(y1, 0, H - 1)
    const w = bx1 - bx0 + 1
    const h = by1 - by0 + 1
    const seen = new Uint8Array(w * h)
    const out = []
    for (let yy = 0; yy < h; yy++) {
      for (let xx = 0; xx < w; xx++) {
        const k = yy * w + xx
        if (seen[k] || !isDark(bx0 + xx, by0 + yy)) continue
        let n = 0
        let minX = xx
        let maxX = xx
        let minY = yy
        let maxY = yy
        let rs = 0
        let gs = 0
        let bs = 0
        const st = [[yy, xx]]
        seen[k] = 1
        while (st.length) {
          const [cy, cx] = st.pop()
          n++
          const [pr, pg, pb] = rgbAt(bx0 + cx, by0 + cy)
          rs += pr
          gs += pg
          bs += pb
          if (cx < minX) minX = cx
          if (cx > maxX) maxX = cx
          if (cy < minY) minY = cy
          if (cy > maxY) maxY = cy
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const ny = cy + dy
              const nx = cx + dx
              if (ny < 0 || nx < 0 || ny >= h || nx >= w) continue
              const nk = ny * w + nx
              if (seen[nk] || !isDark(bx0 + nx, by0 + ny)) continue
              seen[nk] = 1
              st.push([ny, nx])
            }
          }
        }
        out.push({
          n,
          minX: bx0 + minX,
          minY: by0 + minY,
          maxX: bx0 + maxX,
          maxY: by0 + maxY,
          w: maxX - minX + 1,
          h: maxY - minY + 1,
          r: rs / n,
          g: gs / n,
          b: bs / n,
        })
      }
    }
    return out
  }

  const glyphSizeFilter = (arr) =>
    arr.filter(
      (c) =>
        c.n >= 12 &&
        c.h >= cellH * 0.18 &&
        c.h <= cellH * 0.92 &&
        c.w >= cellW * 0.1 &&
        c.w <= cellW * 0.9,
    )

  const rowBand = { x0: Math.round(xL - cellW * 1.35), x1: Math.round(xL - 3), y0: Math.round(yT), y1: Math.round(yB) }
  const colBand = { x0: Math.round(xL), x1: Math.round(xR), y0: Math.round(yT - cellH * 1.15), y1: Math.round(yT - 3) }
  const rowGlyphs = glyphSizeFilter(compsIn(rowBand.x0, rowBand.x1, rowBand.y0, rowBand.y1))
  const colGlyphs = glyphSizeFilter(compsIn(colBand.x0, colBand.x1, colBand.y0, colBand.y1))

  // 行数字右对齐贴着左边框、列数字下沿贴着上边框。先按「公共对齐边」筛掉左侧行号、
  // 上方列标等装饰；不够时再退回「按行分组后取离题板最近的一段」。
  const splitByGap = (items, gap, axis) => {
    const runs = []
    if (!items.length) return runs
    let cur = [items[0]]
    for (let i = 1; i < items.length; i++) {
      const prev = cur[cur.length - 1]
      const gapPx = axis === 'x' ? items[i].minX - prev.maxX : items[i].minY - prev.maxY
      if (gapPx > gap) {
        runs.push(cur)
        cur = [items[i]]
      } else cur.push(items[i])
    }
    runs.push(cur)
    return runs
  }
  const keepEdgeRun = (items, gap, axis) => {
    const sorted = items.slice().sort((a, b) => (axis === 'x' ? a.minX - b.minX : a.minY - b.minY))
    const runs = splitByGap(sorted, gap, axis)
    return runs.length ? runs[runs.length - 1] : []
  }
  const clusterMode = (vals, tol) => {
    let best = null
    for (const v of vals) {
      const count = vals.reduce((a, u) => a + (Math.abs(u - v) <= tol ? 1 : 0), 0)
      if (!best || count > best.count) best = { v, count }
    }
    return best
  }
  const groupBy = (arr, key, tol) => {
    const sorted = arr.slice().sort((a, b) => a[key] - b[key])
    const lines = []
    for (const c of sorted) {
      const last = lines[lines.length - 1]
      if (last && Math.abs(c[key] - last.avg) <= tol) {
        last.items.push(c)
        last.avg = last.items.reduce((s, m) => s + m[key], 0) / last.items.length
      } else lines.push({ avg: c[key], items: [c] })
    }
    return lines
  }
  const buildClues = (glyphs, axis) => {
    const isRow = axis === 'row'
    const key = isRow ? 'cy' : 'cx' // 分组键：行按 y，列按 x
    const tol = (isRow ? cellH : cellW) * 0.4
    const items = glyphs.map((g) => ({ ...g, cy: (g.minY + g.maxY) / 2, cx: (g.minX + g.maxX) / 2 }))
    const expected = isRow ? nRows : nCols

    // 方案 A：按公共对齐边过滤（行=右对齐 maxX，列=下对齐 maxY）；
    // 两位数的十位离对齐边约 0.4 格，所以容差要放宽到 0.6 格，再逐行取最近的一段。
    const edges = items.map((g) => (isRow ? g.maxX : g.maxY))
    const mode = clusterMode(edges, 3)
    let linesA = []
    if (mode) {
      const limit = (isRow ? cellW : cellH) * 0.6
      const filtered = items.filter((g) => Math.abs((isRow ? g.maxX : g.maxY) - mode.v) <= limit)
      linesA = groupBy(filtered, key, tol)
        .map((l) => {
          const run = keepEdgeRun(l.items, (isRow ? cellW : cellH) * 0.55, isRow ? 'x' : 'y')
          const sorted = run.slice().sort((a, b) => a.minX - b.minX)
          return {
            avg: sorted.reduce((s, m) => s + m[key], 0) / Math.max(1, sorted.length),
            items: sorted,
          }
        })
        .filter((l) => l.items.length)
    }
    // 方案 B：分组后每组只保留离题板最近的一段
    let linesB = groupBy(items, key, tol).map((l) => {
      const run = keepEdgeRun(l.items, (isRow ? cellW : cellH) * 0.55, isRow ? 'x' : 'y')
      const sorted = run.slice().sort((a, b) => a.minX - b.minX)
      return {
        avg: sorted.reduce((s, m) => s + m[key], 0) / Math.max(1, sorted.length),
        items: sorted,
      }
    })
    linesB = linesB.filter((l) => l.items.length)
    let lines = linesB
    let method = 'gap'
    if (linesA.length === expected) {
      lines = linesA
      method = 'align'
    } else if (linesB.length !== expected && Math.abs(linesA.length - expected) < Math.abs(linesB.length - expected)) {
      lines = linesA
      method = 'align(近似)'
    }
    return { lines, method }
  }
  const rowBuilt = buildClues(rowGlyphs, 'row')
  const colBuilt = buildClues(colGlyphs, 'col')
  const rowLines = rowBuilt.lines
  const colLines = colBuilt.lines

  // 模板：多字体 × 粗细，每个数字单独渲染后取包围盒
  const fonts = [
    'Arial',
    'Arial Black',
    'Helvetica',
    'Verdana',
    'Tahoma',
    'Trebuchet MS',
    'Segoe UI',
    'Calibri',
    'Franklin Gothic Medium',
    'Liberation Sans',
    'DejaVu Sans',
    'Noto Sans',
  ]
  const tcv = document.createElement('canvas')
  tcv.width = 220
  tcv.height = 220
  const tg = tcv.getContext('2d', { willReadFrequently: true })
  const templateBitmap = (digit, font, weight, size) => {
    tg.fillStyle = '#fff'
    tg.fillRect(0, 0, 220, 220)
    tg.fillStyle = '#000'
    tg.font = `${weight} ${size}px "${font}"`
    tg.textBaseline = 'top'
    tg.fillText(String(digit), 10, 10)
    const td = tg.getImageData(0, 0, 220, 220).data
    const ink = (x, y) => {
      const xi = x < 0 ? 0 : x >= 220 ? 219 : x
      const yi = y < 0 ? 0 : y >= 220 ? 219 : y
      const i = (yi * 220 + xi) * 4
      const l = 0.299 * td[i] + 0.587 * td[i + 1] + 0.114 * td[i + 2]
      return Math.max(0, Math.min(1, (255 - l) / 255))
    }
    let minX = 220
    let maxX = -1
    let minY = 220
    let maxY = -1
    for (let y = 0; y < 220; y++) {
      for (let x = 0; x < 220; x++) {
        if (ink(x, y) > 0.35) {
          if (x < minX) minX = x
          if (x > maxX) maxX = x
          if (y < minY) minY = y
          if (y > maxY) maxY = y
        }
      }
    }
    if (maxX < 0) return null
    const bw = maxX - minX + 1
    const bh = maxY - minY + 1
    const bm = new Float32Array(N * N)
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        let sum = 0
        for (let sy = 0; sy < 2; sy++) {
          for (let sx = 0; sx < 2; sx++) {
            const fx = minX + (i + (sx + 0.5) / 2) * (bw / N)
            const fy = minY + (j + (sy + 0.5) / 2) * (bh / N)
            sum += ink(Math.round(fx), Math.round(fy))
          }
        }
        bm[j * N + i] = sum / 4
      }
    }
    return bm
  }

  const allGlyphs = [...rowGlyphs, ...colGlyphs]
  const glyphBitmaps = allGlyphs.map((g) => bitmapFromImage(g.minX, g.minY, g.maxX, g.maxY))
  let bestFont = null
  for (const font of fonts) {
    for (const weight of ['bold', 'normal']) {
      const templates = []
      let ok = true
      for (let d = 0; d <= 9; d++) {
        const bm = templateBitmap(d, font, weight, 96)
        if (!bm) {
          ok = false
          break
        }
        templates.push(bm)
      }
      if (!ok) continue
      let totalDiff = 0
      for (const gbm of glyphBitmaps) {
        let m = Infinity
        for (const t of templates) m = Math.min(m, bitmapDiff(gbm, t))
        totalDiff += m
      }
      const avg = totalDiff / Math.max(1, glyphBitmaps.length)
      if (!bestFont || avg < bestFont.avg) bestFont = { name: `${font} ${weight}`, templates, avg }
    }
  }
  if (!bestFont) return { error: '数字 OCR 模板渲染失败' }
  const digitOf = (bm) => {
    let best = -1
    let bestDiff = Infinity
    bestFont.templates.forEach((t, i) => {
      const diff = bitmapDiff(bm, t)
      if (diff < bestDiff) {
        bestDiff = diff
        best = i
      }
    })
    return { digit: best, diff: bestDiff }
  }
  const readLines = (lines, key) =>
    lines.map((line) => {
      const items = line.items.slice().sort((a, b) => a.minX - b.minX)
      const ds = items.map((c) => digitOf(bitmapFromImage(c.minX, c.minY, c.maxX, c.maxY)))
      let value = 0
      for (const d of ds) value = value * 10 + d.digit
      return {
        value,
        worst: ds.reduce((a, d) => Math.max(a, d.diff), 0),
        avg: (line.avg ?? (line.items[0]?.[key] ?? 0)),
        digits: ds.length,
      }
    })

  const rowClues = readLines(rowLines, 'cy')
  const colClues = readLines(colLines, 'cx')
  const rowClueIndex = rowLines.map((l) => Math.round((l.avg - yT) / cellH - 0.5))
  const colClueIndex = colLines.map((l) => Math.round((l.avg - xL) / cellW - 0.5))

  /* ── 4) 右侧舰队图例：实心方块 = 舰长，空心框 = 条数 ── */
  let legend = { rows: [], cell: 0, ok: false, note: '' }
  const legendRegion = {
    x0: Math.round(xR + cellW * 0.25),
    x1: W - 1,
    y0: Math.round(yT - cellH * 0.6),
    y1: H - 1,
  }
  {
    const comps = compsIn(legendRegion.x0, legendRegion.x1, legendRegion.y0, legendRegion.y1).filter(
      (c) => c.n >= 40 && (c.maxX - c.minX + 1) >= 12 && (c.maxY - c.minY + 1) >= 12,
    )
    const greenish = (c) => c.g > c.r + 25 && c.g > c.b + 25
    const squares = []
    const boxes = []
    for (const c of comps) {
      if (greenish(c)) continue // 图例里的绿色对勾（已完成的条数）
      const fill = c.n / (c.w * c.h)
      // 实心舰船：单个方块，或（抗锯齿粘连时）多个方块合成一条宽矩形
      if (fill > 0.55 && c.w >= 14 && c.h >= 12 && c.w >= c.h * 0.8 && c.w <= c.h * 16) {
        squares.push(c)
      } else if (fill < 0.45 && c.w >= 12 && c.h >= 12 && c.w / c.h > 0.65 && c.w / c.h < 1.55) {
        boxes.push(c)
      }
    }
    if (squares.length) {
      const squareLike = squares.filter((c) => c.w <= c.h * 1.45)
      const legendCell = med(
        (squareLike.length ? squareLike : squares).map((c) => (c.w + c.h) / 2),
      )
      const rowMap = new Map()
      const put = (c, kind) => {
        const cy = (c.minY + c.maxY) / 2
        let key = null
        for (const k of rowMap.keys()) {
          if (Math.abs(k - cy) <= Math.max(legendCell * 0.55, 6)) {
            key = k
            break
          }
        }
        const k = key === null ? cy : key
        if (!rowMap.has(k)) rowMap.set(k, { cy: k, ships: [], boxes: [] })
        rowMap.get(k)[kind].push(c)
      }
      for (const c of squares) put(c, 'ships')
      for (const c of boxes) put(c, 'boxes')
      const rows = [...rowMap.values()]
        .sort((a, b) => a.cy - b.cy)
        .map((row) => {
          const ships = row.ships.sort((a, b) => a.minX - b.minX)
          const boxesRow = row.boxes.sort((a, b) => a.minX - b.minX)
          // 分段式图例：每格一个方块；粘连成宽条时按宽度折算格数
          let len = 0
          for (const c of ships) {
            const units = c.w / legendCell
            len += units <= 1.45 ? 1 : Math.max(2, Math.round(units))
          }
          return {
            len,
            count: boxesRow.length,
            shipCount: ships.length,
            cy: Math.round(row.cy),
            barW: ships.length ? ships[ships.length - 1].maxX - ships[0].minX + 1 : 0,
            barH: ships.length ? med(ships.map((c) => c.h)) : 0,
            xs: ships.map((c) => c.minX),
          }
        })
      legend = {
        rows,
        cell: Math.round(legendCell * 10) / 10,
        ok: rows.length >= 1,
        note: '',
        squareCount: squares.length,
        boxCount: boxes.length,
        sample: squares.map((c) => [c.minX, c.minY, c.w, c.h, +(c.n / (c.w * c.h)).toFixed(2)]),
        rawSample: comps
          .filter((c) => c.minY < 230)
          .map((c) => [c.minX, c.minY, c.w, c.h, +(c.n / (c.w * c.h)).toFixed(2), c.r | 0, c.g | 0, c.b | 0]),
      }
    } else {
      legend.note = '未找到右侧舰队图例（实心方块+空心框）'
    }
  }

  return {
    W,
    H,
    nCols,
    nRows,
    xL,
    xR,
    yT,
    yB,
    cellW,
    cellH,
    skew,
    thickV,
    thickH,
    thinV,
    thinH,
    givens,
    uncertain,
    darkFracs,
    rowClues,
    colClues,
    rowClueIndex,
    colClueIndex,
    rowBand,
    colBand,
    font: bestFont.name,
    fontAvg: bestFont.avg,
    legend,
    total,
  }
}, { dataUrl })

await browser.close()

if (analyzed.error) {
  console.error(`[import] ${analyzed.error}`)
  process.exit(1)
}

let w = sizeOpt || widthOpt || analyzed.nCols
let h = sizeOpt || heightOpt || analyzed.nRows
if (w !== analyzed.nCols || h !== analyzed.nRows) {
  console.error(
    `[import] 网格不匹配：识别到 ${analyzed.nCols}×${analyzed.nRows}，目标 ${w}×${h}` +
      '（如果识别尺寸不准，先用 --dry 查看，确认图片确实是战舰题面）',
  )
  process.exit(1)
}

console.log(
  `[import] ${path.basename(imagePath)}：${analyzed.W}×${analyzed.H}px，题板 ${w}×${h}，` +
    `格距 ${analyzed.cellW.toFixed(2)}×${analyzed.cellH.toFixed(2)}px，网格线偏差 ${(analyzed.skew * 100).toFixed(1)}%`,
)
if (analyzed.thickV.length || analyzed.thickH.length) {
  console.log(
    `[import] 粗线分块（仅装饰，不参与规则）：竖线 ${analyzed.thickV.length} 条 @${JSON.stringify(analyzed.thickV)}，` +
      `横线 ${analyzed.thickH.length} 条 @${JSON.stringify(analyzed.thickH)}`,
  )
} else {
  console.log('[import] 粗线分块：未发现明显更粗的内部网格线')
}
const givenShip = analyzed.givens.filter((v) => v === SHIP).length
const givenWater = analyzed.givens.filter((v) => v === WATER).length
console.log(`[import] 给定格：舰格 ${givenShip} 个、水格 ${givenWater} 个`)
if (analyzed.uncertain.length) {
  console.log(
    `[import] 分类存疑的格子 ${analyzed.uncertain.length} 个（可用 --dump 查看后 --map 修正）：` +
      JSON.stringify(analyzed.uncertain.slice(0, 12)) +
      (analyzed.uncertain.length > 12 ? ' …' : ''),
  )
}

// 数字 OCR 质量
const clueItems = [...analyzed.rowClues, ...analyzed.colClues]
const clueWorst = clueItems.reduce((a, c) => Math.max(a, c.worst), 0)
console.log(
  `[import] 数字 OCR：字体猜测 ${analyzed.font}（平均误差 ${analyzed.fontAvg.toFixed(4)}），` +
    `最大单字误差 ${clueWorst.toFixed(4)}`,
)
if (clueWorst > 0.3) {
  console.warn(
    '[import] 警告：有数字的模板匹配误差偏大，行列和可能读错；' +
      '请核对预览里的行/列数字，必要时用 --rows/--cols 覆盖',
  )
}
{
  const rowIdx = new Set(analyzed.rowClueIndex.filter((i) => i >= 0 && i < h))
  const colIdx = new Set(analyzed.colClueIndex.filter((i) => i >= 0 && i < w))
  if (analyzed.rowClues.length !== h || rowIdx.size !== h) {
    console.warn(
      `[import] 警告：识别到 ${analyzed.rowClues.length} 组行数字（覆盖 ${rowIdx.size}/${h} 行），` +
        '可用 --rows 手动指定',
    )
  }
  if (analyzed.colClues.length !== w || colIdx.size !== w) {
    console.warn(
      `[import] 警告：识别到 ${analyzed.colClues.length} 组列数字（覆盖 ${colIdx.size}/${w} 列），` +
        '可用 --cols 手动指定',
    )
  }
  console.log(`[import] OCR 行和：${analyzed.rowClues.map((r) => r.value).join(',')}`)
  console.log(`[import] OCR 列和：${analyzed.colClues.map((c) => c.value).join(',')}`)
}

/* ───────────────────────── 舰队图例 → fleet ───────────────────────── */

const parseNumList = (text) =>
  String(text)
    .split(/[,，\s]+/)
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n))

const fleetForMaxLength = (maxL) => {
  const out = []
  for (let len = 1; len <= maxL; len++) for (let k = 0; k < maxL - len + 1; k++) out.push(len)
  return out
}

const legendRows = analyzed.legend.rows
let fleet = []
let fleetSource = ''
if (legendRows.length) {
  const lens = legendRows.map((r) => r.len)
  const counts = legendRows.map((r) => r.count)
  const descending = lens.every((v, i) => i === 0 || v === lens[i - 1] - 1)
  const withCount = legendRows.every((r) => r.len >= 1 && r.count >= 1)
  const legendFleet = []
  for (const r of legendRows) for (let k = 0; k < r.count; k++) legendFleet.push(r.len)
  const totalLex = legendFleet.reduce((a, b) => a + b, 0)
  const maxL = lens[0]
  const patternFleet = fleetForMaxLength(maxL)
  const patternTotal = patternFleet.reduce((a, b) => a + b, 0)
  if (has('--debug')) {
    console.log('[import][debug] 图例原始行：' + JSON.stringify(legendRows))
    console.log(
      '[import][debug] 图例方块/框数量：' +
        JSON.stringify({ squares: analyzed.legend.squareCount, boxes: analyzed.legend.boxCount }),
    )
    console.log('[import][debug] 图例方块样本：' + JSON.stringify(analyzed.legend.sample))
    console.log('[import][debug] 图例原始连通域：' + JSON.stringify(analyzed.legend.rawSample))
  }
  console.log(
    `[import] 舰队图例：${legendRows.length} 行（` +
      legendRows.map((r) => `${r.len}×${r.count}`).join(', ') +
      `），格宽 ${analyzed.legend.cell}px` +
      (descending && withCount ? '' : '，⚠ 行序/条数不规整'),
  )
  if (descending && withCount && totalLex === patternTotal) {
    fleet = legendFleet
    fleetSource = '舰队图例'
  } else if (descending && withCount) {
    // 图例条数与默认「最长 maxL 的递增舰队」不符时，以图例为准并提示
    fleet = legendFleet
    fleetSource = '舰队图例（与默认递增模式不同）'
  } else {
    console.log('[import] 图例不规整，回退到按总格数推导舰队')
  }
}

const sumRowsPre = analyzed.rowClues.map((r) => r.value).reduce((a, b) => a + b, 0)
const sumColsPre = analyzed.colClues.map((c) => c.value).reduce((a, b) => a + b, 0)

if (!fleet.length) {
  const totalCells = Math.max(sumRowsPre, sumColsPre)
  let maxL = 0
  for (let L = 1; L <= Math.max(w, h); L++) {
    const t = (L * (L + 1) * (L + 2)) / 6
    if (t === totalCells) {
      maxL = L
      break
    }
  }
  if (maxL) {
    fleet = fleetForMaxLength(maxL)
    fleetSource = `按总格数 ${totalCells} 推导（最长 ${maxL}）`
  }
}

if (!fleet.length) {
  const fallback = parseNumList(arg('--fleet', ''))
  if (fallback.length) {
    fleet = fallback
    fleetSource = '--fleet'
  }
}

/* ───────────────────────── 覆盖与修正 ───────────────────────── */

let givens = analyzed.givens.slice()
let rowSums = analyzed.rowClues.map((r) => r.value)
let colSums = analyzed.colClues.map((c) => c.value)

if (arg('--rows', '')) {
  rowSums = parseNumList(arg('--rows', ''))
  console.log('[import] 使用 --rows 覆盖行和')
}
if (arg('--cols', '')) {
  colSums = parseNumList(arg('--cols', ''))
  console.log('[import] 使用 --cols 覆盖列和')
}
if (arg('--fleet', '')) {
  fleet = parseNumList(arg('--fleet', ''))
  fleetSource = '--fleet'
}
if (arg('--givens', '')) {
  const text = String(arg('--givens', '')).trim()
  if (text.length !== w * h) {
    console.error(`[import] --givens 长度 ${text.length} ≠ ${w * h}`)
    process.exit(1)
  }
  givens = [...text].map((ch) => {
    if (ch === '1' || ch === 'S' || ch === 's' || ch === '#') return SHIP
    if (ch === '2' || ch === 'W' || ch === 'w' || ch === '~') return WATER
    return EMPTY
  })
  console.log('[import] 使用 --givens 覆盖给定格')
}

const mapFile = arg('--map', '')
if (mapFile) {
  // 支持 --map 修正.json 或直接 --map '{"rows":[…]}"' 内联 JSON
  const rawMap = String(mapFile)
  let map
  if (rawMap.trim().startsWith('{')) {
    try {
      map = JSON.parse(rawMap)
    } catch (err) {
      console.error(`[import] --map 内联 JSON 不合法：${err.message}`)
      process.exit(1)
    }
  } else {
    const mapPath = path.resolve(process.cwd(), rawMap)
    if (!existsSync(mapPath)) {
      console.error(`[import] 找不到 --map 文件：${mapPath}`)
      process.exit(1)
    }
    try {
      map = JSON.parse(readFileSync(mapPath, 'utf8'))
    } catch (err) {
      console.error(`[import] --map 文件不是合法 JSON：${err.message}`)
      process.exit(1)
    }
  }
  if (map.width && Number(map.width) !== w) {
    console.error(`[import] --map width=${map.width} 与题板宽 ${w} 不符`)
    process.exit(1)
  }
  if (map.height && Number(map.height) !== h) {
    console.error(`[import] --map height=${map.height} 与题板高 ${h} 不符`)
    process.exit(1)
  }
  if (map.rows !== undefined) {
    rowSums = Array.isArray(map.rows) ? map.rows.map(Number) : parseNumList(map.rows)
    console.log('[import] --map 覆盖行和')
  }
  if (map.cols !== undefined) {
    colSums = Array.isArray(map.cols) ? map.cols.map(Number) : parseNumList(map.cols)
    console.log('[import] --map 覆盖列和')
  }
  if (map.fleet !== undefined) {
    fleet = Array.isArray(map.fleet) ? map.fleet.map(Number) : parseNumList(map.fleet)
    fleetSource = '--map'
    console.log('[import] --map 覆盖舰队')
  }
  if (map.givens !== undefined) {
    let text = ''
    if (typeof map.givens === 'string') text = map.givens.replace(/\s+/g, '')
    else if (Array.isArray(map.givens)) text = map.givens.join('')
    if (text.length !== w * h) {
      console.error(`[import] --map givens 长度 ${text.length} ≠ ${w * h}`)
      process.exit(1)
    }
    givens = [...text].map((ch) => {
      if (ch === '1' || ch === 'S' || ch === 's' || ch === '#') return SHIP
      if (ch === '2' || ch === 'W' || ch === 'w' || ch === '~') return WATER
      return EMPTY
    })
    console.log('[import] --map 覆盖给定格')
  }
}

const size = w * h

console.log(
  `[import] 最终给定格：舰格 ${givens.filter((v) => v === SHIP).length} 个、` +
    `水格 ${givens.filter((v) => v === WATER).length} 个`,
)

/* ───────────────────────── 一致性校验 ───────────────────────── */

const fail = (msg) => {
  console.error(`[import] ${msg}`)
  process.exit(1)
}

if (!Array.isArray(fleet) || !fleet.length) {
  fail('没能确定舰队组成；请用 --fleet "9,8,8,7,7,7,…" 手动指定（长度列表，每个元素一艘船）')
}
if (fleet.some((v) => !Number.isInteger(v) || v < 1 || v > Math.max(w, h))) {
  fail(`舰队长度非法：${JSON.stringify(fleet)}`)
}
if (rowSums.length !== h) fail(`行和数量 ${rowSums.length} ≠ 行数 ${h}（可用 --rows 覆盖）`)
if (colSums.length !== w) fail(`列和数量 ${colSums.length} ≠ 列数 ${w}（可用 --cols 覆盖）`)
if (givens.length !== size) fail(`给定格数量 ${givens.length} ≠ ${size}`)
if (rowSums.some((v) => !Number.isInteger(v) || v < 0 || v > w)) fail(`行和含非法值：${JSON.stringify(rowSums)}`)
if (colSums.some((v) => !Number.isInteger(v) || v < 0 || v > h)) fail(`列和含非法值：${JSON.stringify(colSums)}`)

const fleetTotal = fleet.reduce((a, b) => a + b, 0)
const rowTotal = rowSums.reduce((a, b) => a + b, 0)
const colTotal = colSums.reduce((a, b) => a + b, 0)
console.log(
  `[import] 舰队：${fleet.length} 艘 / ${fleetTotal} 格（来源：${fleetSource || '未知'}）；` +
    `行和合计 ${rowTotal}，列和合计 ${colTotal}`,
)
if (rowTotal !== colTotal) {
  fail(
    `行和合计 ${rowTotal} ≠ 列和合计 ${colTotal}：数字 OCR 可能读错，` +
      '请用 --rows/--cols 或 --map 修正后再 --append',
  )
}
if (fleetTotal !== rowTotal) {
  fail(
    `舰队总格数 ${fleetTotal} ≠ 行列和合计 ${rowTotal}：舰队/数字识别可能不对，` +
      '请用 --fleet 或 --rows/--cols 修正',
  )
}

// 给定格与规则的一致性
const givenShipCells = []
for (let i = 0; i < size; i++) if (givens[i] === SHIP) givenShipCells.push(i)
if (givenShipCells.length > fleetTotal) fail(`给定舰格 ${givenShipCells.length} 超过舰队总格数 ${fleetTotal}`)
for (let i = 0; i < size; i++) {
  if (givens[i] !== SHIP) continue
  const x = i % w
  const y = (i / w) | 0
  for (const [dx, dy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const nx = x + dx
    const ny = y + dy
    if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
    if (givens[ny * w + nx] === SHIP) {
      fail(`给定舰格在 (${x},${y}) 与 (${nx},${ny}) 斜向相邻，违反规则；可能是识别误判`)
    }
  }
}
for (let y = 0; y < h; y++) {
  let cnt = 0
  for (let x = 0; x < w; x++) if (givens[y * w + x] === SHIP) cnt++
  if (cnt > rowSums[y]) fail(`第 ${y + 1} 行给定舰格 ${cnt} 已超过行和 ${rowSums[y]}`)
}
for (let x = 0; x < w; x++) {
  let cnt = 0
  for (let y = 0; y < h; y++) if (givens[y * w + x] === SHIP) cnt++
  if (cnt > colSums[x]) fail(`第 ${x + 1} 列给定舰格 ${cnt} 已超过列和 ${colSums[x]}`)
}
if (!propagate(givens.slice(), fleet, rowSums, colSums, w, h)) {
  fail('给定格与规则矛盾（传播立即失败），请检查识别结果')
}

// 编码/解码回环：用项目自己的解码函数确认题面可被游戏读取
const board = encodeBoard(givens, fleet, rowSums, colSums)
const round = decodeBoard(board, size, w, h)
if (!round) fail('题面编码后无法用 decodeBoard 解码（内部错误）')
const sameGivens = round.givens.every((v, i) => v === givens[i])
const sameFleet = round.fleet.join(',') === fleet.join(',')
const sameRows = round.rowSums.join(',') === rowSums.join(',')
const sameCols = round.colSums.join(',') === colSums.join(',')
if (!sameGivens || !sameFleet || !sameRows || !sameCols) {
  fail('题面编码/解码回读不一致（内部错误）')
}
console.log('[import] 题面编码回读校验通过（decodeBoard 与识别结果一致）✓')

/* ───────────────────────── 预览 ───────────────────────── */

const CELL_CHAR = ['.', '#', '~'] // 空 / 给定舰格 / 给定水格
console.log(`[import] 题面预览（# = 给定舰格，~ = 给定水格，. = 空；左侧为行和）：`)
for (let y = 0; y < h; y++) {
  let line = ''
  for (let x = 0; x < w; x++) line += CELL_CHAR[givens[y * w + x]]
  console.log(`  ${String(rowSums[y]).padStart(3)}  ${line}`)
}
console.log(`         ${colSums.map((v) => String(v).padStart(3)).join('')}`)

if (has('--dump')) {
  console.log('[import] --dump：逐行给定格（可直接粘贴到 --map 的 givens 数组）')
  for (let y = 0; y < h; y++) {
    let line = ''
    for (let x = 0; x < w; x++) line += ['.', 'S', '~'][givens[y * w + x]] // 也接受 0/1/2
    console.log(`  "${line}",`)
  }
}

if (dry) {
  console.log('[import] --dry：仅识别，不求解、不写入。')
  process.exit(0)
}

/* ───────────────────────── 求解 / 唯一性 ───────────────────────── */

let solution = null
const solutionOverride = arg('--solution', '')
if (solutionOverride) {
  const text = String(solutionOverride).trim()
  const decoded = decodeCells(text, size)
  if (!decoded) fail('--solution 不是合法的解编码串（长度/字符不对）')
  if (decoded.some((v, i) => givens[i] !== EMPTY && v !== givens[i])) {
    fail('--solution 与给定格冲突')
  }
  if (!isValidSolution(decoded, fleet, rowSums, colSums, w, h)) {
    fail('--solution 不满足规则（行列和/舰队/相邻约束）')
  }
  solution = decoded
  console.log('[import] 使用 --solution 提供的参考解（已用项目规则校验通过）✓')
}

const puzzleObj = {
  id,
  name,
  width: w,
  height: h,
  difficulty,
  fleet,
  givens: givens.slice(),
  rowSums: rowSums.slice(),
  colSums: colSums.slice(),
}

if (verify || solveRequested) {
  // 逻辑求解器先跑一遍：快，且能给出解/发现矛盾
  const tRules = Date.now()
  const rules = solveByRules(givens, fleet, rowSums, colSums, size, w, h, true, 240)
  const rulesMs = Date.now() - tRules
  if (rules.contradiction) fail('项目规则引擎判定题面矛盾，请检查识别结果')
  console.log(
    `[import] 规则引擎：${rules.ok ? (rules.saturated ? '逻辑可推满（唯一解）' : '求出一组解') : '无法仅靠规则推满'}，` +
      `${rulesMs}ms`,
  )
  if (!solution && rules.ok && rules.solution) {
    solution = rules.solution
  }

  // 唯一性检查：项目回溯求解器（大盘面常超时，只警告）
  let unique = false
  if (verify) {
    const tCount = Date.now()
    const counted = countSolutions(givens, fleet, rowSums, colSums, size, w, h, 2, maxNodes)
    const countMs = Date.now() - tCount
    if (counted.timedOut) {
      console.warn(
        `[import] 唯一性检查超时（已搜 ${counted.nodes} 节点 / ${countMs}ms，上限 --max-nodes ${maxNodes}），` +
          '无法确认唯一解；只警告，不阻止导入',
      )
    } else if (counted.count === 0) {
      console.error('[import] 无解：行列数字或给定格识别可能有误')
      if (!force) process.exit(1)
    } else if (counted.count >= 2) {
      console.warn(`[import] 解不唯一：至少 ${counted.count} 个（${counted.nodes} 节点 / ${countMs}ms）`)
    } else {
      unique = true
      console.log(`[import] 唯一解检查通过（${counted.nodes} 节点 / ${countMs}ms）✓`)
    }
  }

  // 参考解：--solve 或（--verify 已证明唯一）时，尽量求一组解写入 solution
  if (!solution && (solveRequested || (verify && unique))) {
    const tSolve = Date.now()
    const solved = solvePuzzle(puzzleObj, solveNodes)
    const solveMs = Date.now() - tSolve
    if (solved.timedOut) {
      console.warn(`[import] 求解超时（${solveMs}ms / --solve-nodes ${solveNodes}），本次不写入参考解`)
    } else if (solved.solved && solved.solution) {
      if (!isValidSolution(solved.solution.cells, fleet, rowSums, colSums, w, h)) {
        fail('项目求解器返回的解未通过规则校验（内部错误）')
      }
      solution = solved.solution.cells
      console.log(`[import] 已求出一组参考解（${solved.nodes} 节点 / ${solveMs}ms）`)
    } else {
      console.warn('[import] 项目求解器没有求出解（只警告，仍可导入）')
    }
  }
}

if (solution) {
  if (!isValidSolution(solution, fleet, rowSums, colSums, w, h)) {
    fail('参考解未通过规则校验（内部错误）：不写入 solution')
  }
  if (solution.some((v, i) => givens[i] !== EMPTY && v !== givens[i])) {
    fail('参考解与给定格冲突（内部错误）：不写入 solution')
  }
  console.log('[import] 参考解已通过规则校验，将写入 solution ✓')
}

/* ───────────────────────── 写入 / 预览输出 ───────────────────────── */

const solutionText = solution ? encodeCells(solution) : ''
const entry =
  `  { id: ${JSON.stringify(id)}, name: ${JSON.stringify(name)}, width: ${w}, height: ${h}, ` +
  `difficulty: ${JSON.stringify(difficulty).replace(/"/g, "'")}, series: ${JSON.stringify(series)}, ` +
  `board: ${JSON.stringify(board)}${solutionText ? `, solution: ${JSON.stringify(solutionText)}` : ''} },`

if (!append) {
  console.log('[import] 预览模式（未写入）。board 编码：')
  console.log(JSON.stringify(board))
  if (solutionText) console.log(`[import] 参考解编码（${solutionText.length} 格）：${JSON.stringify(solutionText)}`)
  console.log('[import] 加 --append 可写入 src/game/imported-puzzles.ts')
  process.exit(0)
}

const file = path.join(ROOT, 'src/game/imported-puzzles.ts')
const HEADER =
  '/* 由 scripts/import-image.mjs 追加，npm run gen 不会覆盖。 */\n' +
  "import type { RawPuzzle } from './puzzles-data.ts'\n\n" +
  'export const IMPORTED_PUZZLES: RawPuzzle[] = [\n'

if (!existsSync(file)) {
  writeFileSync(file, `${HEADER}${entry}\n]\n`)
  console.log(`[import] 已创建并写入 ${file}`)
} else {
  let text = readFileSync(file, 'utf8')
  // 同 id 重复导入时替换旧条目，保证脚本可重复运行
  const idRe = new RegExp(`^\\s*\\{ id: ${JSON.stringify(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')},.*\\},?\\s*$`, 'm')
  if (idRe.test(text)) {
    text = text.replace(idRe, entry)
    writeFileSync(file, text)
    console.log(`[import] 已更新同 id 条目：${id}（${file}）`)
  } else if (text.includes('IMPORTED_PUZZLES: RawPuzzle[] = []')) {
    text = text.replace('IMPORTED_PUZZLES: RawPuzzle[] = []', `IMPORTED_PUZZLES: RawPuzzle[] = [\n${entry}\n]`)
    writeFileSync(file, text)
    console.log(`[import] 已写入 ${file}`)
  } else {
    const marker = text.lastIndexOf('\n]')
    if (marker < 0) throw new Error('imported-puzzles.ts 格式异常，找不到数组结尾')
    text = `${text.slice(0, marker + 1)}${entry}\n${text.slice(marker + 1)}`
    writeFileSync(file, text)
    console.log(`[import] 已写入 ${file}`)
  }
  console.log(`[import] 题库 id=${id}，${w}×${h}，${fleet.length} 艘舰船，${solution ? '含参考解' : '无参考解'}`)
  console.log('[import] 提示：npm run build 可验证类型与打包；npm run gen 不会覆盖该文件')
}
