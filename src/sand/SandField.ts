import { createProgram, createTarget, createTexture, type Program } from './gl'
import {
  BLUR_FS,
  COMPOSITE_FS,
  FULLSCREEN_VS,
  GRAIN_FS,
  GRAIN_VS,
  SHADE_FS,
  SIM_FS,
  SPLAT_FS,
  SPLAT_VS,
} from './shaders'
import { layoutGrains, loadWordFont, TEX_W, type GrainLayout } from './grains'
import { SandAudio } from './audio'

interface Vec {
  x: number
  y: number
}

interface Seg {
  a: Vec
  b: Vec
  vx: number
  vy: number
}

interface Synthetic {
  pts: Vec[]
  cum: number[]
  total: number
  dur: number
  t0: number
  done: number
  release: boolean
  resolve: () => void
}

export interface SandDebug {
  /** points in css px relative to the page */
  stroke(points: [number, number][], ms: number, release?: boolean): Promise<void>
  /** points relative to the word's ink box (0..1) */
  strokeRel(points: [number, number][], ms: number, release?: boolean): Promise<void>
  freeze(on: boolean): void
  info(): Record<string, number | string | boolean>
  /** ms per frame for a full sim step + render, synchronised with a pixel readback */
  bench(frames: number, substeps: number): number
}

type ProgName = 'sim' | 'splat' | 'blur' | 'shade' | 'composite' | 'grain'

const CELL = 2 // css px per height-field texel
const MAX_GRAINS = TEX_W * 400
const GRAINS_PER_PX = 0.62
const BLUR_SIGMA_PX = 3.6
const IDLE_DELAY = 1.1 // seconds of stillness before the sand starts to heal
const HEAL_RAMP = 0.6
const HEAL_SNAP = 5.2 // by now every grain is home; snap exactly and go to sleep
const DEPTH = 0.68 // share of the bed the fingertip displaces at its centre

