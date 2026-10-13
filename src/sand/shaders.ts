// All passes work in CSS pixels with y pointing down. Offscreen targets keep that
// orientation (texel row 0 = top of the page); only the two on-screen passes flip y.

const HEADER = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
`

const COMMON = /* glsl */ `
uint hashU(uint x) {
  x ^= x >> 16u; x *= 0x7feb352du;
  x ^= x >> 15u; x *= 0x846ca68bu;
  x ^= x >> 16u;
  return x;
}
float rnd(uint id, uint k) {
  return float(hashU(id * 0x9E3779B9u + k * 0x85EBCA6Bu + 0x632BE5ABu) >> 8u) * (1.0 / 16777216.0);
}
float hash2(vec2 p) {
  uvec2 q = uvec2(ivec2(floor(p)) + 32768);
  return float(hashU(q.x * 0x8da6b343u ^ hashU(q.y * 0xd8163841u + 0x1b873593u)) >> 8u) * (1.0 / 16777216.0);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash2(i);
  float b = hash2(i + vec2(1.0, 0.0));
  float c = hash2(i + vec2(0.0, 1.0));
  float d = hash2(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
`

export const FULLSCREEN_VS = /* glsl */ `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`

// One texel per grain. pos = (x, y, vx, vy), state = (z, vz, free, compaction),
// home = (x, y, layer, size). layer 0 = bottom of the sand bed, 1 = top.
export const SIM_FS = HEADER + COMMON + /* glsl */ `
uniform sampler2D uPos;
uniform sampler2D uState;
uniform sampler2D uHome;
uniform sampler2D uHeight;
uniform vec2 uHeightInv;
uniform float uCell;
uniform float uDt;
uniform vec2 uA;
uniform vec2 uB;
uniform vec2 uFingerVel;
uniform float uFinger;
uniform float uRadius;
uniform float uDepth;
uniform float uHeal;
uniform float uHealT;
uniform float uH0;
uniform float uSnap;
uniform int uTexW;

layout(location = 0) out vec4 oPos;
layout(location = 1) out vec4 oState;

float heightAt(vec2 p) {
  return texture(uHeight, p / uCell * uHeightInv).r;
}

void main() {
  ivec2 tc = ivec2(gl_FragCoord.xy);
  vec4 home = texelFetch(uHome, tc, 0);
  vec4 pv = texelFetch(uPos, tc, 0);
  vec4 st = texelFetch(uState, tc, 0);
  oPos = pv;
  oState = st;
  if (home.w <= 0.0) return;
  if (uSnap > 0.5) {
    oPos = vec4(home.xy, 0.0, 0.0);
    oState = vec4(0.0);
    return;
  }

  uint id = uint(tc.y * uTexW + tc.x);
  float r0 = rnd(id, 0u);
  float r1 = rnd(id, 1u);
  float r2 = rnd(id, 2u);
  float r3 = rnd(id, 3u);

  vec2 p = pv.xy;
  vec2 v = pv.zw;
  float z = st.x;
  float vz = st.y;
  float freeF = st.z;
  float comp = st.w;
  float layer = home.z;
  float size = home.w;
  bool touched = false;
  bool held = false;

  if (uFinger > 0.5) {
    vec2 ab = uB - uA;
    float l2 = dot(ab, ab);
    float t = l2 > 1e-6 ? clamp(dot(p - uA, ab) / l2, 0.0, 1.0) : 0.0;
    vec2 c = uA + ab * t;
    vec2 dv = p - c;
    float d = length(dv);
    // a fingertip is not a perfect circle and sand does not part cleanly
    float rEff = uRadius * (0.9 + 0.2 * vnoise(p * 0.12) + 0.08 * (r0 - 0.5));
    held = d < rEff + 3.0;
    if (d < rEff && z < 3.0) {
      vec2 dir = l2 > 1e-6 ? ab * inversesqrt(l2) : vec2(1.0, 0.0);
      vec2 side = vec2(-dir.y, dir.x);
      // skin and nail drag fine streaks along the stroke
      float lateral = dot(dv, side);
      float streak = 0.5 + 0.5 * sin(lateral * 1.35 + 3.0 * vnoise(p * 0.045));
      // the fingertip is a shallow dome: deepest in the middle, grazing at the rim
      float u = d / rEff;
      float floorLevel = 1.0 - uDepth * sqrt(max(0.0, 1.0 - u * u)) + 0.14 * (streak - 0.5);
      if (freeF > 0.5 || layer > floorLevel) {
        vec2 n = d > 1e-3 ? dv / d : side * (r1 < 0.5 ? -1.0 : 1.0);
        float lump = vnoise(p * 0.16 + 17.0);
        p = c + n * (rEff + 0.3 + 1.4 * r2 + 3.0 * lump * lump);
        float fs = length(uFingerVel);
        vec2 fdir = fs > 1e-3 ? uFingerVel / fs : vec2(0.0);
        float moving = smoothstep(4.0, 40.0, fs);
        // dense sand barely flows: the finger shoves grains aside, it does not throw them
        float plow = min(max(dot(uFingerVel, n), 0.0), 420.0);
        v = n * (plow * (0.18 + 0.2 * r3) + (12.0 + 30.0 * r1) * moving) + fdir * min(fs, 420.0) * 0.05;
        // quick strokes flick a few of the finest grains a short way out
        float fast = smoothstep(1100.0, 3000.0, fs);
        float fine = 1.0 - smoothstep(1.12, 1.5, size);
        if (r3 < 0.09 * fast * fine) {
          v += (n * (0.4 + 0.6 * r2) + fdir * (r1 - 0.35) * 0.7) * min(fs, 3000.0) * 0.075;
          vz = (35.0 + 75.0 * r0) * fast;
          z = 0.01;
        }
        freeF = 1.0;
        touched = true;
      } else {
        comp = 1.0 - 0.75 * streak;
      }
    }
  }

  if (uHeal > 0.0) {
    float k = uHeal * smoothstep(0.0, 0.9, uHealT - r0 * 0.5);
    comp = max(0.0, comp - uDt * 0.9 * k);
    if (freeF > 0.5 && k > 0.0) {
      vec2 to = home.xy - p;
      float dist = length(to);
      float vmax = mix(80.0, 170.0, r1) + 0.6 * dist;
      float spd = min(vmax, dist * mix(2.4, 4.0, r2));
      vec2 vd = dist > 1e-4 ? to * (spd / dist) : vec2(0.0);
      v = mix(v, vd, 1.0 - exp(-7.0 * k * uDt));
      z = 0.0;
      vz = 0.0;
      p += v * uDt;
      if (dist < 0.25 && dot(v, v) < 30.0 && k > 0.5) {
        p = home.xy;
        v = vec2(0.0);
        freeF = 0.0;
      }
      oPos = vec4(p, v);
      oState = vec4(z, vz, freeF, comp);
      return;
    }
  }

  if (freeF > 0.5 && !touched) {
    if (z > 0.0) {
      vz -= 1500.0 * uDt;
      z += vz * uDt;
      p += v * uDt;
      v *= exp(-0.7 * uDt);
      if (z <= 0.0) {
        z = 0.0;
        vz = 0.0;
        v *= 0.25;
      }
    } else {
      float sp = length(v);
      float dec = 1700.0 * uDt;
      v = sp > dec ? v * (1.0 - dec / sp) : vec2(0.0);
      v *= exp(-5.0 * uDt);
      p += v * uDt;
      // avalanche: wherever the pile is steeper than the angle of repose, grains creep down it
      if (!held) {
        float e = uCell;
        vec2 g = vec2(
          heightAt(p + vec2(e, 0.0)) - heightAt(p - vec2(e, 0.0)),
          heightAt(p + vec2(0.0, e)) - heightAt(p - vec2(0.0, e))
        ) * (uH0 / (2.0 * e));
        float s = length(g);
        float repose = 0.55 + 0.2 * r2;
        if (s > repose) p -= g * (min((s - repose) * 150.0, 90.0) / s) * uDt;
      }
    }
  }

  oPos = vec4(p, v);
  oState = vec4(z, vz, freeF, comp);
}
`

// Each grain adds its share of sand to a coarse grid. 1.0 = the resting bed thickness.
export const SPLAT_VS = HEADER + /* glsl */ `
uniform sampler2D uPos;
uniform sampler2D uState;
uniform sampler2D uHome;
uniform vec2 uView;
uniform int uTexW;
out float vW;
void main() {
  ivec2 tc = ivec2(gl_VertexID % uTexW, gl_VertexID / uTexW);
  vec4 home = texelFetch(uHome, tc, 0);
  vec2 p = texelFetch(uPos, tc, 0).xy;
  float z = texelFetch(uState, tc, 0).x;
  vW = home.w > 0.0 ? 1.0 - smoothstep(1.0, 6.0, z) : 0.0;
  gl_Position = vec4(p / uView * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = 1.0;
}
`

export const SPLAT_FS = HEADER + /* glsl */ `
uniform float uWeight;
in float vW;
out vec4 o;
void main() {
  o = vec4(vW * uWeight, 0.0, 0.0, 0.0);
}
`

export const BLUR_FS = HEADER + /* glsl */ `
uniform sampler2D uSrc;
uniform vec2 uInvSize;
uniform vec2 uDir;
uniform float uW[5];
out vec4 o;
void main() {
  vec2 uv = gl_FragCoord.xy * uInvSize;
  vec2 st = uDir * uInvSize;
  float acc = texture(uSrc, uv).r * uW[0];
  for (int i = 1; i < 5; i++) {
    float fi = float(i);
    acc += (texture(uSrc, uv + st * fi).r + texture(uSrc, uv - st * fi).r) * uW[i];
  }
  o = vec4(acc, 0.0, 0.0, 1.0);
}
`

// Lighting of the sand surface as a height field: diffuse, soft cast shadow and
// cavity occlusion. Output = (diffuse, shadow, occlusion, bed coverage).
export const SHADE_FS = HEADER + /* glsl */ `
uniform sampler2D uHeight;
uniform sampler2D uDensity;
uniform vec2 uInvSize;
uniform float uCell;
uniform float uH0;
uniform vec3 uL;
out vec4 o;

float H(vec2 uv) { return texture(uHeight, uv).r; }

void main() {
  vec2 uv = gl_FragCoord.xy * uInvSize;
  vec2 pxToUv = uInvSize / uCell;
  float h = H(uv) * uH0;
  vec2 dx = vec2(uInvSize.x, 0.0);
  vec2 dy = vec2(0.0, uInvSize.y);
  float gx = (H(uv + dx) - H(uv - dx)) * uH0 / (2.0 * uCell);
  float gy = (H(uv + dy) - H(uv - dy)) * uH0 / (2.0 * uCell);
  vec3 n = normalize(vec3(-gx, -gy, 1.0));
  float diffuse = max(dot(n, uL), 0.0) / uL.z;

  vec2 ldir = normalize(uL.xy);
  float tanE = uL.z / length(uL.xy);
  float occ = 0.0;
  float ts[8] = float[8](1.5, 3.0, 5.0, 8.0, 12.0, 17.0, 23.0, 31.0);
  for (int i = 0; i < 8; i++) {
    float t = ts[i];
    float rise = H(uv + ldir * t * pxToUv) * uH0 - h - t * tanE;
    occ = max(occ, smoothstep(0.0, 0.8 + 0.18 * t, rise));
  }

  float ring = 0.0;
  for (int i = 0; i < 8; i++) {
    float a = float(i) * 0.7853982 + 0.39;
    float r = (i % 2 == 0) ? 5.0 : 10.0;
    ring += H(uv + vec2(cos(a), sin(a)) * r * pxToUv);
  }
  ring = ring * 0.125 * uH0;
  float ao = 1.0 - 0.35 * smoothstep(0.0, uH0 * 0.9, ring - h);

  // The bed shows wherever there is sand underneath: fine coverage keeps letter edges crisp,
  // the smoothed height keeps lone scattered grains from getting a dark blob under them.
  vec2 hx = 0.5 * uInvSize;
  float cov = 0.25 * (
    texture(uDensity, uv + hx).r +
    texture(uDensity, uv - hx).r +
    texture(uDensity, uv + vec2(hx.x, -hx.y)).r +
    texture(uDensity, uv + vec2(-hx.x, hx.y)).r);
  float bed = smoothstep(0.04, 0.14, cov) * smoothstep(0.08, 0.22, H(uv));

  o = vec4(diffuse, 1.0 - occ, ao, bed);
}
`

// Background, cast shadows on it, and the dark bed that shows between grains.
export const COMPOSITE_FS = HEADER + COMMON + /* glsl */ `
uniform sampler2D uShade;
uniform vec2 uCanvas;
uniform float uDpr;
uniform vec2 uView;
uniform float uCell;
uniform vec2 uShadeInv;
uniform vec3 uBg;
uniform vec3 uBed;
out vec4 o;
void main() {
  vec2 fc = vec2(gl_FragCoord.x, uCanvas.y - gl_FragCoord.y);
  vec2 p = fc / uDpr;
  vec4 s = texture(uShade, p / uCell * uShadeInv);
  float diffuse = s.r;
  float shadow = s.g;
  float ao = s.b;
  float bedA = s.a;

  vec2 q = (p - 0.5 * uView) / max(uView.x, uView.y);
  vec3 bg = uBg * (1.0 - 0.10 * dot(q, q));
  bg *= mix(0.86, 1.0, shadow);

  float light = (0.55 + 0.45 * diffuse * mix(0.5, 1.0, shadow)) * mix(1.0, ao, 0.8);
  vec3 col = mix(bg, uBed * light, bedA);
  col += (hash2(fc) - 0.5) * (1.5 / 255.0);
  o = vec4(col, 1.0);
}
`

export const GRAIN_VS = HEADER + COMMON + /* glsl */ `
uniform sampler2D uPos;
uniform sampler2D uState;
uniform sampler2D uHome;
uniform sampler2D uShade;
uniform vec2 uView;
uniform float uDpr;
uniform int uTexW;
uniform float uCell;
uniform vec2 uShadeInv;
uniform float uPass;
uniform vec3 uL;
out vec3 vColor;
out vec4 vGeo;
out float vAA;

void main() {
  int vid = gl_VertexID;
  ivec2 tc = ivec2(vid % uTexW, vid / uTexW);
  vec4 home = texelFetch(uHome, tc, 0);
  vec4 st = texelFetch(uState, tc, 0);
  float freeF = st.z > 0.5 ? 1.0 : 0.0;
  if (home.w <= 0.0 || abs(freeF - uPass) > 0.5) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vColor = vec3(0.0);
    vGeo = vec4(0.0);
    vAA = 1.0;
    return;
  }
  vec4 pv = texelFetch(uPos, tc, 0);
  uint id = uint(vid);
  float r0 = rnd(id, 11u);
  float r1 = rnd(id, 12u);
  float r2 = rnd(id, 13u);
  float r3 = rnd(id, 14u);

  vec3 cLight = vec3(0.960, 0.875, 0.725);
  vec3 cBeige = vec3(0.925, 0.790, 0.590);
  vec3 cTan = vec3(0.855, 0.690, 0.475);
  vec3 cBrown = vec3(0.700, 0.535, 0.360);
  vec3 col = mix(cLight, cBeige, smoothstep(0.0, 0.55, r0));
  col = mix(col, cTan, smoothstep(0.5, 1.0, r0));
  if (r1 < 0.07) col = mix(col, cBrown, 0.7);
  else if (r1 > 0.99) col = vec3(0.40, 0.35, 0.30);
  else if (r1 > 0.97) col = vec3(0.95, 0.93, 0.89);
  col *= 0.92 + 0.16 * r2;
  col *= vec3(1.0 + 0.04 * (r3 - 0.5), 1.0, 1.0 - 0.05 * (r3 - 0.5));

  vec4 s = texture(uShade, pv.xy / uCell * uShadeInv);
  float diffuse = s.r;
  float shadow = s.g;
  float ao = s.b;
  float comp = st.w;
  float z = st.x;
  float lit = (0.55 + 0.45 * diffuse * mix(0.5, 1.0, shadow)) * mix(1.0, ao, 0.8);
  lit *= 1.0 - 0.2 * comp;
  lit += 0.05 * smoothstep(0.0, 6.0, z);
  vColor = col * lit;

  float size = home.w * (1.0 - 0.18 * comp);
  float rDev = 0.5 * size * uDpr;
  vec2 ldir = normalize(uL.xy);
  float tanE = uL.z / length(uL.xy);
  vec2 shOff = -ldir * (0.3 * rDev + z / tanE * uDpr);
  float halfPx = rDev * 1.4 + length(shOff) + 0.75;
  gl_PointSize = 2.0 * halfPx;
  vGeo = vec4(rDev / halfPx, shOff / halfPx, mix(0.2, 0.14, smoothstep(0.0, 10.0, z)));
  vAA = 1.0 / halfPx;
  vec2 ndc = pv.xy / uView * 2.0 - 1.0;
  gl_Position = vec4(ndc.x, -ndc.y, 0.0, 1.0);
}
`

export const GRAIN_FS = HEADER + /* glsl */ `
uniform vec3 uL;
in vec3 vColor;
in vec4 vGeo;
in float vAA;
out vec4 o;

// roll highlights off instead of clipping lit grains to white
vec3 shoulder(vec3 c) {
  vec3 x = max(c - 0.82, 0.0);
  return min(c, 0.82) + x / (1.0 + x / 0.16);
}

void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float r = vGeo.x;
  float d = length(q);
  float aG = 1.0 - smoothstep(r - vAA, r + vAA, d);
  float ds = length(q - vGeo.yz);
  float aS = (1.0 - smoothstep(r * 0.4, r * 1.4, ds)) * vGeo.w;
  vec2 nq = q / r;
  float nz = sqrt(max(0.0, 1.0 - dot(nq, nq)));
  float sph = 0.86 + 0.22 * dot(vec3(nq, nz), uL);
  float a = aG + aS * (1.0 - aG);
  if (a < 0.004) discard;
  o = vec4(shoulder(vColor * sph) * aG, a);
}
`
