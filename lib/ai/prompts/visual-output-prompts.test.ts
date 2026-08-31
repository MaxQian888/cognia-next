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
    const section = buildVisualOutputSection(inApp)!
    expect(section.length).toBeLessThan(1_400)
  })

  it("opens with a heading so it reads as its own section when appended", () => {
    expect(buildVisualOutputSection(inApp)!.startsWith("## ")).toBe(true)
  })
})
