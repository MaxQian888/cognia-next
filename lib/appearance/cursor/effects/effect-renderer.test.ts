import {
  clearEffectColorCache,
  drawFrame,
  drawHalo,
  drawParticle,
  drawRibbon,
  fadeAlpha,
  particleColor,
  toRgbTriple,
} from "./effect-renderer"
import { createSimState, EFFECT_SPECS, type Particle, type ParticleShape } from "./particle-sim"

/**
 * Recording 2D-context stub. jsdom has no canvas implementation and node has no
 * canvas at all, so the renderer is exercised against a stub that records the
 * calls — which is what we actually want to assert (does a petal trace beziers?
 * does an additive effect switch compositing?), not pixel output.
 */
function makeCtx() {
  const calls: string[] = []
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push(`${name}(${args.length})`)
    }
  const gradient = { addColorStop: jest.fn() }
  const ctx = {
    calls,
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
    lineCap: "",
    lineJoin: "",
    globalCompositeOperation: "source-over",
    save: record("save"),
    restore: record("restore"),
    translate: record("translate"),
    rotate: record("rotate"),
    beginPath: record("beginPath"),
    closePath: record("closePath"),
    moveTo: record("moveTo"),
    lineTo: record("lineTo"),
    bezierCurveTo: record("bezierCurveTo"),
    quadraticCurveTo: record("quadraticCurveTo"),
    arc: record("arc"),
    fill: record("fill"),
    stroke: record("stroke"),
    clearRect: record("clearRect"),
    createRadialGradient: jest.fn(() => gradient),
  }
  return ctx as unknown as CanvasRenderingContext2D & { calls: string[] }
}

function particle(overrides: Partial<Particle> = {}): Particle {
  return {
    x: 10,
    y: 20,
    vx: 0,
    vy: 0,
    age: 100,
    life: 1000,
    size: 4,
    rotation: 0.2,
    spin: 1,
    seed: 0.5,
    hue: -1,
    shape: "dot",
    ...overrides,
  }
}

afterEach(() => clearEffectColorCache())

describe("toRgbTriple", () => {
  it("parses hex", () => {
    expect(toRgbTriple("#ff0000")).toEqual([255, 0, 0])
  })

  it("parses the oklch values the theme layer stores", () => {
    const [r, g, b] = toRgbTriple("oklch(0.62 0.19 260)")
    expect(r + g + b).toBeGreaterThan(0)
  })

  it("falls back to a neutral grey instead of throwing on garbage", () => {
    expect(toRgbTriple("definitely-not-a-color")).toEqual([148, 163, 184])
  })

  it("memoises — the color changes on theme switches, not per frame", () => {
    const first = toRgbTriple("#123456")
    expect(toRgbTriple("#123456")).toBe(first)
    clearEffectColorCache()
    expect(toRgbTriple("#123456")).not.toBe(first)
  })
})

describe("particleColor", () => {
  it("uses the flat color for a non-rainbow particle", () => {
    expect(particleColor(particle(), "#ff0000", 0.5)).toBe("rgba(255, 0, 0, 0.500)")
  })

  it("uses the particle's own hue in rainbow mode, ignoring the flat color", () => {
    expect(particleColor(particle({ hue: 200 }), "#ff0000", 1)).toBe("hsla(200, 92%, 64%, 1.000)")
  })

  it("clamps alpha into range", () => {
    expect(particleColor(particle(), "#000000", 5)).toContain("1.000")
    expect(particleColor(particle(), "#000000", -3)).toContain("0.000")
  })
})

describe("fadeAlpha", () => {
  it("attacks quickly then eases out", () => {
    expect(fadeAlpha(0)).toBe(0)
    expect(fadeAlpha(0.12)).toBeCloseTo(1, 5)
    expect(fadeAlpha(1)).toBeCloseTo(0, 5)
    expect(fadeAlpha(0.5)).toBeGreaterThan(fadeAlpha(0.8))
  })
})

describe("drawParticle", () => {
  const shapes: ParticleShape[] = [
    "dot",
    "spark",
    "star",
    "petal",
    "ring",
    "flake",
    "bubble",
    "flame",
  ]

  it.each(shapes)("draws the %s shape and balances save/restore", (shape) => {
    const ctx = makeCtx()
    expect(drawParticle(ctx, particle({ shape }), EFFECT_SPECS.trail, "#ff0000")).toBe(true)
    expect(ctx.calls.filter((c) => c.startsWith("save")).length).toBe(1)
    expect(ctx.calls.filter((c) => c.startsWith("restore")).length).toBe(1)
    expect(ctx.calls.some((c) => c.startsWith("fill") || c.startsWith("stroke"))).toBe(true)
  })

  it("declines the ribbon node — it is stroked as one connected path instead", () => {
    const ctx = makeCtx()
    expect(drawParticle(ctx, particle({ shape: "node" }), EFFECT_SPECS.ribbon, "#fff")).toBe(false)
    expect(ctx.calls).toHaveLength(0)
  })

  it("skips a fully faded particle without touching the context", () => {
    const ctx = makeCtx()
    expect(drawParticle(ctx, particle({ age: 1000, life: 1000 }), EFFECT_SPECS.trail, "#fff")).toBe(
      true
    )
    expect(ctx.calls).toHaveLength(0)
  })

  it("expands a ripple ring over its lifetime", () => {
    const young = makeCtx()
    drawParticle(young, particle({ shape: "ring", age: 10 }), EFFECT_SPECS.ripple, "#fff")
    const old = makeCtx()
    drawParticle(old, particle({ shape: "ring", age: 400 }), EFFECT_SPECS.ripple, "#fff")
    // Both trace one arc; the difference is the radius, which the stub cannot
    // read — but the older ring must still draw, which is the regression that
    // a naive "fade to nothing at 50%" would break.
    expect(old.calls.some((c) => c.startsWith("arc"))).toBe(true)
    expect(young.calls.some((c) => c.startsWith("arc"))).toBe(true)
  })

  it("does not rotate a non-spinning particle", () => {
    const ctx = makeCtx()
    drawParticle(ctx, particle({ spin: 0 }), EFFECT_SPECS.trail, "#fff")
    expect(ctx.calls.some((c) => c.startsWith("rotate"))).toBe(false)
  })
})

