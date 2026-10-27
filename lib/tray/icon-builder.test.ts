/** @jest-environment jsdom */
import {
  buildLucideSvg,
  buildMacOsTraySvg,
  drawBadge,
  rasterizeSvgToPng,
  __STATE_NODES_FOR_TESTING,
} from "./icon-builder"
import { isMacOs } from "@/lib/platform/os"

jest.mock("@/src-tauri/icons/128x128.png", () => ({ src: "/character.png" }))
jest.mock("@/lib/platform/os", () => ({ isMacOs: jest.fn(() => false) }))

it("uses macOS template glyphs while retaining character artwork on other desktops", async () => {
  const images: Array<{ src: string }> = []
  const textComposites: string[] = []
  const context = {
    clearRect: jest.fn(),
    drawImage: jest.fn(),
    save: jest.fn(),
    restore: jest.fn(),
    beginPath: jest.fn(),
    roundRect: jest.fn(),
    fill: jest.fn(),
    globalCompositeOperation: "source-over",
    fillText: jest.fn((): void => {
      textComposites.push(context.globalCompositeOperation)
    }),
  }
  const imageSpy = jest.spyOn(globalThis, "Image").mockImplementation(() => {
    let source = ""
    const image = {
      onload: null as (() => void) | null,
      get src() {
        return source
      },
      set src(value: string) {
        source = value
        images.push({ src: value })
        queueMicrotask(() => image.onload?.())
      },
    }
    return image as unknown as HTMLImageElement
  })
  const contextSpy = jest
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockReturnValue(context as unknown as ReturnType<HTMLCanvasElement["getContext"]>)
  const blobSpy = jest
    .spyOn(HTMLCanvasElement.prototype, "toBlob")
    .mockImplementation((callback) => {
      callback({ arrayBuffer: async () => new Uint8Array([137, 80, 78, 71]).buffer } as Blob)
    })
  const createUrl = jest.fn(() => "blob:status")
  const revokeUrl = jest.fn()
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createUrl })
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeUrl })
  try {
    await rasterizeSvgToPng(buildLucideSvg(__STATE_NODES_FOR_TESTING.busy, "#000"), 32, {
      text: "42%",
      color: "#f59e0b",
    })
    expect(images.some((image) => image.src === "/character.png")).toBe(true)
    expect(context.drawImage.mock.calls[0][0].src).toBe("/character.png")
    expect(context.drawImage.mock.calls[0].slice(1)).toEqual([0, 0, 32, 32])
    expect(context.drawImage.mock.calls[1].slice(3)).toEqual([14.4, 14.4])
    expect(context.fillText).toHaveBeenCalledWith(
      "42",
      expect.any(Number),
      expect.any(Number),
      expect.any(Number)
    )
    expect(revokeUrl).toHaveBeenCalledWith("blob:status")
    context.drawImage.mockClear()
    context.fill.mockClear()
    await rasterizeSvgToPng(
      buildLucideSvg(__STATE_NODES_FOR_TESTING.idle, "#000"),
      32,
      undefined,
      false
    )
    expect(context.drawImage).toHaveBeenCalledTimes(1)
    expect(context.drawImage.mock.calls[0].slice(1)).toEqual([0, 0, 32, 32])
    expect(context.fill).not.toHaveBeenCalled()

    // A macOS template uses the state glyph's alpha, without the character
    // or an opaque corner plate that AppKit would turn into a solid block.
    jest.mocked(isMacOs).mockReturnValue(true)
    for (const state of ["idle", "busy", "error", "muted"] as const) {
      images.length = 0
      context.drawImage.mockClear()
      context.fill.mockClear()
      await rasterizeSvgToPng(buildMacOsTraySvg(state), 36, undefined, state !== "idle")
      expect(images.map((image) => image.src)).toEqual(["blob:status"])
      expect(context.drawImage).toHaveBeenCalledTimes(1)
      expect(context.drawImage.mock.calls[0].slice(1)).toEqual([0, 0, 36, 36])
      expect(context.fill).not.toHaveBeenCalled()
    }
    textComposites.length = 0
    await rasterizeSvgToPng(buildMacOsTraySvg("busy"), 36, {
      text: "42%",
      color: "#f59e0b",
    })
    expect(textComposites).toEqual(["destination-out"])
  } finally {
    jest.mocked(isMacOs).mockReturnValue(false)
    imageSpy.mockRestore()
    contextSpy.mockRestore()
    blobSpy.mockRestore()
  }
})

describe("buildMacOsTraySvg", () => {
  it("keeps the same Cognia silhouette across distinct status details", () => {
    const icons = (["idle", "busy", "error", "muted"] as const).map(buildMacOsTraySvg)
    expect(new Set(icons).size).toBe(4)
    const paths = icons.map((svg) =>
      new DOMParser().parseFromString(svg, "image/svg+xml").querySelector("path")
    )
    expect(paths[0]?.getAttribute("fill")).toBe("#000000")
    expect(paths[0]?.getAttribute("stroke")).toBe("none")
    expect(paths.every((path) => path?.getAttribute("d") === paths[0]?.getAttribute("d"))).toBe(
      true
    )
  })

  it("has no opaque background or character image in any state", () => {
    for (const state of ["idle", "busy", "error", "muted"] as const) {
      const svg = new DOMParser().parseFromString(buildMacOsTraySvg(state), "image/svg+xml")
      expect(svg.querySelector("parsererror, rect, image")).toBeNull()
      expect(svg.documentElement.getAttribute("viewBox")).toBe("0 0 24 24")
      expect(svg.querySelector('[fill="#ffffff"]')).toBeNull()
    }
  })
})