const LIGHT = (() => {
  const v = [-0.5, -0.68, 0.72]
  const l = Math.hypot(v[0], v[1], v[2])
  return [v[0] / l, v[1] / l, v[2] / l] as const
})()
const BG = [0.953, 0.925, 0.871] as const
const BED = [0.74, 0.62, 0.45] as const
const TARGET_FPS = 60

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v))
const smoothstep = (a: number, b: number, v: number) => {
  const t = clamp((v - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}

export function canRunSand(): boolean {
  try {
    const gl = document.createElement('canvas').getContext('webgl2')
    const ok = !!gl && !!gl.getExtension('EXT_color_buffer_float')
    gl?.getExtension('WEBGL_lose_context')?.loseContext()
    return ok
  } catch {
    return false
  }
}

function gaussWeights(sigma: number): Float32Array {
  const w = new Float32Array(5)
  let sum = 0
  for (let i = 0; i < 5; i++) {
    w[i] = Math.exp(-(i * i) / (2 * sigma * sigma))
    sum += i === 0 ? w[i] : 2 * w[i]
  }
  for (let i = 0; i < 5; i++) w[i] /= sum
  return w
}

export class SandField {
  private host: HTMLElement
  private canvas: HTMLCanvasElement
  private gl: WebGL2RenderingContext
  private vao: WebGLVertexArrayObject | null = null
  private progs = {} as Record<ProgName, Program>
  private audio = new SandAudio()
  private ro: ResizeObserver
  private weights = gaussWeights(BLUR_SIGMA_PX / CELL)
  private debugApi: SandDebug | null = null

  private layout: GrainLayout | null = null
  private box = { x: 0, y: 0, w: 1, h: 1 }
  private cssW = 0
  private cssH = 0
  private dpr = 1
  private gridW = 1
  private gridH = 1
  private radius = 18
  private h0 = 7
  private splatWeight = 1

  private homeTex: WebGLTexture | null = null
  private posTex: WebGLTexture[] = []
  private stTex: WebGLTexture[] = []
  private simFbo: WebGLFramebuffer[] = []
  private cur = 0
  private densTex: WebGLTexture | null = null
  private tmpTex: WebGLTexture | null = null
  private heightTex: WebGLTexture | null = null
  private shadeTex: WebGLTexture | null = null
  private densFbo: WebGLFramebuffer | null = null
  private tmpFbo: WebGLFramebuffer | null = null
  private heightFbo: WebGLFramebuffer | null = null
  private shadeFbo: WebGLFramebuffer | null = null

  private down = false
  private pointerId = -1
  private pending: Vec[] = []
  private lastPt: Vec | null = null
  private lastFinger: Vec = { x: 0, y: 0 }
  private speed = 0
  private rectLeft = 0
  private rectTop = 0

  private raf = 0
  private lastNow = 0
  private lastRaf = 0
  private vsyncMs = 1000 / 60
  private tick = 0
  private time = 0
  private lastActive = -1e9
  private healStart = -1
  private dirty = false
  private frozen = false
  private frozenFrames = 0
  private ready = false
  private disposed = false
  private resizeTimer = 0
  private synth: Synthetic | null = null
  private frameDts: number[] = []
  private rebuilds = 0

  constructor(host: HTMLElement) {
    this.host = host
    const canvas = document.createElement('canvas')
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    canvas.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;' +
      '-webkit-user-select:none;user-select:none;opacity:0;' +
      (reduceMotion ? '' : 'transition:opacity 900ms ease-out;')
    host.appendChild(canvas)
    this.canvas = canvas

    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
      powerPreference: 'default',
    })
    if (!gl || !gl.getExtension('EXT_color_buffer_float')) {
      canvas.remove()
      throw new Error('WebGL2 with float render targets is required')
    }
    this.gl = gl
    this.initGL()

    canvas.addEventListener('pointerdown', this.onDown)
    canvas.addEventListener('pointermove', this.onMove)
    canvas.addEventListener('pointerup', this.onUp)
    canvas.addEventListener('pointercancel', this.onUp)
    canvas.addEventListener('lostpointercapture', this.onUp)
    canvas.addEventListener('webglcontextlost', this.onLost)
    canvas.addEventListener('webglcontextrestored', this.onRestored)
    document.addEventListener('visibilitychange', this.onVisibility)
    this.ro = new ResizeObserver(this.scheduleResize)
    this.ro.observe(host)

    void loadWordFont().then(() => {
      if (this.disposed) return
      this.rebuild()
      this.ready = true
      requestAnimationFrame(() => {
        canvas.style.opacity = '1'
      })
      this.installDebug()
    })
  }

  dispose(): void {
    this.disposed = true
    cancelAnimationFrame(this.raf)
    clearTimeout(this.resizeTimer)
    this.ro.disconnect()
    document.removeEventListener('visibilitychange', this.onVisibility)
    const c = this.canvas
    c.removeEventListener('pointerdown', this.onDown)
    c.removeEventListener('pointermove', this.onMove)
    c.removeEventListener('pointerup', this.onUp)
    c.removeEventListener('pointercancel', this.onUp)
    c.removeEventListener('lostpointercapture', this.onUp)
    c.removeEventListener('webglcontextlost', this.onLost)
    c.removeEventListener('webglcontextrestored', this.onRestored)
    this.freeLayoutResources()
    const gl = this.gl
    for (const p of Object.values(this.progs)) gl.deleteProgram(p.prog)
    if (this.vao) gl.deleteVertexArray(this.vao)
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    c.remove()
    this.audio.dispose()
    const w = window as unknown as { __sand?: SandDebug }
    if (this.debugApi && w.__sand === this.debugApi) delete w.__sand
  }

  // ---------------------------------------------------------------- setup

  private initGL() {
    const gl = this.gl
    this.vao = gl.createVertexArray()
    gl.bindVertexArray(this.vao)
    this.progs = {
      sim: createProgram(gl, FULLSCREEN_VS, SIM_FS, 'sim'),
      splat: createProgram(gl, SPLAT_VS, SPLAT_FS, 'splat'),
      blur: createProgram(gl, FULLSCREEN_VS, BLUR_FS, 'blur'),
      shade: createProgram(gl, FULLSCREEN_VS, SHADE_FS, 'shade'),
      composite: createProgram(gl, FULLSCREEN_VS, COMPOSITE_FS, 'composite'),
      grain: createProgram(gl, GRAIN_VS, GRAIN_FS, 'grain'),
    }
  }

  private freeLayoutResources() {
    const gl = this.gl
    const texs = [this.homeTex, ...this.posTex, ...this.stTex, this.densTex, this.tmpTex, this.heightTex, this.shadeTex]
    for (const t of texs) if (t) gl.deleteTexture(t)
    const fbos = [...this.simFbo, this.densFbo, this.tmpFbo, this.heightFbo, this.shadeFbo]
    for (const f of fbos) if (f) gl.deleteFramebuffer(f)
    this.homeTex = this.densTex = this.tmpTex = this.heightTex = this.shadeTex = null
    this.densFbo = this.tmpFbo = this.heightFbo = this.shadeFbo = null
    this.posTex = []
    this.stTex = []
    this.simFbo = []
  }

  private rebuild() {
    const gl = this.gl
    this.rebuilds++
    const rect = this.host.getBoundingClientRect()
    const cssW = Math.max(1, Math.round(rect.width))
    const cssH = Math.max(1, Math.round(rect.height))
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    this.cssW = cssW
    this.cssH = cssH
    this.dpr = dpr
    this.rectLeft = rect.left
    this.rectTop = rect.top
    this.canvas.width = Math.round(cssW * dpr)
    this.canvas.height = Math.round(cssH * dpr)

    this.freeLayoutResources()
    const layout = layoutGrains(cssW, cssH, MAX_GRAINS, GRAINS_PER_PX)
    this.layout = layout
    this.box = layout.box
    this.radius = clamp(layout.fontPx * 0.034, 9, 30)
    this.h0 = clamp(layout.fontPx * 0.011, 4, 9)
    this.gridW = Math.ceil(cssW / CELL)
    this.gridH = Math.ceil(cssH / CELL)
    this.splatWeight = 1 / (layout.density * CELL * CELL)

    const { texW, texH, home } = layout
    const n = texW * texH
    const pos0 = new Float32Array(n * 4)
    for (let i = 0; i < n; i++) {
      pos0[i * 4] = home[i * 4]
      pos0[i * 4 + 1] = home[i * 4 + 1]
    }
    const st0 = new Float32Array(n * 4)
    this.homeTex = createTexture(gl, texW, texH, gl.RGBA32F, gl.RGBA, gl.FLOAT, gl.NEAREST, home)
    for (let k = 0; k < 2; k++) {
      this.posTex[k] = createTexture(gl, texW, texH, gl.RGBA32F, gl.RGBA, gl.FLOAT, gl.NEAREST, pos0)
      this.stTex[k] = createTexture(gl, texW, texH, gl.RGBA32F, gl.RGBA, gl.FLOAT, gl.NEAREST, st0)
      this.simFbo[k] = createTarget(gl, [this.posTex[k], this.stTex[k]])
    }
    this.cur = 0

    const gw = this.gridW
    const gh = this.gridH
    this.densTex = createTexture(gl, gw, gh, gl.R16F, gl.RED, gl.HALF_FLOAT, gl.LINEAR)
    this.tmpTex = createTexture(gl, gw, gh, gl.R16F, gl.RED, gl.HALF_FLOAT, gl.LINEAR)
    this.heightTex = createTexture(gl, gw, gh, gl.R16F, gl.RED, gl.HALF_FLOAT, gl.LINEAR)
    this.shadeTex = createTexture(gl, gw, gh, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, gl.LINEAR)
    this.densFbo = createTarget(gl, [this.densTex])
    this.tmpFbo = createTarget(gl, [this.tmpTex])
    this.heightFbo = createTarget(gl, [this.heightTex])
    this.shadeFbo = createTarget(gl, [this.shadeTex])

    this.dirty = false
    this.healStart = -1
    this.down = false
    this.pending = []
    this.lastPt = null
    this.renderScene()
  }

  private scheduleResize = () => {
    if (!this.ready) return
    clearTimeout(this.resizeTimer)
    this.resizeTimer = window.setTimeout(() => {
      if (this.disposed || !this.ready) return
      const rect = this.host.getBoundingClientRect()
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      if (Math.round(rect.width) === this.cssW && Math.round(rect.height) === this.cssH && dpr === this.dpr) {
        this.rectLeft = rect.left
        this.rectTop = rect.top
        return
      }
      this.rebuild()
    }, 120)
  }

  // ---------------------------------------------------------------- input

  private local(e: PointerEvent): Vec {
    return { x: e.clientX - this.rectLeft, y: e.clientY - this.rectTop }
  }

  private onDown = (e: PointerEvent) => {
    if (!this.ready || (e.pointerType === 'mouse' && e.button !== 0)) return
    if (this.down && e.pointerId !== this.pointerId) return
    e.preventDefault()
    try {
      this.canvas.setPointerCapture(e.pointerId)
    } catch {
      // capture is a nicety; dragging still works without it
    }
    this.pointerId = e.pointerId
    this.down = true
    this.dirty = true
    this.lastPt = null
    this.pending = [this.local(e)]
    this.lastActive = this.time
    this.audio.unlock()
    this.wake()
  }

  private onMove = (e: PointerEvent) => {
    if (!this.down || e.pointerId !== this.pointerId) return
    const list = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : []
    if (list.length) for (const ce of list) this.pending.push(this.local(ce))
    else this.pending.push(this.local(e))
    this.wake()
  }

  private onUp = (e: PointerEvent) => {
    if (!this.down || e.pointerId !== this.pointerId) return
    this.down = false
    this.pointerId = -1
    this.wake()
  }

  private onVisibility = () => {
    if (document.hidden) {
      this.down = false
      this.pointerId = -1
    }
  }

  private onLost = (e: Event) => {
    e.preventDefault()
    this.ready = false
    cancelAnimationFrame(this.raf)
    this.raf = 0
  }

  private onRestored = () => {
    this.posTex = []
    this.stTex = []
    this.simFbo = []
    this.homeTex = this.densTex = this.tmpTex = this.heightTex = this.shadeTex = null
    this.densFbo = this.tmpFbo = this.heightFbo = this.shadeFbo = null
    this.initGL()
    this.rebuild()
    this.ready = true
  }

  private takePath(): Vec[] {
    const pts = this.pending
    this.pending = []
    const path = this.lastPt ? [this.lastPt, ...pts] : pts
    this.lastPt = this.down && path.length ? path[path.length - 1] : null
    return path
  }

  /** Split this frame's pointer path into short, equal capsules, one per sim substep. */
  private segments(path: Vec[]): Seg[] {
    const last = path[path.length - 1]
    const still: Seg[] = [{ a: last, b: last, vx: 0, vy: 0 }]
    if (path.length < 2) return still
    const cum = [0]
    let total = 0
    for (let i = 1; i < path.length; i++) {
      total += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y)
      cum.push(total)
    }
    if (total < 1e-3) return still
    const n = clamp(Math.ceil(total / (this.radius * 0.6)), 1, 10)
    const pts: Vec[] = []
    let j = 1
    for (let k = 0; k <= n; k++) {
      const d = (total * k) / n
      while (j < cum.length - 1 && cum[j] < d) j++
      const span = cum[j] - cum[j - 1]
      const t = span > 1e-6 ? clamp((d - cum[j - 1]) / span, 0, 1) : 1
      pts.push({
        x: path[j - 1].x + (path[j].x - path[j - 1].x) * t,
        y: path[j - 1].y + (path[j].y - path[j - 1].y) * t,
      })
    }
    const out: Seg[] = []
    for (let k = 0; k < n; k++) {
      const a = pts[k]
      const b = pts[k + 1]
      const dx = b.x - a.x
      const dy = b.y - a.y
      const l = Math.hypot(dx, dy)
      out.push({ a, b, vx: l > 1e-4 ? (dx / l) * this.speed : 0, vy: l > 1e-4 ? (dy / l) * this.speed : 0 })
    }
    return out
  }

  private sandAt(x: number, y: number): number {
    const s = this.layout?.sand
    if (!s) return 0
    const cx = Math.floor(x / s.cell)
    const cy = Math.floor(y / s.cell)
    if (cx < 0 || cy < 0 || cx >= s.w || cy >= s.h) return 0
    return s.data[cy * s.w + cx]
  }

  // ---------------------------------------------------------------- loop

  private wake() {
    if (!this.raf && this.ready && !this.disposed) this.raf = requestAnimationFrame(this.frame)
  }

  private frame = (now: number) => {
    this.raf = 0
    if (this.disposed || !this.ready || !this.layout) return
    // On high refresh displays render on every 2nd/3rd/4th vsync: ~60 fps with an even cadence.
    if (this.lastRaf > 0) {
      const raw = now - this.lastRaf
      if (raw > 1 && raw < 40) this.vsyncMs += (raw - this.vsyncMs) * 0.1
    }
    this.lastRaf = now
    const every = Math.max(1, Math.round(1000 / TARGET_FPS / this.vsyncMs))
    if (++this.tick % every !== 0 && !this.frozen) {
      this.raf = requestAnimationFrame(this.frame)
      return
    }
    let dt = this.lastNow > 0 ? (now - this.lastNow) / 1000 : 1 / 60
    this.lastNow = now
    dt = clamp(dt, 0.001, 1 / 30)
    this.frameDts.push(dt)
    if (this.frameDts.length > 90) this.frameDts.shift()
    if (this.frozen) {
      // keep presenting the frozen frame for a moment so screen captures never see a stale one
      this.renderScene()
      if (this.frozenFrames-- > 0) {
        this.raf = requestAnimationFrame(this.frame)
      } else {
        this.lastNow = 0
        this.lastRaf = 0
      }
      return
    }

    this.time += dt
    this.stepSynthetic(now)
    const fresh = this.pending.length
    const path = this.takePath()
    let len = 0
    for (let i = 1; i < path.length; i++) len += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y)
    const touching = path.length > 0 && (this.down || fresh > 0)
    if (touching && len > 0.25) this.lastActive = this.time
    const inst = touching ? len / dt : 0
    this.speed += (inst - this.speed) * (inst > this.speed ? 0.6 : 0.2)

    const idle = this.time - this.lastActive
    const healing = this.dirty && idle > IDLE_DELAY
    if (!healing) this.healStart = -1
    else if (this.healStart < 0) this.healStart = this.time
    const healT = healing ? this.time - this.healStart : 0
    const fingerOn = touching && !healing

    let segs: Seg[] | null = null
    if (fingerOn) {
      segs = this.segments(path)
      this.dirty = true
      this.lastFinger = path[path.length - 1]
    }
    this.simulate(dt, segs, healing ? smoothstep(0, HEAL_RAMP, healT) : 0, healT)
    if (healing && healT > HEAL_SNAP) {
      this.snap()
      this.dirty = false
      this.healStart = -1
    }
    this.renderScene()

    const fp = this.lastFinger
    this.audio.update(dt, fingerOn ? this.speed : 0, this.sandAt(fp.x, fp.y), fp.x / this.cssW)

    if (this.dirty || this.synth || (this.down && fresh > 0)) {
      this.raf = requestAnimationFrame(this.frame)
    } else {
      this.lastNow = 0
      this.lastRaf = 0
    }
  }

  // ---------------------------------------------------------------- gpu passes

  private bindTex(unit: number, tex: WebGLTexture | null, loc: WebGLUniformLocation | null) {
    const gl = this.gl
    gl.activeTexture(gl.TEXTURE0 + unit)
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.uniform1i(loc, unit)
  }

  private simulate(dt: number, segs: Seg[] | null, heal: number, healT: number) {
    const gl = this.gl
    const layout = this.layout
    if (!layout) return
    const { prog, u } = this.progs.sim
    gl.useProgram(prog)
    gl.viewport(0, 0, layout.texW, layout.texH)
    this.bindTex(0, this.homeTex, u.uHome)
    this.bindTex(3, this.heightTex, u.uHeight)
    gl.uniform2f(u.uHeightInv, 1 / this.gridW, 1 / this.gridH)
    gl.uniform1f(u.uCell, CELL)
    gl.uniform1f(u.uRadius, this.radius)
    gl.uniform1f(u.uDepth, DEPTH)
    gl.uniform1f(u.uHeal, heal)
    gl.uniform1f(u.uHealT, healT)
    gl.uniform1f(u.uH0, this.h0)
    gl.uniform1f(u.uSnap, 0)
    gl.uniform1i(u.uTexW, layout.texW)
    const steps = segs ? segs.length : 1
    gl.uniform1f(u.uDt, dt / steps)
    for (let i = 0; i < steps; i++) {
      const next = 1 - this.cur
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.simFbo[next])
      this.bindTex(1, this.posTex[this.cur], u.uPos)
      this.bindTex(2, this.stTex[this.cur], u.uState)
      if (segs) {
        const s = segs[i]
        gl.uniform2f(u.uA, s.a.x, s.a.y)
        gl.uniform2f(u.uB, s.b.x, s.b.y)
        gl.uniform2f(u.uFingerVel, s.vx, s.vy)
        gl.uniform1f(u.uFinger, 1)
      } else {
        gl.uniform1f(u.uFinger, 0)
      }
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      this.cur = next
    }
  }

  private snap() {
    const gl = this.gl
    const layout = this.layout
    if (!layout) return
    const { prog, u } = this.progs.sim
    gl.useProgram(prog)
    gl.viewport(0, 0, layout.texW, layout.texH)
    const next = 1 - this.cur
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.simFbo[next])
    this.bindTex(0, this.homeTex, u.uHome)
    this.bindTex(1, this.posTex[this.cur], u.uPos)
    this.bindTex(2, this.stTex[this.cur], u.uState)
    this.bindTex(3, this.heightTex, u.uHeight)
    gl.uniform1f(u.uSnap, 1)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    gl.uniform1f(u.uSnap, 0)
    this.cur = next
  }

  private renderScene() {
    const gl = this.gl
    const layout = this.layout
    if (!layout) return
    const P = this.progs
    const n = layout.texW * layout.texH
    const gw = this.gridW
    const gh = this.gridH
    gl.bindVertexArray(this.vao)

    // 1. how much sand sits on each cell
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.densFbo)
    gl.viewport(0, 0, gw, gh)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE)
    gl.useProgram(P.splat.prog)
    this.bindTex(0, this.posTex[this.cur], P.splat.u.uPos)
    this.bindTex(1, this.stTex[this.cur], P.splat.u.uState)
    this.bindTex(2, this.homeTex, P.splat.u.uHome)
    gl.uniform2f(P.splat.u.uView, this.cssW, this.cssH)
    gl.uniform1i(P.splat.u.uTexW, layout.texW)
    gl.uniform1f(P.splat.u.uWeight, this.splatWeight)
    gl.drawArrays(gl.POINTS, 0, n)
    gl.disable(gl.BLEND)

    // 2. smooth it into a height field
    gl.useProgram(P.blur.prog)
    gl.uniform2f(P.blur.u.uInvSize, 1 / gw, 1 / gh)
    gl.uniform1fv(P.blur.u.uW, this.weights)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.tmpFbo)
    this.bindTex(0, this.densTex, P.blur.u.uSrc)
    gl.uniform2f(P.blur.u.uDir, 1, 0)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.heightFbo)
    this.bindTex(0, this.tmpTex, P.blur.u.uSrc)
    gl.uniform2f(P.blur.u.uDir, 0, 1)
    gl.drawArrays(gl.TRIANGLES, 0, 3)

    // 3. light it
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadeFbo)
    gl.useProgram(P.shade.prog)
    this.bindTex(0, this.heightTex, P.shade.u.uHeight)
    this.bindTex(1, this.densTex, P.shade.u.uDensity)
    gl.uniform2f(P.shade.u.uInvSize, 1 / gw, 1 / gh)
    gl.uniform1f(P.shade.u.uCell, CELL)
    gl.uniform1f(P.shade.u.uH0, this.h0)
    gl.uniform3f(P.shade.u.uL, LIGHT[0], LIGHT[1], LIGHT[2])
    gl.drawArrays(gl.TRIANGLES, 0, 3)

    // 4. background, cast shadows and the bed between grains
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, this.canvas.width, this.canvas.height)
    gl.useProgram(P.composite.prog)
    this.bindTex(0, this.shadeTex, P.composite.u.uShade)
    gl.uniform2f(P.composite.u.uCanvas, this.canvas.width, this.canvas.height)
    gl.uniform1f(P.composite.u.uDpr, this.dpr)
    gl.uniform2f(P.composite.u.uView, this.cssW, this.cssH)
    gl.uniform1f(P.composite.u.uCell, CELL)
    gl.uniform2f(P.composite.u.uShadeInv, 1 / gw, 1 / gh)
    gl.uniform3f(P.composite.u.uBg, BG[0], BG[1], BG[2])
    gl.uniform3f(P.composite.u.uBed, BED[0], BED[1], BED[2])
    gl.drawArrays(gl.TRIANGLES, 0, 3)

    // 5. the grains: resting bed first, then everything that has been moved on top
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.useProgram(P.grain.prog)
    this.bindTex(0, this.posTex[this.cur], P.grain.u.uPos)
    this.bindTex(1, this.stTex[this.cur], P.grain.u.uState)
    this.bindTex(2, this.homeTex, P.grain.u.uHome)
    this.bindTex(3, this.shadeTex, P.grain.u.uShade)
    gl.uniform2f(P.grain.u.uView, this.cssW, this.cssH)
    gl.uniform1f(P.grain.u.uDpr, this.dpr)
    gl.uniform1i(P.grain.u.uTexW, layout.texW)
    gl.uniform1f(P.grain.u.uCell, CELL)
    gl.uniform2f(P.grain.u.uShadeInv, 1 / gw, 1 / gh)
    gl.uniform3f(P.grain.u.uL, LIGHT[0], LIGHT[1], LIGHT[2])
    gl.uniform1f(P.grain.u.uPass, 0)
    gl.drawArrays(gl.POINTS, 0, n)
    gl.uniform1f(P.grain.u.uPass, 1)
    gl.drawArrays(gl.POINTS, 0, n)
    gl.disable(gl.BLEND)
  }

  // ---------------------------------------------------------------- scripted strokes (QA / og image)

  private stepSynthetic(now: number) {
    const s = this.synth
    if (!s) return
    if (s.t0 < 0) s.t0 = now
    if (!this.down) {
      this.down = true
      this.dirty = true
      this.lastPt = null
      this.pending.push({ ...s.pts[0] })
      this.lastActive = this.time
    }
    const f = clamp((now - s.t0) / s.dur, 0, 1)
    const target = s.total * f
    while (s.done < target) {
      s.done = Math.min(target, s.done + 2)
      this.pending.push(this.pointAlong(s, s.done))
    }
    if (f >= 1) {
      if (s.release) this.down = false
      this.synth = null
      s.resolve()
    }
  }

  private pointAlong(s: Synthetic, d: number): Vec {
    let j = 1
    while (j < s.cum.length - 1 && s.cum[j] < d) j++
    const span = s.cum[j] - s.cum[j - 1]
    const t = span > 1e-6 ? clamp((d - s.cum[j - 1]) / span, 0, 1) : 1
    const a = s.pts[j - 1]
    const b = s.pts[j]
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
  }

  private startStroke(pts: Vec[], ms: number, release: boolean): Promise<void> {
    return new Promise((resolve) => {
      const cum = [0]
      let total = 0
      for (let i = 1; i < pts.length; i++) {
        total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
        cum.push(total)
      }
      this.synth = { pts, cum, total, dur: Math.max(16, ms), t0: -1, done: 0, release, resolve }
      this.frozen = false
      this.down = false
      this.lastPt = null
      this.pending = []
      this.wake()
    })
  }

  private installDebug() {
    const params = new URLSearchParams(location.search)
    if (!import.meta.env.DEV && !params.has('debug') && !params.has('og')) return
    const api: SandDebug = {
      stroke: (points, ms, release = true) =>
        this.startStroke(points.map(([x, y]) => ({ x, y })), ms, release),
      strokeRel: (points, ms, release = true) =>
        this.startStroke(
          points.map(([x, y]) => ({ x: this.box.x + x * this.box.w, y: this.box.y + y * this.box.h })),
          ms,
          release,
        ),
      freeze: (on) => {
        this.frozen = on
        this.frozenFrames = 20
        this.wake()
      },
      info: () => {
        const avg = this.frameDts.reduce((a, b) => a + b, 0) / Math.max(1, this.frameDts.length)
        return {
          grains: this.layout?.count ?? 0,
          w: this.cssW,
          h: this.cssH,
          dpr: this.dpr,
          fontPx: Math.round(this.layout?.fontPx ?? 0),
          radius: Math.round(this.radius * 10) / 10,
          fps: Math.round(1 / avg),
          sleeping: this.raf === 0,
          dirty: this.dirty,
          vsyncMs: Math.round(this.vsyncMs * 100) / 100,
          rebuilds: this.rebuilds,
          down: this.down,
          frozen: this.frozen,
        }
      },
      bench: (frames, substeps) => {
        const gl = this.gl
        const c = { x: this.box.x + this.box.w * 0.5, y: this.box.y + this.box.h * 0.6 }
        const segs: Seg[] = []
        for (let i = 0; i < substeps; i++) {
          segs.push({ a: c, b: { x: c.x + 1, y: c.y }, vx: 60, vy: 0 })
        }
        // reading a pixel back is the only reliable way to wait for the GPU to finish
        const px = new Uint8Array(4)
        const sync = () => {
          gl.bindFramebuffer(gl.FRAMEBUFFER, null)
          gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px)
        }
        sync()
        const t0 = performance.now()
        for (let i = 0; i < frames; i++) {
          this.simulate(1 / 60, segs, 0, 0)
          this.renderScene()
          sync()
        }
        const ms = (performance.now() - t0) / frames
        this.dirty = true
        this.lastActive = this.time
        this.wake()
        return ms
      },
    }
    this.debugApi = api
    ;(window as unknown as { __sand?: SandDebug }).__sand = api

    if (params.has('og')) {
      const wave: [number, number][] = []
      for (let i = 0; i <= 48; i++) {
        const t = i / 48
        wave.push([0.02 + 0.96 * t, 0.66 + 0.13 * Math.sin(t * Math.PI * 2.1 + 0.4)])
      }
      void api.strokeRel(wave, 1400, true).then(() => {
        window.setTimeout(() => api.freeze(true), 450)
      })
    }
  }
}
