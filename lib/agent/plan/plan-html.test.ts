import {
  buildPlanHtml,
  resolvePlanHtmlStyle,
  PLAN_HTML_MSG,
  PLAN_HTML_STYLES,
  type BuildPlanHtmlInput,
} from "./plan-html"

const LABELS = {
  titleLabel: "Title",
  stepsLabel: "Steps",
  addStep: "Add step",
  deleteStep: "Delete step",
  moveUp: "Move up",
  moveDown: "Move down",
  dragHint: "Drag to reorder",
  save: "Save changes",
  reset: "Reset",
  empty: "No steps yet.",
  originalPlan: "Original plan",
  stepPlaceholder: "Describe this step…",
}

function input(over: Partial<BuildPlanHtmlInput> = {}): BuildPlanHtmlInput {
  return {
    title: "Ship the feature",
    steps: [
      { id: "s1", title: "Research", status: "pending" },
      { id: "s2", title: "Implement", status: "completed" },
    ],
    labels: LABELS,
    theme: "light",
    ...over,
  }
}

describe("buildPlanHtml", () => {
  it("produces a self-contained document with the JSON data island", () => {
    const html = buildPlanHtml(input())
    expect(html).toContain("<!DOCTYPE html>")
    expect(html).toContain('<script type="application/json" id="plan-data">')
    const island = html.match(/id="plan-data">(.*?)<\/script>/s)?.[1]
    expect(island).toBeTruthy()
    const data = JSON.parse(island as string)
    expect(data.title).toBe("Ship the feature")
    expect(data.steps).toEqual([
      { id: "s1", title: "Research", status: "pending" },
      { id: "s2", title: "Implement", status: "completed" },
    ])
    expect(data.labels).toEqual(LABELS)
  })

  it("escapes </script> sequences inside plan data so the island cannot break out", () => {
    const html = buildPlanHtml(
      input({
        steps: [{ id: "s1", title: '</script><script>alert("x")</script>', status: "pending" }],
      })
    )
    // The raw closing tag must never appear inside the JSON island.
    const island = html.match(/id="plan-data">(.*?)<\/script>/s)?.[1] as string
    expect(island).not.toContain("</script>")
    expect(island).toContain("\\u003c")
    // Round-trips losslessly.
    expect(JSON.parse(island).steps[0].title).toBe('</script><script>alert("x")</script>')
  })

  it("escapes label text interpolated into markup", () => {
    const html = buildPlanHtml(
      input({ labels: { ...LABELS, addStep: '<img src=x onerror="pwn()">' } })
    )
    expect(html).not.toContain('<img src=x onerror="pwn()">')
    expect(html).toContain("&lt;img src=x onerror=&quot;pwn()&quot;&gt;")
  })

  it("applies the theme class", () => {
    expect(buildPlanHtml(input({ theme: "light" }))).toContain(
      '<body class="theme-light style-default">'
    )
    expect(buildPlanHtml(input({ theme: "dark" }))).toContain(
      '<body class="theme-dark style-default">'
    )
  })

  it("applies each built-in style preset as a body class with its CSS shipped", () => {
    for (const style of PLAN_HTML_STYLES) {
      const html = buildPlanHtml(input({ style }))
      expect(html).toContain(`style-${style}`)
    }
    // Preset CSS is baked into every document (body class picks the active one).
    const html = buildPlanHtml(input())
    expect(html).toContain("body.style-compact")
    expect(html).toContain("body.style-timeline")
    expect(html).toContain("body.style-cards")
  })

  it("falls back to the default style for unknown persisted values", () => {
    expect(resolvePlanHtmlStyle("cards")).toBe("cards")
    expect(resolvePlanHtmlStyle("neon")).toBe("default")
    expect(resolvePlanHtmlStyle(undefined)).toBe("default")
    expect(resolvePlanHtmlStyle(42)).toBe("default")
    const html = buildPlanHtml(input({ style: "nope" as never }))
    expect(html).toContain('<body class="theme-light style-default">')
  })

  it("renders the original markdown block only when planText is present, escaped", () => {
    const without = buildPlanHtml(input())
    expect(without).not.toContain("<details>")

    const withText = buildPlanHtml(input({ planText: "# Plan\n\n- do <b>things</b>" }))
    expect(withText).toContain("<details>")
    expect(withText).toContain("Original plan")
    expect(withText).toContain("- do &lt;b&gt;things&lt;/b&gt;")
    expect(withText).not.toContain("<b>things</b>")

    // Whitespace-only planText is treated as absent.
    expect(buildPlanHtml(input({ planText: "   \n " }))).not.toContain("<details>")
  })

  it("bakes the postMessage protocol into the document script", () => {
    const html = buildPlanHtml(input())
    expect(html).toContain(`"${PLAN_HTML_MSG.ready}"`)
    expect(html).toContain(`"${PLAN_HTML_MSG.resize}"`)
    expect(html).toContain(`"${PLAN_HTML_MSG.save}"`)
  })

  it("never loads external resources", () => {
    const html = buildPlanHtml(input({ planText: "body" }))
    expect(html).not.toMatch(/src\s*=\s*["']https?:/i)
    expect(html).not.toMatch(/<link/i)
    expect(html).not.toMatch(/@import/i)
  })
})