describe("buildLucideSvg", () => {
  const stubNode: Array<[string, Record<string, string | number>]> = [
    [
      "path",
      {
        d: "M0 0 L24 24",
        strokeWidth: 1.5,
        key: "test-key",
      },
    ],
    ["circle", { cx: 12, cy: 12, r: 4 }],
  ]

  it("wraps the iconNode in a 24×24 svg with the default lucide attrs", () => {
    const svg = buildLucideSvg(stubNode, "#000")
    expect(svg).toMatch(/<svg [^>]*viewBox="0 0 24 24"/)
    expect(svg).toMatch(/<svg [^>]*width="24"/)
    expect(svg).toMatch(/<svg [^>]*height="24"/)
    expect(svg).toMatch(/<svg [^>]*fill="none"/)
  })

  it("substitutes the supplied color into stroke", () => {
    const svg = buildLucideSvg(stubNode, "#ff00aa")
    expect(svg).toMatch(/stroke="#ff00aa"/)
    expect(svg).not.toMatch(/stroke="currentColor"/)
  })

  it("converts camelCase node attrs to kebab-case (strokeWidth → stroke-width)", () => {
    const svg = buildLucideSvg(stubNode, "#000")
    expect(svg).toMatch(/stroke-width="1.5"/)
    expect(svg).not.toMatch(/strokeWidth=/)
  })

  it("drops React-only `key` attrs from each node", () => {
    const svg = buildLucideSvg(stubNode, "#000")
    expect(svg).not.toMatch(/key="test-key"/)
  })

  it("serialises every node tag from the iconNode", () => {
    const svg = buildLucideSvg(stubNode, "#000")
    expect(svg).toMatch(/<path /)
    expect(svg).toMatch(/<circle /)
  })

  it("escapes special characters in attribute values to keep the SVG parseable", () => {
    const svg = buildLucideSvg([["path", { d: 'M0 0 "&" 24 24' }]], "#000")
    expect(svg).not.toMatch(/"&"/)
    expect(svg).toMatch(/&amp;/)
  })

  it("produces self-closing element tags so the body parses as XML", () => {
    const svg = buildLucideSvg(stubNode, "#000")
    expect(svg).toMatch(/<path [^>]*\/>/)
    expect(svg).toMatch(/<circle [^>]*\/>/)
  })
})

describe("drawBadge", () => {
  // Minimal recording stand-in for CanvasRenderingContext2D — drawBadge only
  // touches the listed members, and running in the node env means no real
  // canvas exists anyway.
  function stubCtx() {
    const calls: Record<string, unknown[][]> = {}
    const record =
      (name: string) =>
      (...args: unknown[]) => {
        ;(calls[name] ??= []).push(args)
      }
    const ctx = {
      save: record("save"),
      restore: record("restore"),
      beginPath: record("beginPath"),
      roundRect: record("roundRect"),
      fill: record("fill"),
      fillText: record("fillText"),
      fillStyle: "",
      globalCompositeOperation: "source-over",
      textAlign: "",
      textBaseline: "",
      font: "",
    }
    return { ctx: ctx as unknown as CanvasRenderingContext2D, calls }
  }

  it("draws a pill and the badge text, stripping the % suffix", () => {
    const { ctx, calls } = stubCtx()
    drawBadge(ctx, 32, { text: "42%", color: "#f59e0b" })
    expect(calls.roundRect).toHaveLength(1)
    expect(calls.fill).toHaveLength(1)
    expect(calls.fillText?.[0]?.[0]).toBe("42")
    expect(calls.restore).toHaveLength(1)
  })

  it("clamps the rendered text to 3 glyphs for tray-icon legibility", () => {
    const { ctx, calls } = stubCtx()
    drawBadge(ctx, 32, { text: "$8.505", color: "#10b981" })
    expect(calls.fillText?.[0]?.[0]).toBe("$8.")
  })

  it("no-ops when the text strips to nothing", () => {
    const { ctx, calls } = stubCtx()
    drawBadge(ctx, 32, { text: "%", color: "#10b981" })
    expect(calls.roundRect).toBeUndefined()
    expect(calls.fillText).toBeUndefined()
  })

  it("cuts usage text out of a monochrome pill so it survives template rendering", () => {
    const { ctx, calls } = stubCtx()
    drawBadge(ctx, 36, { text: "42%", color: "#f59e0b" }, true)
    expect(calls.fill).toHaveLength(1)
    expect(ctx.globalCompositeOperation).toBe("destination-out")
    expect(calls.fillText?.[0]?.[0]).toBe("42")
    expect(calls.restore).toHaveLength(1)
  })
})

describe("STATE_NODES", () => {
  it("provides an iconNode for every TrayIconState", () => {
    for (const state of ["idle", "busy", "error", "muted"] as const) {
      const nodes = __STATE_NODES_FOR_TESTING[state]
      expect(Array.isArray(nodes)).toBe(true)
      expect(nodes.length).toBeGreaterThan(0)
    }
  })

  it("every state's iconNode round-trips through buildLucideSvg producing a parseable SVG fragment", () => {
    for (const state of ["idle", "busy", "error", "muted"] as const) {
      const svg = buildLucideSvg(__STATE_NODES_FOR_TESTING[state], "#000000")
      expect(svg.startsWith("<svg ")).toBe(true)
      expect(svg.endsWith("</svg>")).toBe(true)
      expect(svg).toMatch(/<path [^>]*d="[^"]+"/)
    }
  })
})
