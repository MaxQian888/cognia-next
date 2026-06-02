/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { EvalCase } from "@/types/eval/eval"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vals?: Record<string, unknown>) =>
    vals ? `${key}:${JSON.stringify(vals)}` : key,
}))

let cases: EvalCase[] = []
jest.mock("@/hooks/eval/use-eval-data", () => ({
  useEvalCases: () => cases,
}))
const addCase = jest.fn(async () => ({ id: "c-new" }))
const updateCase = jest.fn(async () => ({}))
const deleteCase = jest.fn(async () => {})
jest.mock("@/lib/db/eval-datasets", () => ({
  addCase: (...a: unknown[]) => addCase(...(a as [])),
  updateCase: (...a: unknown[]) => updateCase(...(a as [])),
  deleteCase: (...a: unknown[]) => deleteCase(...(a as [])),
}))

import { CaseList } from "./case-list"

function caseRow(over: Partial<EvalCase>): EvalCase {
  return {
    id: "c1",
    datasetId: "d",
    input: "hello",
    capability: "chat",
    source: "handwritten",
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }
}

beforeEach(() => {
  cases = []
  addCase.mockClear()
  updateCase.mockClear()
  deleteCase.mockClear()
})

describe("CaseList", () => {
  it("shows the empty state and opens the editor to add a case", async () => {
    render(<CaseList datasetId="d" />)
    expect(screen.getByText("case.empty")).toBeInTheDocument()
    fireEvent.click(screen.getByText("case.add"))
    expect(screen.getByTestId("case-editor")).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText("case.input"), { target: { value: "new case" } })
    fireEvent.click(screen.getByText("case.save"))
    await waitFor(() =>
      expect(addCase).toHaveBeenCalledWith("d", expect.objectContaining({ input: "new case" }))
    )
  })

  it("renders cases and deletes one", () => {
    cases = [caseRow({ id: "c1", input: "first" }), caseRow({ id: "c2", input: "second" })]
    render(<CaseList datasetId="d" />)
    expect(screen.getByText("first")).toBeInTheDocument()
    expect(screen.getByText("second")).toBeInTheDocument()
    fireEvent.click(screen.getAllByLabelText("case.delete")[0])
    expect(deleteCase).toHaveBeenCalledWith("c1")
  })

  it("edits a case", async () => {
    cases = [caseRow({ id: "c1", input: "first" })]
    render(<CaseList datasetId="d" />)
    fireEvent.click(screen.getByLabelText("case.edit"))
    fireEvent.change(screen.getByLabelText("case.input"), { target: { value: "edited" } })
    fireEvent.click(screen.getByText("case.save"))
    await waitFor(() =>
      expect(updateCase).toHaveBeenCalledWith("c1", expect.objectContaining({ input: "edited" }))
    )
  })
})
