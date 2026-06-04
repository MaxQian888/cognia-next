/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from "@testing-library/react"
import type { EvalRunRow } from "@/lib/db/eval-runs"
import type { EvalRunCaseRow } from "@/lib/db/eval-run-cases"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vals?: Record<string, unknown>) =>
    vals ? `${key}:${JSON.stringify(vals)}` : key,
}))

const rows: Record<string, EvalRunCaseRow[]> = {
  A: [{ id: "A::c1", runId: "A", caseId: "c1", scores: {}, passAt1: true }],
  B: [{ id: "B::c1", runId: "B", caseId: "c1", scores: {}, passAt1: false }],
}
const listCaseResults = jest.fn(async (id: string) => rows[id] ?? [])
jest.mock("@/lib/db/eval-run-cases", () => ({
  listCaseResults: (...a: unknown[]) => listCaseResults(...(a as [string])),
}))

import { RunComparisonView } from "./run-comparison-view"

const run = (runId: string, passAt1: number): EvalRunRow =>
  ({
    runId,
    datasetId: "d",
    datasetVersion: 1,
    targetLabel: runId,
    k: 1,
    caseCount: 1,
    scorers: {},
    passAt1,
    passHatK: 0,
    totalCostUsd: 0,
    avgLatencyMs: 0,
    createdAt: 0,
  }) as EvalRunRow

describe("RunComparisonView", () => {
  it("auto-selects two runs, loads results, and flags a regression cell", async () => {
    render(<RunComparisonView runs={[run("A", 1), run("B", 0)]} inputsByCase={{ c1: "hi" }} />)
    // the case input renders twice: small-screen cards + the desktop table
    await waitFor(() => expect(screen.getAllByText("hi")).toHaveLength(2))
    // c1: A passed, B failed -> B cell is a regression
    const regressionCells = document.querySelectorAll('[data-regression="true"]')
    expect(regressionCells.length).toBe(1)
  })

  it("renders the per-case card list for small screens alongside the table", async () => {
    render(<RunComparisonView runs={[run("A", 1), run("B", 0)]} inputsByCase={{ c1: "hi" }} />)
    await waitFor(() => expect(screen.getByTestId("compare-cards")).toBeInTheDocument())
    const cards = screen.getByTestId("compare-cards")
    expect(cards).toHaveTextContent("A: compare.pass")
    expect(cards).toHaveTextContent("B: compare.fail")
  })

  it("prompts to pick two when fewer than two runs exist", () => {
    render(<RunComparisonView runs={[run("A", 1)]} />)
    expect(screen.getByText("compare.pickTwo")).toBeInTheDocument()
  })
})
