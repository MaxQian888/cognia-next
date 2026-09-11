/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))

const mockCreate = jest.fn(async (..._a: unknown[]) => ({}))
const mockUpdate = jest.fn(async (..._a: unknown[]) => undefined)
const mockDelete = jest.fn(async (..._a: unknown[]) => undefined)
jest.mock("@/lib/db/issue-cycles", () => ({
  createIssueCycle: (...a: unknown[]) => mockCreate(...a),
  updateIssueCycle: (...a: unknown[]) => mockUpdate(...a),
  deleteIssueCycle: (...a: unknown[]) => mockDelete(...a),
}))
jest.mock("sonner", () => ({ toast: { error: jest.fn() } }))

import { act, fireEvent, render, screen } from "@testing-library/react"
import type { IssueCycle } from "@/types/issues"
import { ManageCyclesDialog } from "./manage-cycles-dialog"

const cycle: IssueCycle = {
  id: "c1",
  projectId: "w1",
  kind: "milestone",
  name: "v1.0",
  status: "planned",
  externalRefs: [],
  externalKeys: [],
  createdAt: 1,
  updatedAt: 1,
}

function renderDialog(cycles: IssueCycle[] = [cycle]) {
  return render(
    <ManageCyclesDialog
      open
      onOpenChange={jest.fn()}
      projectId="w1"
      cycles={cycles}
      projects={[]}
      progress={new Map([["c1", { total: 4, done: 1, points: 8, pointsDone: 3 }]])}
    />
  )
}

describe("ManageCyclesDialog", () => {
  beforeEach(() => {
    mockCreate.mockClear()
    mockUpdate.mockClear()
    mockDelete.mockClear()
  })

  it("says so when there are no cycles", () => {
    renderDialog([])
    expect(screen.getByTestId("manage-cycles-empty")).toBeInTheDocument()
  })

  it("creates a cycle of the chosen kind in the workspace", async () => {
    renderDialog([])
    fireEvent.change(screen.getByTestId("manage-cycles-name"), { target: { value: " Sprint 2 " } })
    fireEvent.change(screen.getByTestId("manage-cycles-kind"), { target: { value: "milestone" } })
    await act(async () => {
      fireEvent.click(screen.getByTestId("manage-cycles-create"))
    })
    expect(mockCreate).toHaveBeenCalledWith({
      projectId: "w1",
      kind: "milestone",
      name: "Sprint 2",
    })
  })

  it("prints progress and patches status, scope and name in place", async () => {
    renderDialog()
    expect(screen.getByTestId("manage-cycles-progress-c1")).toHaveTextContent(
      'progress:{"done":1,"total":4,"pointsDone":3,"points":8}'
    )
    await act(async () => {
      fireEvent.change(screen.getByTestId("manage-cycles-status-c1"), {
        target: { value: "active" },
      })
    })
    expect(mockUpdate).toHaveBeenCalledWith("c1", { status: "active" })
    await act(async () => {
      fireEvent.change(screen.getByTestId("manage-cycles-scope-c1"), { target: { value: "" } })
    })
    expect(mockUpdate).toHaveBeenCalledWith("c1", { issueProjectId: null })
    await act(async () => {
      fireEvent.blur(screen.getByTestId("manage-cycles-name-c1"), { target: { value: "v1.1" } })
    })
    expect(mockUpdate).toHaveBeenCalledWith("c1", { name: "v1.1" })
  })

  it("deletes only after a second click, and can back out", async () => {
    renderDialog()
    fireEvent.click(screen.getByTestId("manage-cycles-delete-c1"))
    fireEvent.click(screen.getByTestId("manage-cycles-delete-cancel-c1"))
    expect(mockDelete).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId("manage-cycles-delete-c1"))
    await act(async () => {
      fireEvent.click(screen.getByTestId("manage-cycles-delete-confirm-c1"))
    })
    expect(mockDelete).toHaveBeenCalledWith("c1")
  })
})
