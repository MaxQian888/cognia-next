import { buildVisualOutputSection } from "./visual-output-prompts"

describe("buildVisualOutputSection", () => {
  const inApp = { artifacts: "tools" as const, a2ui: true }
  const imThread = { artifacts: "disabled" as const, a2ui: true }

  it("always routes structural work to mermaid, on every channel", () => {
    // The one channel that renders everywhere: inline in the message, no dock,
    // no connector capability needed.
    for (const channels of [inApp, imThread, { artifacts: "disabled" as const, a2ui: false }]) {
      const section = buildVisualOutputSection(channels)!
      expect(section).toContain("`mermaid`")
      expect(section).toContain("diagram-design")
    }
  })

  it("offers the chart artifact only where a dock exists to open it", () => {
    expect(buildVisualOutputSection(inApp)).toContain("chart-design")
    const im = buildVisualOutputSection(imThread)!
    expect(im).not.toContain("chart-design")
    // And says why, rather than silently omitting the option: a model that
    // emits one anyway should know the reader gets raw JSON.
    expect(im).toContain("no artifact dock")
  })

  it("uses the safe fallback when the user disables artifact authoring", () => {
    const section = buildVisualOutputSection({ artifacts: "disabled", a2ui: true })!
    expect(section).not.toContain("artifact_create")
    expect(section).not.toContain("chart-design")
    expect(section).toContain("markdown table")
  })

  it("uses a supported fenced payload only when authoring and auto-detection remain available", () => {
    const section = buildVisualOutputSection({ artifacts: "fenced", a2ui: false })!
    expect(section).toContain("fenced")
    expect(section).not.toContain("artifact_create")
    expect(section).toContain("never expose raw")
  })

  it("offers canvas only where a dock exists", () => {
    expect(buildVisualOutputSection(inApp)).toContain("canvas_create")
    expect(buildVisualOutputSection(imThread)).not.toContain("canvas_create")
    expect(buildVisualOutputSection(imThread)).toContain("do not emit a canvas payload")
  })

  it("names the tools it expects, not a fence the detector has to notice", () => {
    // The fence route depended on the heuristic detector lifting a code block
    // at turn end, which cannot name the artifact or set a chart's shape.
    const section = buildVisualOutputSection(inApp)!
    expect(section).toContain("artifact_create")
    expect(section).toContain("artifact_update")
  })

  it("names A2UI only when A2UI is enabled for the send", () => {
    expect(buildVisualOutputSection(inApp)).toContain("A2UI")
    expect(buildVisualOutputSection({ artifacts: "tools", a2ui: false })).not.toContain("A2UI")
  })

  it("tells the model when NOT to draw anything at all", () => {
    // The most common failure is a chart of three numbers, so this line is not
    // optional on any channel.
    for (const channels of [inApp, imThread]) {
      expect(buildVisualOutputSection(channels)).toContain("Three")
      expect(buildVisualOutputSection(channels)).toContain("markdown table")
    }
  })

  it("forbids hand-drawn SVG charts only where the real thing is available", () => {
    expect(buildVisualOutputSection(inApp)).toContain("Never hand-draw a chart as SVG")
    expect(buildVisualOutputSection(imThread)).not.toContain("Never hand-draw")
  })

  it("stays small enough to sit in every system prompt", () => {
    // It is appended to every send. A decision table, not a style guide.
    //
    // The ceiling was 1_400 and could not survive the contracts this section
    // was missing: the leanest `tools` variant alone lands at 1_420 with them.
    // Raising it was the deliberate call. 1_700 chars is roughly 425 tokens,
    // about 0.2% of a 200k context, and it sits in the cached system prefix,
    // so the steady-state marginal cost is a cache read. The largest variant
    // lands near 1_534, which leaves the same kind of headroom the old number
    // did, so the ceiling still forces this conversation rather than drifting.
    const section = buildVisualOutputSection(inApp)!
    expect(section.length).toBeLessThan(1_700)
  })

  it("keeps the channel with no dock the cheapest one", () => {
    // An IM thread pays for routing it cannot use, so it must stay small even
    // as the `tools` branch grows. This is the principle the single global
    // ceiling above cannot express on its own.
    expect(buildVisualOutputSection(imThread)!.length).toBeLessThan(1_100)
  })

  it("carries the two mermaid rules that fail silently, on every channel", () => {
    // `diagram-design` is gated on artifact-authoring, so it never reaches an
    // IM thread, and an IM thread is the one channel where mermaid is the only
    // surface left. An unquoted label renders an error card instead of a
    // diagram, and a pinned palette is unreadable in the other theme. Neither
    // is recoverable from anywhere else in the environment.
    for (const channels of [inApp, imThread, { artifacts: "fenced" as const, a2ui: false }]) {
      const section = buildVisualOutputSection(channels)!
      expect(section).toContain("Quote any label")
      expect(section).toContain("%%{init}%%")
    }
  })

  it("requires the type envelope on the fenced chart route", () => {
    // Detection only stamps a shape it can resolve, and the renderer falls back
    // to a line chart otherwise, so an envelope-less payload silently loses its
    // shape. The old wording described the ROWS and never mentioned the wrapper.
    const section = buildVisualOutputSection({ artifacts: "fenced", a2ui: false })!
    expect(section).toContain('"type"')
    expect(section).toContain("line chart")
  })

  it("tells the model to read a canvas before rewriting it", () => {
    // `canvas_update` replaces the whole buffer. The tool schema says it stages
    // a diff; nothing but this says to read the user's edits first. The
    // `language` and `type` enums stay out of here precisely because the schema
    // does carry those.
    const section = buildVisualOutputSection(inApp)!
    expect(section).toContain("rewrites the whole")
    expect(section).toContain("canvas_read")
    expect(buildVisualOutputSection(imThread)).not.toContain("canvas_read")
  })

  it("opens with a heading so it reads as its own section when appended", () => {
    expect(buildVisualOutputSection(inApp)!.startsWith("## ")).toBe(true)
  })
})
