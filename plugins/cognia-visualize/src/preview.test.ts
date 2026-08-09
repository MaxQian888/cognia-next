/** @jest-environment jsdom */
import { createVisualization } from "./model"
import { renderVisualization } from "./preview"

it("renders an accessible visual and exact-value fallback table", () => {
  const root = renderVisualization(
    createVisualization({ title: "Revenue", profile: "bar", data: [{ label: "Q1", value: 10 }] })
  )
  expect(root).toHaveAccessibleName("Revenue: 1 data points.")
  expect(root.querySelector("svg")).toHaveAttribute("role", "img")
  expect(root.querySelector("table")).toHaveTextContent("Q1")
})
