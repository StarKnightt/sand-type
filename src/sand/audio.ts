const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
const smooth = (a: number, b: number, v: number) => {
  const t = clamp01((v - a) / (b - a))
  return t * t * (3 - 2 * t)
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

function normalize(d: Float32Array, peak: number) {
  let m = 0
  for (let i = 0; i < d.length; i++) m = Math.max(m, Math.abs(d[i]))
  if (m > 0) for (let i = 0; i < d.length; i++) d[i] *= peak / m
}

/** Broadband hiss with a slow, uneven rustle in its level: the finger sliding over the bed. */
function brushBuffer(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const sr = ctx.sampleRate
  const n = Math.floor(sr * seconds)
  const fade = Math.floor(sr * 0.08)
  const buf = ctx.createBuffer(2, n, sr)
  for (let ch = 0; ch < 2; ch++) {
    const rand = makeRng(0x9e37 + ch * 7919)
    const tmp = new Float32Array(n + fade)
    let lp = 0
    let env = 1
    let envTarget = 1
    for (let i = 0; i < tmp.length; i++) {
      if (i % 1536 === 0) envTarget = 0.55 + 0.9 * rand()
      env += (envTarget - env) * 0.0012
      const w = rand() * 2 - 1
      lp += (w - lp) * 0.3
      tmp[i] = (lp * 0.85 + w * 0.15) * env
    }
    const d = buf.getChannelData(ch)
    d.set(tmp.subarray(0, n))
    // crossfade the tail into the head so the loop has no seam
    for (let i = 0; i < fade; i++) {
      const t = i / fade
      d[i] = tmp[i] * t + tmp[n + i] * (1 - t)
    }
    normalize(d, 0.5)
  }
  return buf
}

/** Thousands of tiny, randomly loud grain ticks per second: the crunchy part of sand. */
function crackleBuffer(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const sr = ctx.sampleRate
  const n = Math.floor(sr * seconds)
  const buf = ctx.createBuffer(2, n, sr)
  for (let ch = 0; ch < 2; ch++) {
    const rand = makeRng(0x51ed + ch * 104729)
    const d = buf.getChannelData(ch)
    const rate = 2800
    let t = 0
    for (;;) {
      t += (-Math.log(1 - rand()) / rate) * sr
      if (t >= n) break
      let e = Math.pow(rand(), 3.2) * (rand() < 0.5 ? -1 : 1)
      const decay = 0.55 + rand() * 0.37
      const start = Math.floor(t)
      for (let k = 0; k < 48 && Math.abs(e) > 1e-4; k++) {
        d[(start + k) % n] += e * (rand() * 2 - 1)
        e *= decay
      }
    }
    normalize(d, 0.9)
  }
  return buf
}

export interface SandVoice {
  brushGain: GainNode
  grainGain: GainNode
  tone: BiquadFilterNode
  panner: StereoPannerNode
  grainSrc: AudioBufferSourceNode
}

/** Builds and starts the (silent until driven) sand voice on any audio context. */
export function createSandVoice(ctx: BaseAudioContext): SandVoice {
  const brushSrc = ctx.createBufferSource()
  brushSrc.buffer = brushBuffer(ctx, 3.3)
  brushSrc.loop = true
  const brushHp = ctx.createBiquadFilter()
  brushHp.type = 'highpass'
  brushHp.frequency.value = 420
  brushHp.Q.value = 0.5
  const brushPeak = ctx.createBiquadFilter()
  brushPeak.type = 'peaking'
  brushPeak.frequency.value = 2300
  brushPeak.Q.value = 0.7
  brushPeak.gain.value = 4
  const brushGain = ctx.createGain()
  brushGain.gain.value = 0

  const grainSrc = ctx.createBufferSource()
  grainSrc.buffer = crackleBuffer(ctx, 4.1)
  grainSrc.loop = true
  const grainHp = ctx.createBiquadFilter()
  grainHp.type = 'highpass'
  grainHp.frequency.value = 1700
  grainHp.Q.value = 0.6
  const grainGain = ctx.createGain()
  grainGain.gain.value = 0

  const tone = ctx.createBiquadFilter()
  tone.type = 'lowpass'
  tone.frequency.value = 2500
  tone.Q.value = 0.4
  const panner = ctx.createStereoPanner()
  const master = ctx.createGain()
  master.gain.value = 0.55
  const limiter = ctx.createDynamicsCompressor()
  limiter.threshold.value = -20
  limiter.knee.value = 12
  limiter.ratio.value = 4
  limiter.attack.value = 0.004
  limiter.release.value = 0.2

  brushSrc.connect(brushHp).connect(brushPeak).connect(brushGain).connect(tone)
  grainSrc.connect(grainHp).connect(grainGain).connect(tone)
  tone.connect(panner).connect(master).connect(limiter).connect(ctx.destination)
  brushSrc.start()
  grainSrc.start()
  return { brushGain, grainGain, tone, panner, grainSrc }
}

/**
 * Drives the voice. speed: finger speed in css px/s (0 when lifted), sand: 0..1 how much sand
 * is under the finger, x01: horizontal position for a little stereo placement.
 * Returns the loudness level 0..1 that was applied.
 */
export function driveSandVoice(
  v: SandVoice,
  at: number,
  speed: number,
  sand: number,
  x01: number,
  wobble = 1,
): number {
  const level = (1 - Math.exp(-Math.max(0, speed - 6) / 700)) * clamp01(sand)
  v.brushGain.gain.setTargetAtTime(0.2 * level * wobble, at, 0.05)
  v.grainGain.gain.setTargetAtTime(0.42 * level * (0.3 + 0.7 * smooth(150, 2200, speed)), at, 0.035)
  v.tone.frequency.setTargetAtTime(2000 + 6000 * smooth(0, 2400, speed), at, 0.08)
  v.grainSrc.playbackRate.setTargetAtTime(0.7 + 0.7 * smooth(0, 2400, speed), at, 0.1)
  v.panner.pan.setTargetAtTime((clamp01(x01) - 0.5) * 0.6, at, 0.12)
  return level
}

export class SandAudio {
  private ctx: AudioContext | null = null
  private voice: SandVoice | null = null
  private quietFor = 0
  private wobble = 1
  private wobbleTarget = 1

  /** Call from a user gesture. */
  unlock(): void {
    if (!this.ctx) {
      const Ctor = window.AudioContext
      if (!Ctor) return
      try {
        this.ctx = new Ctor({ latencyHint: 'interactive' })
        this.voice = createSandVoice(this.ctx)
      } catch {
        this.ctx = null
        return
      }
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume()
    this.quietFor = 0
  }

  update(dt: number, speed: number, sand: number, x01: number): void {
    const ctx = this.ctx
    if (!ctx || !this.voice || ctx.state !== 'running') return
    // a slow random drift keeps the hiss from sounding like a fan
    if (Math.random() < dt * 6) this.wobbleTarget = 0.75 + 0.5 * Math.random()
    this.wobble += (this.wobbleTarget - this.wobble) * Math.min(1, dt * 10)
    const level = driveSandVoice(this.voice, ctx.currentTime, speed, sand, x01, this.wobble)

    if (level < 0.002) {
      this.quietFor += dt
      if (this.quietFor > 1.5) void ctx.suspend()
    } else {
      this.quietFor = 0
    }
  }

  dispose(): void {
    if (this.ctx) void this.ctx.close()
    this.ctx = null
  }
}
