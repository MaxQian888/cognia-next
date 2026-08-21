/** @jest-environment jsdom */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${Object.values(vars).join(",")}` : key,
}))

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { IssueProject } from "@/types/issues"
import { DeleteProjectDialog } from "./delete-project-dialog"

const project: IssueProject = {
  id: "p1",
  projectId: "w1",
  key: "MERC",
  name: "Mercury",
  status: "in_progress",
  priority: "medium",
  resources: [],
  createdAt: 0,
  updatedAt: 0,
}

function renderDialog(over: Partial<React.ComponentProps<typeof DeleteProjectDialog>> = {}) {
  const props: React.ComponentProps<typeof DeleteProjectDialog> = {
    open: true,
    onOpenChange: jest.fn(),
    project,
    issueCount: 3,
    onConfirm: jest.fn(),
    ...over,
  }
  return { props, ...render(<DeleteProjectDialog {...props} />) }
}

describe("DeleteProjectDialog", () => {
  it("renders nothing while shut", () => {
    renderDialog({ open: false })
    expect(screen.queryByTestId("delete-project-dialog")).not.toBeInTheDocument()
  })

  it("names the container", () => {
    renderDialog()
    expect(screen.getByText("projects.deleteTitle:Mercury")).toBeInTheDocument()
  })

  it("states the issue count, because deleting a container blind is the risk", () => {
    renderDialog()
    expect(screen.getByText("projects.deleteBody:3,MERC")).toBeInTheDocument()
  })

  it("still explains itself for an empty container", () => {
    renderDialog({ issueCount: 0 })
    expect(screen.getByText("projects.deleteBody:0,MERC")).toBeInTheDocument()
  })

  it("confirms", async () => {
    const onConfirm = jest.fn()
    renderDialog({ onConfirm })
    fireEvent.click(screen.getByTestId("delete-project-confirm"))
    await waitFor(() => expect(onConfirm).toHaveBeenCalled())
  })

  it("stays up until a slow cascade finishes", async () => {
    let release: () => void = () => undefined
    const onConfirm = jest.fn(() => new Promise<void>((resolve) => (release = resolve)))
    const onOpenChange = jest.fn()
    renderDialog({ onConfirm, onOpenChange })
    fireEvent.click(screen.getByTestId("delete-project-confirm"))
    await waitFor(() => expect(screen.getByTestId("delete-project-confirm")).toBeDisabled())
    expect(onOpenChange).not.toHaveBeenCalled()
    release()
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })

  it("cannot confirm without a target", () => {
    renderDialog({ project: null })
    expect(screen.getByTestId("delete-project-confirm")).toBeDisabled()
  })
})