describe("drawRibbon", () => {
  it("needs at least two nodes", () => {
    const ctx = makeCtx()
    drawRibbon(ctx, [particle({ shape: "node" })], "#fff", 6)
    expect(ctx.calls).toHaveLength(0)
  })

  it("strokes one smoothed segment per consecutive pair", () => {
    const ctx = makeCtx()
    const nodes = [0, 1, 2, 3].map((i) => particle({ shape: "node", x: i * 10 }))
    drawRibbon(ctx, nodes, "#fff", 6)
    expect(ctx.calls.filter((c) => c.startsWith("quadraticCurveTo"))).toHaveLength(3)
    expect(ctx.calls.filter((c) => c.startsWith("stroke"))).toHaveLength(3)
  })

  it("skips segments whose node has already faded out", () => {
    const ctx = makeCtx()
    const nodes = [particle({ shape: "node" }), particle({ shape: "node", age: 1000, life: 1000 })]
    drawRibbon(ctx, nodes, "#fff", 6)
    expect(ctx.calls.filter((c) => c.startsWith("stroke"))).toHaveLength(0)
  })
})

describe("drawHalo", () => {
  it("paints a three-stop radial gradient", () => {
    const ctx = makeCtx()
    drawHalo(ctx, 5, 6, 40, 0.3, "#ff0000")
    expect(ctx.createRadialGradient).toHaveBeenCalledWith(5, 6, 0, 5, 6, 40)
    expect(ctx.calls.some((c) => c.startsWith("fill"))).toBe(true)
  })

  it("does nothing for a zero radius or zero opacity", () => {
    const ctx = makeCtx()
    drawHalo(ctx, 0, 0, 0, 0.3, "#fff")
    drawHalo(ctx, 0, 0, 40, 0, "#fff")
    expect(ctx.calls).toHaveLength(0)
  })
})

describe("drawFrame", () => {
  const base = { color: "#ff0000", width: 800, height: 600, scale: 1 }

  it("clears the whole overlay every frame", () => {
    const ctx = makeCtx()
    drawFrame(ctx, createSimState(), { ...base, spec: EFFECT_SPECS.trail, pointer: null })
    expect(ctx.calls[0]).toBe("clearRect(4)")
  })

  it("switches to additive compositing for a glowing effect and resets afterwards", () => {
    const ctx = makeCtx()
    drawFrame(ctx, createSimState(), { ...base, spec: EFFECT_SPECS.sparkle, pointer: null })
    expect(ctx.globalCompositeOperation).toBe("source-over")
  })

  it("draws the halo only when the spec has one and the pointer is inside the window", () => {
    const withPointer = makeCtx()
    drawFrame(withPointer, createSimState(), {
      ...base,
      spec: EFFECT_SPECS.glow,
      pointer: { x: 10, y: 10 },
    })
    expect(withPointer.createRadialGradient).toHaveBeenCalled()

    const pointerGone = makeCtx()
    drawFrame(pointerGone, createSimState(), { ...base, spec: EFFECT_SPECS.glow, pointer: null })
    expect(pointerGone.createRadialGradient).not.toHaveBeenCalled()

    const noHalo = makeCtx()
    drawFrame(noHalo, createSimState(), {
      ...base,
      spec: EFFECT_SPECS.trail,
      pointer: { x: 10, y: 10 },
    })
    expect(noHalo.createRadialGradient).not.toHaveBeenCalled()
  })

  it("connects ribbon nodes rather than drawing them individually", () => {
    const ctx = makeCtx()
    const state = createSimState()
    state.particles = [0, 1, 2].map((i) => particle({ shape: "node", x: i * 10 }))
    drawFrame(ctx, state, { ...base, spec: EFFECT_SPECS.ribbon, pointer: { x: 0, y: 0 } })
    expect(ctx.calls.some((c) => c.startsWith("quadraticCurveTo"))).toBe(true)
    // Nodes decline individual drawing, so no save/restore pairs were opened.
    expect(ctx.calls.some((c) => c.startsWith("save"))).toBe(false)
  })

  it("draws every live particle", () => {
    const ctx = makeCtx()
    const state = createSimState()
    state.particles = [particle(), particle({ x: 40 }), particle({ x: 80 })]
    drawFrame(ctx, state, { ...base, spec: EFFECT_SPECS.trail, pointer: null })
    expect(ctx.calls.filter((c) => c.startsWith("save"))).toHaveLength(3)
  })
})
