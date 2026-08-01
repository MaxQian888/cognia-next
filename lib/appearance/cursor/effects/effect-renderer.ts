// Canvas drawing for the pointer effects.
//
// Split from the simulation so each half can be reasoned about (and tested)
// alone: this module never mutates a particle, and the sim never touches a
// context. Every entry point takes the 2D context explicitly, which is also
// what lets the tests drive it with a recording stub instead of a real canvas.
//
// All drawing is done in CSS-pixel space; the caller applies the device-pixel
// transform once per resize.

import { converter, parse } from "culori"
import type { EffectSpec, Particle, SimState } from "./particle-sim"
import { particleProgress } from "./particle-sim"

const toRgb = converter("rgb")

/** Parsed color cache — the color changes on theme switches, not per frame. */
const rgbCache = new Map<string, [number, number, number]>()

/** Resolve any CSS color to an `r,g,b` triple, falling back to a mid grey. */
export function toRgbTriple(color: string): [number, number, number] {
  const cached = rgbCache.get(color)
  if (cached) return cached
  const rgb = toRgb(parse(color))
  const triple: [number, number, number] = rgb
    ? [
        Math.round((rgb.r ?? 0) * 255),
        Math.round((rgb.g ?? 0) * 255),
        Math.round((rgb.b ?? 0) * 255),
      ]
    : [148, 163, 184]
  rgbCache.set(color, triple)
  return triple
}

/** Test seam — keeps color parsing from leaking between suites. */
export function clearEffectColorCache(): void {
  rgbCache.clear()
}

/** The paint for one particle: rainbow particles carry their own hue. */
export function particleColor(p: Particle, base: string, alpha: number): string {
  const a = Math.min(Math.max(alpha, 0), 1)
  if (p.hue >= 0) return `hsla(${p.hue.toFixed(0)}, 92%, 64%, ${a.toFixed(3)})`
  const [r, g, b] = toRgbTriple(base)
  return `rgba(${r}, ${g}, ${b}, ${a.toFixed(3)})`
}

/** Opacity curve — quick attack, long tail, so trails read as fading smoke. */
export function fadeAlpha(progress: number): number {
  // Rises over the first 12% of life, then eases out cubically.
  if (progress < 0.12) return progress / 0.12
  const t = (progress - 0.12) / 0.88
  return Math.pow(1 - t, 2)
}

// ---------------------------------------------------------------------------
// Shape primitives — each traces a path centred on (0, 0) in a unit-ish space
// scaled by `size`. The caller has already translated/rotated the context.
// ---------------------------------------------------------------------------

function tracePolygonStar(
  ctx: CanvasRenderingContext2D,
  points: number,
  outer: number,
  inner: number
): void {
  ctx.beginPath()
  for (let i = 0; i < points * 2; i++) {
    const radius = i % 2 === 0 ? outer : inner
    const angle = (Math.PI * i) / points - Math.PI / 2
    const x = Math.cos(angle) * radius
    const y = Math.sin(angle) * radius
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.closePath()
}

/** A cherry-blossom petal: a rounded lobe with the characteristic tip notch. */
function tracePetal(ctx: CanvasRenderingContext2D, size: number): void {
  ctx.beginPath()
  ctx.moveTo(0, -size)
  ctx.bezierCurveTo(size * 0.95, -size * 0.6, size * 0.8, size * 0.75, 0, size)
  ctx.bezierCurveTo(-size * 0.8, size * 0.75, -size * 0.95, -size * 0.6, 0, -size)
  ctx.closePath()
  // The notch — a small wedge cut from the wide end, drawn as a second subpath
  // in the opposite winding so `evenodd` filling removes it.
  ctx.moveTo(0, size)
  ctx.lineTo(size * 0.22, size * 0.72)
  ctx.lineTo(-size * 0.22, size * 0.72)
  ctx.closePath()
}

/** Six-spoke snowflake, each spoke carrying two barbs. */
function traceFlake(ctx: CanvasRenderingContext2D, size: number): void {
  ctx.beginPath()
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI * i) / 3
    const dx = Math.cos(angle)
    const dy = Math.sin(angle)
    ctx.moveTo(0, 0)
    ctx.lineTo(dx * size, dy * size)
    const bx = dx * size * 0.6
    const by = dy * size * 0.6
    const px = -dy * size * 0.28
    const py = dx * size * 0.28
    ctx.moveTo(bx, by)
    ctx.lineTo(bx + px, by + py)
    ctx.moveTo(bx, by)
    ctx.lineTo(bx - px, by - py)
  }
}

/** Upward teardrop for the flame effect. */
function traceFlame(ctx: CanvasRenderingContext2D, size: number): void {
  ctx.beginPath()
  ctx.moveTo(0, -size * 1.5)
  ctx.bezierCurveTo(size * 0.9, -size * 0.3, size * 0.7, size, 0, size)
  ctx.bezierCurveTo(-size * 0.7, size, -size * 0.9, -size * 0.3, 0, -size * 1.5)
  ctx.closePath()
}

