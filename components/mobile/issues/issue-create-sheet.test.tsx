/** @jest-environment jsdom */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${Object.values(vars).join(",")}` : key,
}))
const mockCreate = jest.fn(async (..._a: unknown[]) => ({ id: "job" }))
jest.mock("@/lib/issues/remote-write", () => ({
  queueIssueCreate: (...a: unknown[]) => mockCreate(...a),
}))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

import { act, fireEvent, render, screen } from "@testing-library/react"
import { toast } from "sonner"
import type { IssueProject } from "@/types/issues"
import { IssueCreateSheet } from "./issue-create-sheet"

const projects: IssueProject[] = [
  { id: "p1", projectId: "w1", key: "MERC", name: "Mercury", status: "in_progress", createdAt: 1, updatedAt: 1 },
  { id: "p2", projectId: "w1", key: "VEN", name: "Venus", status: "planned", createdAt: 1, updatedAt: 1 },
] as IssueProject[]

function renderSheet(over: Partial<React.ComponentProps<typeof IssueCreateSheet>> = {}) {
  const onOpenChange = jest.fn()
  render(
    <IssueCreateSheet open onOpenChange={onOpenChange} projectId="w1" projects={projects} {...over} />
  )
  return { onOpenChange }
}

beforeEach(() => {
  mockCreate.mockClear()
  ;(toast.success as jest.Mock).mockClear()
  ;(toast.error as jest.Mock).mockClear()
})

describe("IssueCreateSheet", () => {
  it("queues a create for the host with the first container preselected", async () => {
    const { onOpenChange } = renderSheet()
    expect(screen.getByTestId("issues-mobile-create-submit")).toBeDisabled()
    fireEvent.change(screen.getByTestId("issues-mobile-create-title"), { target: { value: "Fix it" } })
    fireEvent.change(screen.getByTestId("issues-mobile-create-priority"), { target: { value: "high" } })
    await act(async () => {
      fireEvent.click(screen.getByTestId("issues-mobile-create-submit"))
    })
    expect(mockCreate).toHaveBeenCalledWith({
      projectId: "w1",
      issueProjectId: "p1",
      title: "Fix it",
      description: "",
      status: "todo",
      priority: "high",
    })
    expect(toast.success).toHaveBeenCalledWith("mobile.createQueued:Fix it")
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(screen.getByTestId("issues-mobile-create-title")).toHaveValue("")
  })

  it("lets the user pick another container", async () => {
    renderSheet()
    fireEvent.change(screen.getByTestId("issues-mobile-create-project"), { target: { value: "p2" } })
    fireEvent.change(screen.getByTestId("issues-mobile-create-title"), { target: { value: "x" } })
    await act(async () => {
      fireEvent.click(screen.getByTestId("issues-mobile-create-submit"))
    })
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ issueProjectId: "p2" }))
  })

  it("keeps the sheet open and the draft intact when the queue refuses", async () => {
    mockCreate.mockRejectedValueOnce(new Error("no host"))
    const { onOpenChange } = renderSheet()
    fireEvent.change(screen.getByTestId("issues-mobile-create-title"), { target: { value: "Keep" } })
    await act(async () => {
      fireEvent.click(screen.getByTestId("issues-mobile-create-submit"))
    })
    expect(toast.error).toHaveBeenCalledWith("no host")
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
    expect(screen.getByTestId("issues-mobile-create-title")).toHaveValue("Keep")
  })

  it("explains that a container is needed first instead of rendering a form that cannot submit", () => {
    renderSheet({ projects: [] })
    expect(screen.getByTestId("issues-mobile-create-no-project")).toBeInTheDocument()
    expect(screen.queryByTestId("issues-mobile-create")).not.toBeInTheDocument()
  })
})
