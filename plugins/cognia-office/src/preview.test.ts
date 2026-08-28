/** @jest-environment jsdom */

import type { Artifact } from "@cognia/plugin-sdk"
import { applyWorkbookOperations, createWorkbook, WORKBOOK_ARTIFACT_KIND } from "./model"
import { createWorkbookRenderer } from "./preview"

function artifact(content: string): Artifact {
  return {
    id: "a1",
    sessionId: "s1",
    messageId: "m1",
    type: "code",
    title: "Workbook",
    content,
    language: "json",
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    metadata: {
      plugin: { kind: WORKBOOK_ARTIFACT_KIND, schemaVersion: 1, ownerPluginId: "cognia-office" },
    },
  }
}

it("renders sheet tabs, styled cells, formulas, and updates in place", () => {
  const first = applyWorkbookOperations(createWorkbook("PnL", "Trades"), [
    {
      op: "setCell",
      sheet: "Trades",
      cell: "A1",
      value: { type: "number", formula: "1+1", value: 2, style: { font: { bold: true } } },
    },
    { op: "addSheet", title: "Summary" },
  ])
  const container = document.createElement("div")
  const handle = createWorkbookRenderer({
    sheets: "Sheets",
    validation: "Validation",
    empty: "Empty",
  }).mount(artifact(JSON.stringify(first)), container)
  expect(container.textContent).toContain("Trades")
  expect(container.textContent).toContain("Summary")
  expect(container.textContent).toContain("=1+1")
  expect(container.querySelector("td")?.style.fontWeight).toBe("700")

  const updated = applyWorkbookOperations(first, [
    { op: "setCell", sheet: "Summary", cell: "A1", value: { type: "string", value: "Ready" } },
  ])
  handle.update?.(artifact(JSON.stringify(updated)))
  ;(
    Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Summary"
    ) as HTMLButtonElement
  ).click()
  expect(container.textContent).toContain("Ready")
  handle.dispose()
  expect(container).toBeEmptyDOMElement()
})

it("renders validation severity, location, and remediation", () => {
  const workbook = createWorkbook("Warnings", "Data")
  workbook.unsupportedFeatures.push("External links will not be preserved.")
  const container = document.createElement("div")
  const handle = createWorkbookRenderer({
    sheets: "Sheets",
    validation: "Validation",
    empty: "Empty",
  }).mount(artifact(JSON.stringify(workbook)), container)

  expect(container.querySelector('[data-severity="warning"]')).toHaveTextContent(
    "External links will not be preserved."
  )
  expect(container.textContent).toContain("confirming")
  handle.dispose()
})

it("renders empty sheets and clamps the active tab after an update", () => {
  const workbook = applyWorkbookOperations(createWorkbook("Empty", "First"), [
    { op: "addSheet", title: "Second" },
  ])
  const container = document.createElement("div")
  const handle = createWorkbookRenderer({
    sheets: "Workbook sheets",
    validation: "Validation",
    empty: "Nothing here",
  }).mount(artifact(JSON.stringify(workbook)), container)

  expect(container.querySelector("nav")).toHaveAttribute("aria-label", "Workbook sheets")
  expect(container).toHaveTextContent("Nothing here")
  ;(container.querySelectorAll("button")[1] as HTMLButtonElement).click()
  const oneSheet = applyWorkbookOperations(workbook, [{ op: "deleteSheet", sheet: "First" }])
  handle.update?.(artifact(JSON.stringify(oneSheet)))
  expect(container.querySelectorAll("button")).toHaveLength(1)
  expect(container.querySelector("button")).toHaveAttribute("aria-pressed", "true")
})

it("renders merges, dimensions, all basic styles, blank values, and cell locations", () => {
  const workbook = applyWorkbookOperations(createWorkbook("Styled", "Data"), [
    {
      op: "setCell",
      sheet: "Data",
      cell: "A1",
      value: {
        type: "string",
        value: "Styled",
        style: {
          font: { bold: true, italic: true, color: "FF112233" },
          fill: { color: "#445566" },
          alignment: { horizontal: "right", vertical: "bottom", wrapText: false },
        },
      },
    },
    { op: "setCell", sheet: "Data", cell: "C2", value: { type: "blank" } },
    { op: "merge", sheet: "Data", range: "A1:B1" },
    { op: "setRowDimension", sheet: "Data", row: 2, height: 25, hidden: true },
    { op: "setColumnDimension", sheet: "Data", column: "A", width: 2 },
    { op: "setColumnDimension", sheet: "Data", column: "C", hidden: true },
  ])
  workbook.unsupportedFeatures.push("Feature loss warning")
  const container = document.createElement("div")
  createWorkbookRenderer({ sheets: "Sheets", validation: "Validation", empty: "Empty" }).mount(
    artifact(JSON.stringify(workbook)),
    container
  )

  const cells = container.querySelectorAll("td")
  const first = cells[0] as HTMLTableCellElement
  expect(first).toMatchObject({ rowSpan: 1, colSpan: 2 })
  expect(first.style).toMatchObject({
    fontWeight: "700",
    fontStyle: "italic",
    color: "rgb(17, 34, 51)",
    backgroundColor: "rgb(68, 85, 102)",
    textAlign: "right",
    verticalAlign: "bottom",
    whiteSpace: "nowrap",
    minWidth: "24px",
  })
  expect(container.querySelectorAll("tr")[1]).toHaveAttribute("hidden")
  expect(Array.from(cells).some((cell) => cell.hasAttribute("hidden"))).toBe(true)
  expect(container.querySelector('[data-severity="warning"]')).toHaveTextContent(
    "Feature loss warning"
  )
})
