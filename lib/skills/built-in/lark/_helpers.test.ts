import { argsToFlags, buildConfirmSurface, capLarkData, MAX_RESULT_DISPLAY_CHARS } from "./_helpers"

describe("argsToFlags", () => {
  it("kebab-cases keys and stringifies scalar values", () => {
    expect(argsToFlags({ calendarId: "primary", pageSize: 50 })).toEqual([
      "--calendar-id",
      "primary",
      "--page-size",
      "50",
    ])
  })

  it("emits a bare flag for true booleans and omits false/undefined/null", () => {
    expect(argsToFlags({ notifyAttendees: true, dryRun: false, note: undefined, x: null })).toEqual(
      ["--notify-attendees"]
    )
  })

  it("repeats the flag for each array element and JSON-encodes objects", () => {
    expect(argsToFlags({ assignees: ["a", "b"] })).toEqual(["--assignees", "a", "--assignees", "b"])
    expect(argsToFlags({ fields: { Name: "Acme" } })).toEqual(["--fields", '{"Name":"Acme"}'])
  })

  it("skips the listed keys", () => {
    expect(argsToFlags({ confirmed: true, query: "x" }, ["confirmed"])).toEqual(["--query", "x"])
  })
})

describe("buildConfirmSurface", () => {
  it("builds a card with confirm/cancel actions and detail rows", () => {
    const s = buildConfirmSurface({
      surfaceId: "sfc_1",
      title: "Delete",
      summary: "Delete the thing.",
      details: [{ label: "Id", value: "rec_1" }],
    })
    expect(s.rootId).toBe("sfc_1")
    expect(s.components.btn_confirm.props?.action).toEqual({ type: "button", value: "confirm" })
    expect(s.components.detail_0.props?.text).toContain("rec_1")
    // Card children wire summary + detail rows + the actions row.
    expect(s.components.sfc_1.children).toEqual(["summary", "detail_0", "actions"])
  })
})

describe("capLarkData", () => {
  it("passes small objects through unchanged", () => {
    const data = { records: [{ id: "rec_1" }] }
    expect(capLarkData(data)).toBe(data)
  })

  it("passes short strings through unchanged", () => {
    expect(capLarkData("hello")).toBe("hello")
  })

  it("truncates an oversized string with a hint", () => {
    const big = "x".repeat(MAX_RESULT_DISPLAY_CHARS + 100)
    const out = capLarkData(big) as string
    expect(out.length).toBeLessThan(MAX_RESULT_DISPLAY_CHARS + 80)
    expect(out).toMatch(/output truncated/)
  })

  it("wraps an oversized object in a truncation envelope with a preview", () => {
    const big = { rows: Array.from({ length: 5000 }, (_, i) => ({ i, name: `row-${i}` })) }
    const out = capLarkData(big) as { truncated: boolean; note: string; preview: string }
    expect(out.truncated).toBe(true)
    expect(out.note).toMatch(/Narrow the query/)
    expect(out.preview.length).toBeLessThanOrEqual(MAX_RESULT_DISPLAY_CHARS + 1)
  })

  it("returns non-serializable values untouched", () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(capLarkData(cyclic)).toBe(cyclic)
  })
})
