import {
  createVisualization,
  parseVisualization,
  recommendProfile,
  validateVisualization,
  VISUALIZATION_PROFILES,
} from "./model"

it("routes intents and validates every supported profile", () => {
  expect(VISUALIZATION_PROFILES).toHaveLength(22)
  expect(recommendProfile("show the quarterly trend")).toMatchObject({ profile: "line" })
  expect(recommendProfile("draw dependencies")).toMatchObject({ profile: "network" })
  const spec = createVisualization({
    title: "Revenue",
    profile: "bar",
    data: [{ label: "Q1", value: 10 }],
  })
  expect(validateVisualization(spec)).toEqual([])
})

it("requires graph endpoints and accessible summaries", () => {
  const spec = createVisualization({
    title: "Flow",
    profile: "sankey",
    data: [{ label: "A", value: 2 }],
  })
  expect(validateVisualization(spec)).toEqual(
    expect.arrayContaining([expect.objectContaining({ code: "graph.edge" })])
  )
})

it("parseVisualization normalizes shape so validation reports findings, not crashes", () => {
  const spec = parseVisualization(
    JSON.stringify({
      schemaVersion: 1,
      profile: "bar",
      data: [{ label: 7, value: "ten" }, null],
    })
  )
  expect(spec.palette.length).toBeGreaterThan(0)
  expect(spec.accessibility.showDataTable).toBe(true)
  const codes = validateVisualization(spec).map((finding) => finding.code)
  expect(codes).toEqual(expect.arrayContaining(["data.label", "data.value", "a11y.summary"]))
})

it("parseVisualization rejects malformed payloads with clean errors", () => {
  expect(() => parseVisualization('{"schemaVersion":1,"profile":"bar"}')).toThrow(
    "data must be an array"
  )
  expect(() => parseVisualization('{"schemaVersion":2,"profile":"bar","data":[]}')).toThrow(
    "Unsupported Cognia visualization schema"
  )
  expect(() => parseVisualization("[1,2]")).toThrow("Unsupported Cognia visualization schema")
})
