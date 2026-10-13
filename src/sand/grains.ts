export const WORD = 'sand'
const FONT_WEIGHT = 900
const FONT_STACK = '"Fraunces Variable", Fraunces, Georgia, "Times New Roman", serif'

export const TEX_W = 512

export interface GrainLayout {
  count: number
  texW: number
  texH: number
  /** per texel: home x, home y, layer (0 bottom .. 1 top), diameter in css px (0 = unused) */
  home: Float32Array
  /** grains per css px² inside the letters */
  density: number
  fontPx: number
  /** ink bounds of the word in css px */
  box: { x: number; y: number; w: number; h: number }
  /** coarse "is there sand near here" map for the audio, 8 css px cells */
  sand: { w: number; h: number; cell: number; data: Float32Array }
}

export async function loadWordFont(): Promise<void> {
  try {
    await document.fonts.load(`${FONT_WEIGHT} 100px "Fraunces Variable"`, WORD)
  } catch {
    // fall back to whatever serif is available
  }
}

function hash2i(x: number, y: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

function valueNoise(x: number, y: number): number {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const xf = x - xi
  const yf = y - yi
  const u = xf * xf * (3 - 2 * xf)
  const v = yf * yf * (3 - 2 * yf)
  const a = hash2i(xi, yi)
  const b = hash2i(xi + 1, yi)
  const c = hash2i(xi, yi + 1)
  const d = hash2i(xi + 1, yi + 1)
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v
}

function boxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h)
  const out = new Float32Array(w * h)
  const inv = 1 / (2 * r + 1)
  const cx = (v: number) => (v < 0 ? 0 : v >= w ? w - 1 : v)
  const cy = (v: number) => (v < 0 ? 0 : v >= h ? h - 1 : v)
  for (let y = 0; y < h; y++) {
    const row = y * w
    let acc = 0
    for (let k = -r; k <= r; k++) acc += src[row + cx(k)]
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc * inv
      acc += src[row + cx(x + r + 1)] - src[row + cx(x - r)]
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0
    for (let k = -r; k <= r; k++) acc += tmp[cy(k) * w + x]
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc * inv
      acc += tmp[cy(y + r + 1) * w + x] - tmp[cy(y - r) * w + x]
    }
  }
  return out
}

function makeRng(seed: number) {
  let s = seed >>> 0 || 1
  return () => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    return (s >>> 0) / 4294967296
  }
}

