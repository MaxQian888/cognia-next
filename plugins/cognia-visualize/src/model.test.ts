import {
  createVisualization,
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
