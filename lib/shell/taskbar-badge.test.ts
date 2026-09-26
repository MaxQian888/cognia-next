/**
 * The renderer draws through `createSurface` (`lib/images/codec.ts`), which
 * prefers `OffscreenCanvas`. A recording fake stands in for it here, as in the
 * codec's own suite: node has no canvas, and jsdom's has no 2D context.
 */

import {
  badgeIconSize,
  FALLBACK_BADGE_COLORS,
  readBadgeColors,
  renderTaskbarBadge,
} from "./taskbar-badge"

interface Op {
  op: string
  args?: unknown[]
  fillStyle?: string
  font?: string
}

/** A canvas colour parser in miniature: hex and `oklch(...)` parse, the rest is ignored. */
const PARSEABLE = /^(#[0-9a-f]{3,8}|oklch\(.+\))$/i

class RecordingContext {
  ops: Op[] = []
  font = ""
  textAlign = ""
  textBaseline = ""
  private currentFill = "#000000"

  get fillStyle(): string {
    return this.currentFill
  }
  set fillStyle(value: string) {
    if (PARSEABLE.test(value)) this.currentFill = value
  }

  clearRect(...args: unknown[]) {
    this.ops.push({ op: "clearRect", args })
  }
  beginPath() {
    this.ops.push({ op: "beginPath" })
  }
  arc(...args: unknown[]) {
    this.ops.push({ op: "arc", args })
  }
  fill() {
    this.ops.push({ op: "fill", fillStyle: this.currentFill })
  }
  fillText(...args: unknown[]) {
    this.ops.push({ op: "fillText", args, fillStyle: this.currentFill, font: this.font })
  }
  getImageData(_x: number, _y: number, width: number, height: number) {
    const data = new Uint8ClampedArray(width * height * 4)
    data[0] = 255
    data[3] = 128
    return { data, width, height }
  }
}

let lastContext: RecordingContext | null = null
class FakeOffscreenCanvas {
  constructor(
    readonly width: number,
    readonly height: number
  ) {}
  getContext() {
    lastContext = new RecordingContext()
    return lastContext
  }
}

const globalRef = globalThis as unknown as Record<string, unknown>
let originalOffscreen: unknown

beforeEach(() => {
  originalOffscreen = globalRef.OffscreenCanvas
  globalRef.OffscreenCanvas = FakeOffscreenCanvas
  lastContext = null
})

afterEach(() => {
  if (originalOffscreen === undefined) delete globalRef.OffscreenCanvas
  else globalRef.OffscreenCanvas = originalOffscreen
  delete globalRef.document
  delete globalRef.getComputedStyle
})

describe("badgeIconSize", () => {
  it("scales the 16 px small-icon edge by the display scale", () => {
    expect(badgeIconSize(1)).toBe(16)
    expect(badgeIconSize(1.5)).toBe(24)
    expect(badgeIconSize(2)).toBe(32)
  })

  it("stays within sane bounds for odd ratios", () => {
    expect(badgeIconSize(0)).toBe(16)
    expect(badgeIconSize(Number.NaN)).toBe(16)
    expect(badgeIconSize(0.5)).toBe(16)
    expect(badgeIconSize(10)).toBe(64)
  })
})

describe("readBadgeColors", () => {
  it("falls back without a document", () => {
    expect(readBadgeColors()).toEqual(FALLBACK_BADGE_COLORS)
  })

  it("reads the destructive tokens, falling back per missing token", () => {
    globalRef.document = { documentElement: {} }
    globalRef.getComputedStyle = () => ({
      getPropertyValue: (name: string) =>
        name === "--destructive" ? " oklch(0.577 0.245 27.325) " : "",
    })
    expect(readBadgeColors()).toEqual({
      background: "oklch(0.577 0.245 27.325)",
      foreground: FALLBACK_BADGE_COLORS.foreground,
    })
  })
})

describe("renderTaskbarBadge", () => {
  it("draws a filled circle and the label, and returns straight RGBA of the asked size", () => {
    const pixels = renderTaskbarBadge(7, {
      size: 32,
      colors: { background: "#112233", foreground: "#ffffff" },
    })
    expect(pixels.width).toBe(32)
    expect(pixels.height).toBe(32)
    expect(pixels.rgba).toBeInstanceOf(Uint8Array)
    expect(pixels.rgba).toHaveLength(32 * 32 * 4)
    expect(Array.from(pixels.rgba.slice(0, 4))).toEqual([255, 0, 0, 128])

    const ops = lastContext!.ops
    expect(ops.find((o) => o.op === "arc")?.args).toEqual([16, 16, 16, 0, Math.PI * 2])
    expect(ops.find((o) => o.op === "fill")?.fillStyle).toBe("#112233")
    const text = ops.find((o) => o.op === "fillText")!
    expect(text.args?.[0]).toBe("7")
    expect(text.fillStyle).toBe("#ffffff")
  })

  it("caps the label and shrinks the type to fit it", () => {
    renderTaskbarBadge(5, { size: 32 })
    const single = lastContext!.ops.find((o) => o.op === "fillText")!
    renderTaskbarBadge(250, { size: 32 })
    const capped = lastContext!.ops.find((o) => o.op === "fillText")!
    expect(capped.args?.[0]).toBe("99+")
    const px = (font?: string) => Number(/(\d+)px/.exec(font ?? "")?.[1])
    expect(px(capped.font)).toBeLessThan(px(single.font))
  })

  it("keeps the fallback colours when the canvas cannot parse a token", () => {
    renderTaskbarBadge(3, {
      size: 16,
      colors: { background: "color(unknown-space 1 0 0)", foreground: "nope" },
    })
    const ops = lastContext!.ops
    expect(ops.find((o) => o.op === "fill")?.fillStyle).toBe(FALLBACK_BADGE_COLORS.background)
    expect(ops.find((o) => o.op === "fillText")?.fillStyle).toBe(FALLBACK_BADGE_COLORS.foreground)
  })

  it("throws when the runtime has no canvas, so the caller can stop trying", () => {
    delete globalRef.OffscreenCanvas
    expect(() => renderTaskbarBadge(1, { size: 16 })).toThrow(/no 2D canvas/)
  })
})