export function layoutGrains(viewW: number, viewH: number, maxGrains: number, grainsPerPx: number): GrainLayout {
  const cw = Math.max(1, Math.ceil(viewW))
  const ch = Math.max(1, Math.ceil(viewH))
  const canvas = document.createElement('canvas')
  canvas.width = cw
  canvas.height = ch
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('2d context unavailable')

  ctx.font = `${FONT_WEIGHT} 100px ${FONT_STACK}`
  if ('letterSpacing' in ctx) ctx.letterSpacing = '-1px'
  const m = ctx.measureText(WORD)
  const inkW = m.actualBoundingBoxLeft + m.actualBoundingBoxRight
  const inkH = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent
  const fontPx = 100 * Math.min((viewW * 0.8) / inkW, (viewH * 0.5) / inkH)

  ctx.font = `${FONT_WEIGHT} ${fontPx}px ${FONT_STACK}`
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${(-0.01 * fontPx).toFixed(2)}px`
  const mt = ctx.measureText(WORD)
  const w = mt.actualBoundingBoxLeft + mt.actualBoundingBoxRight
  const h = mt.actualBoundingBoxAscent + mt.actualBoundingBoxDescent
  const x = (cw - w) / 2 + mt.actualBoundingBoxLeft
  const y = (ch - h) / 2 + mt.actualBoundingBoxAscent - ch * 0.015
  ctx.fillStyle = '#fff'
  ctx.fillText(WORD, x, y)

  const pad = 8
  const x0 = Math.max(0, Math.floor(x - mt.actualBoundingBoxLeft) - pad)
  const x1 = Math.min(cw, Math.ceil(x + mt.actualBoundingBoxRight) + pad)
  const y0 = Math.max(0, Math.floor(y - mt.actualBoundingBoxAscent) - pad)
  const y1 = Math.min(ch, Math.ceil(y + mt.actualBoundingBoxDescent) + pad)
  const bw = x1 - x0
  const bh = y1 - y0
  const pixels = ctx.getImageData(x0, y0, bw, bh).data
  const alpha = new Float32Array(bw * bh)
  let area = 0
  for (let i = 0; i < bw * bh; i++) {
    const a = pixels[i * 4 + 3] / 255
    alpha[i] = a
    area += a
  }
  // a soft ramp across each edge, so the outline can wander a little like poured sand
  const soft = boxBlur(boxBlur(alpha, bw, bh, 2), bw, bh, 2)

  const sampleSoft = (px: number, py: number) => {
    const fx = px - x0 - 0.5
    const fy = py - y0 - 0.5
    const ix = Math.floor(fx)
    const iy = Math.floor(fy)
    if (ix < 0 || iy < 0 || ix >= bw - 1 || iy >= bh - 1) return 0
    const tx = fx - ix
    const ty = fy - iy
    const i = iy * bw + ix
    const a = soft[i] + (soft[i + 1] - soft[i]) * tx
    const b = soft[i + bw] + (soft[i + bw + 1] - soft[i + bw]) * tx
    return a + (b - a) * ty
  }

  // jittered grid: as random as sand, but without the clumps and holes of pure noise
  const target = Math.min(maxGrains * 0.97, Math.round(area * grainsPerPx))
  const spacing = Math.sqrt(area / Math.max(1, target))
  const rand = makeRng(0x5a4d)
  const cols = Math.ceil(bw / spacing)
  const rows = Math.ceil(bh / spacing)
  const xs: number[] = []
  const ys: number[] = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const px = x0 + (c + rand()) * spacing
      const py = y0 + (r + rand()) * spacing
      const s = sampleSoft(px, py)
      if (s <= 0.02) continue
      const wobble = valueNoise(px * 0.21, py * 0.21) - 0.5 + 0.5 * (valueNoise(px * 0.63, py * 0.63) - 0.5)
      const t = s + 0.36 * wobble
      const keep = t >= 0.5 ? 1 : 0.06 * (s / 0.5) * (s / 0.5)
      if (rand() < keep) {
        xs.push(px)
        ys.push(py)
      }
    }
  }

  const count = Math.min(xs.length, maxGrains)
  // shuffle so draw order is random and no scanline structure shows through overlaps
  const order = new Uint32Array(xs.length)
  for (let i = 0; i < order.length; i++) order[i] = i
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    const t = order[i]
    order[i] = order[j]
    order[j] = t
  }

  const texW = TEX_W
  const texH = Math.max(1, Math.ceil(count / texW))
  const home = new Float32Array(texW * texH * 4)
  for (let i = 0; i < count; i++) {
    const k = order[i]
    const size = 1.0 + 1.6 * Math.pow(rand(), 1.7)
    home[i * 4] = xs[k]
    home[i * 4 + 1] = ys[k]
    home[i * 4 + 2] = rand()
    home[i * 4 + 3] = size
  }

  const cell = 8
  const sw = Math.ceil(cw / cell)
  const sh = Math.ceil(ch / cell)
  const raw = new Float32Array(sw * sh)
  for (let py = 0; py < bh; py++) {
    for (let px = 0; px < bw; px++) {
      const a = alpha[py * bw + px]
      if (a > 0) raw[(((py + y0) / cell) | 0) * sw + (((px + x0) / cell) | 0)] += a / (cell * cell)
    }
  }
  const sand = new Float32Array(sw * sh)
  const reach = 2
  for (let cy = 0; cy < sh; cy++) {
    for (let cx = 0; cx < sw; cx++) {
      let best = 0
      for (let oy = -reach; oy <= reach; oy++) {
        const yy = cy + oy
        if (yy < 0 || yy >= sh) continue
        for (let ox = -reach; ox <= reach; ox++) {
          const xx = cx + ox
          if (xx < 0 || xx >= sw) continue
          const v = raw[yy * sw + xx]
          if (v > best) best = v
        }
      }
      sand[cy * sw + cx] = Math.min(1, best * 1.5)
    }
  }

  return {
    count,
    texW,
    texH,
    home,
    density: count / Math.max(1, area),
    fontPx,
    box: { x: x - mt.actualBoundingBoxLeft, y: y - mt.actualBoundingBoxAscent, w, h },
    sand: { w: sw, h: sh, cell, data: sand },
  }
}
