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
const ingestEvalAsset = jest.fn(async (_input: unknown) => ({
  type: "asset" as const,
  assetId: "sha256:asset",
  mediaType: "image/png",
  name: "sample.png",
  privacy: "local-only" as const,
}))
jest.mock("@/lib/db/eval-datasets", () => ({
  addCase: (...a: unknown[]) => addCase(...(a as [])),
  updateCase: (...a: unknown[]) => updateCase(...(a as [])),
  deleteCase: (...a: unknown[]) => deleteCase(...(a as [])),
}))
jest.mock("@/lib/ai/eval/assets", () => ({
  ingestEvalAsset: (...args: unknown[]) => ingestEvalAsset(...(args as [unknown])),
}))
jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: (selector: (state: { unlockedAccountId: string }) => unknown) =>
    selector({ unlockedAccountId: "account-1" }),
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
  ingestEvalAsset.mockClear()
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

  it("closes the new-case editor on cancel", () => {
    cases = []
    render(<CaseList datasetId="d" />)
    fireEvent.click(screen.getByText("case.add"))
    fireEvent.click(screen.getByText("case.cancel"))
    expect(screen.queryByTestId("case-editor")).not.toBeInTheDocument()
    expect(screen.getByText("case.empty")).toBeInTheDocument()
  })

  it("closes the editor on cancel without writing", () => {
    cases = [caseRow({ id: "c1", input: "first" })]
    render(<CaseList datasetId="d" />)
    fireEvent.click(screen.getByLabelText("case.edit"))
    expect(screen.getByTestId("case-editor")).toBeInTheDocument()
    fireEvent.click(screen.getByText("case.cancel"))
    expect(screen.queryByTestId("case-editor")).not.toBeInTheDocument()
    expect(updateCase).not.toHaveBeenCalled()
  })

  it("ingests an attachment through the unlocked account and persists its reference", async () => {
    render(<CaseList datasetId="d" />)
    fireEvent.click(screen.getByText("case.add"))
    fireEvent.change(screen.getByLabelText("case.input"), { target: { value: "inspect" } })
    fireEvent.change(screen.getByLabelText("case.pickAttachments"), {
      target: { files: [new File(["png"], "sample.png", { type: "image/png" })] },
    })
    await waitFor(() => expect(ingestEvalAsset).toHaveBeenCalled())
    expect(ingestEvalAsset).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "account-1", file: expect.any(File) })
    )
    fireEvent.click(screen.getByText("case.save"))
    await waitFor(() =>
      expect(addCase).toHaveBeenCalledWith(
        "d",
        expect.objectContaining({
          contentParts: [expect.objectContaining({ assetId: "sha256:asset" })],
        })
      )
    )
  })
})
