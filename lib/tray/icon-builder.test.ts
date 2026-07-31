import { buildLucideSvg, drawBadge, __STATE_NODES_FOR_TESTING } from "./icon-builder"

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