/** Draw one particle. Returns false when the shape is handled elsewhere. */
export function drawParticle(
  ctx: CanvasRenderingContext2D,
  p: Particle,
  spec: EffectSpec,
  color: string
): boolean {
  if (p.shape === "node") return false // ribbons are stroked as one path

  const progress = particleProgress(p)
  const alpha = fadeAlpha(progress)
  if (alpha <= 0.002) return true

  const paint = particleColor(p, color, alpha)
  ctx.save()
  ctx.translate(p.x, p.y)
  if (p.spin !== 0) ctx.rotate(p.rotation)

  switch (p.shape) {
    case "ring": {
      const radius = p.size + (spec.expand ?? 0) * progress
      ctx.beginPath()
      ctx.arc(0, 0, radius, 0, Math.PI * 2)
      ctx.strokeStyle = paint
      ctx.lineWidth = Math.max(1, p.size * 0.45 * (1 - progress))
      ctx.stroke()
      break
    }
    case "star": {
      tracePolygonStar(ctx, 4, p.size * (1 + p.seed * 0.4), p.size * 0.32)
      ctx.fillStyle = paint
      ctx.fill()
      break
    }
    case "spark": {
      tracePolygonStar(ctx, 4, p.size, p.size * 0.14)
      ctx.fillStyle = paint
      ctx.fill()
      break
    }
    case "petal": {
      tracePetal(ctx, p.size)
      ctx.fillStyle = paint
      ctx.fill("evenodd")
      break
    }
    case "flake": {
      traceFlake(ctx, p.size)
      ctx.strokeStyle = paint
      ctx.lineWidth = Math.max(0.8, p.size * 0.16)
      ctx.lineCap = "round"
      ctx.stroke()
      break
    }
    case "bubble": {
      ctx.beginPath()
      ctx.arc(0, 0, p.size, 0, Math.PI * 2)
      ctx.strokeStyle = paint
      ctx.lineWidth = Math.max(0.9, p.size * 0.18)
      ctx.stroke()
      // Specular dot — what makes a stroked circle read as a bubble.
      ctx.beginPath()
      ctx.arc(-p.size * 0.35, -p.size * 0.35, Math.max(0.6, p.size * 0.16), 0, Math.PI * 2)
      ctx.fillStyle = particleColor(p, color, alpha * 0.8)
      ctx.fill()
      break
    }
    case "flame": {
      traceFlame(ctx, p.size * (1 - progress * 0.45))
      ctx.fillStyle = paint
      ctx.fill()
      break
    }
    case "dot":
    default: {
      ctx.beginPath()
      ctx.arc(0, 0, p.size * (1 - progress * 0.55), 0, Math.PI * 2)
      ctx.fillStyle = paint
      ctx.fill()
      break
    }
  }

  ctx.restore()
  return true
}

/**
 * Stroke the ribbon: one tapered, smoothed polyline through the live nodes.
 * Drawn as a series of quadratic segments through the midpoints, which removes
 * the visible corner every raw pointer sample would otherwise leave.
 */
export function drawRibbon(
  ctx: CanvasRenderingContext2D,
  particles: readonly Particle[],
  color: string,
  baseWidth: number
): void {
  if (particles.length < 2) return
  ctx.lineCap = "round"
  ctx.lineJoin = "round"
  for (let i = 1; i < particles.length; i++) {
    const prev = particles[i - 1]
    const cur = particles[i]
    // `i / length` tapers head-to-tail; the head is the newest sample.
    const t = i / particles.length
    const alpha = fadeAlpha(particleProgress(cur)) * 0.9
    if (alpha <= 0.002) continue
    ctx.beginPath()
    ctx.moveTo(prev.x, prev.y)
    ctx.quadraticCurveTo(prev.x, prev.y, (prev.x + cur.x) / 2, (prev.y + cur.y) / 2)
    ctx.lineTo(cur.x, cur.y)
    ctx.strokeStyle = particleColor(cur, color, alpha)
    ctx.lineWidth = Math.max(0.5, baseWidth * t)
    ctx.stroke()
  }
}

/** Soft halo locked to the pointer (the `glow` effect). */
export function drawHalo(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  opacity: number,
  color: string
): void {
  if (radius <= 0 || opacity <= 0) return
  const [r, g, b] = toRgbTriple(color)
  const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius)
  gradient.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${opacity.toFixed(3)})`)
  gradient.addColorStop(0.55, `rgba(${r}, ${g}, ${b}, ${(opacity * 0.35).toFixed(3)})`)
  gradient.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`)
  ctx.fillStyle = gradient
  ctx.beginPath()
  ctx.arc(x, y, radius, 0, Math.PI * 2)
  ctx.fill()
}

export interface DrawFrameOptions {
  spec: EffectSpec
  /** Flat color for non-rainbow modes. */
  color: string
  width: number
  height: number
  /** Current pointer position, for the halo. `null` before the first move. */
  pointer: { x: number; y: number } | null
  /** Scales the ribbon width and halo radius with the user's size slider. */
  scale: number
}

/** Clear and repaint the whole overlay for one frame. */
export function drawFrame(
  ctx: CanvasRenderingContext2D,
  state: SimState,
  options: DrawFrameOptions
): void {
  const { spec, color, width, height, pointer, scale } = options
  ctx.clearRect(0, 0, width, height)
  ctx.globalCompositeOperation = spec.additive ? "lighter" : "source-over"

  if (spec.halo && pointer) {
    drawHalo(ctx, pointer.x, pointer.y, spec.halo.radius * scale, spec.halo.opacity, color)
  }
  if (spec.connect) {
    drawRibbon(ctx, state.particles, color, 6 * scale)
  }
  for (const p of state.particles) drawParticle(ctx, p, spec, color)

  ctx.globalCompositeOperation = "source-over"
}
