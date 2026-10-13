export type Uniforms = Record<string, WebGLUniformLocation | null>

export interface Program {
  prog: WebGLProgram
  u: Uniforms
}

function compile(gl: WebGL2RenderingContext, type: number, src: string, name: string): WebGLShader {
  const sh = gl.createShader(type)
  if (!sh) throw new Error(`createShader failed (${name})`)
  gl.shaderSource(sh, src)
  gl.compileShader(sh)
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh)
    gl.deleteShader(sh)
    throw new Error(`${name} ${type === gl.VERTEX_SHADER ? 'vertex' : 'fragment'} shader: ${log}`)
  }
  return sh
}

export function createProgram(gl: WebGL2RenderingContext, vsSrc: string, fsSrc: string, name: string): Program {
  const vs = compile(gl, gl.VERTEX_SHADER, vsSrc, name)
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc, name)
  const prog = gl.createProgram()
  if (!prog) throw new Error(`createProgram failed (${name})`)
  gl.attachShader(prog, vs)
  gl.attachShader(prog, fs)
  gl.linkProgram(prog)
  gl.deleteShader(vs)
  gl.deleteShader(fs)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error(`${name} link: ${gl.getProgramInfoLog(prog)}`)
  }
  const u: Uniforms = {}
  const count = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS) as number
  for (let i = 0; i < count; i++) {
    const info = gl.getActiveUniform(prog, i)
    if (!info) continue
    u[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(prog, info.name)
  }
  return { prog, u }
}

export function createTexture(
  gl: WebGL2RenderingContext,
  w: number,
  h: number,
  internalFormat: number,
  format: number,
  type: number,
  filter: number,
  data: ArrayBufferView | null = null,
): WebGLTexture {
  const tex = gl.createTexture()
  if (!tex) throw new Error('createTexture failed')
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, type, data)
  gl.bindTexture(gl.TEXTURE_2D, null)
  return tex
}

export function createTarget(gl: WebGL2RenderingContext, textures: WebGLTexture[]): WebGLFramebuffer {
  const fbo = gl.createFramebuffer()
  if (!fbo) throw new Error('createFramebuffer failed')
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
  const buffers: number[] = []
  textures.forEach((tex, i) => {
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, tex, 0)
    buffers.push(gl.COLOR_ATTACHMENT0 + i)
  })
  gl.drawBuffers(buffers)
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`framebuffer incomplete: 0x${status.toString(16)}`)
  return fbo
}
