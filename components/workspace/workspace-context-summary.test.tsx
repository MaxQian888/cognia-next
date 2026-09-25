/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

import { WorkspaceContextSummary } from "./workspace-context-summary"

const file = { id: "f1", name: "notes.md" } as never

describe("WorkspaceContextSummary", () => {
  it("invites the reader to add context when there is none", () => {
    render(<WorkspaceContextSummary workspace={{ knowledgeBase: [] }} onEdit={() => {}} />)
    expect(screen.getByTestId("workspace-context-empty")).toBeInTheDocument()
  })

  it("shows what every conversation here is told", () => {
    render(
      <WorkspaceContextSummary
        workspace={{
          description: "Billing API",
          customInstructions: "Use pnpm.\nNever touch prod.",
          tags: ["api", "billing"],
          knowledgeBase: [file, file],
        }}
        onEdit={() => {}}
      />
    )
    expect(screen.getByTestId("workspace-context-description")).toHaveTextContent("Billing API")
    expect(screen.getByTestId("workspace-context-instructions")).toHaveTextContent(
      "Never touch prod."
    )
    expect(screen.getByTestId("workspace-context-knowledge")).toHaveTextContent("2 knowledge files")
    expect(screen.getByTestId("workspace-context-tags")).toHaveTextContent("billing")
  })

  it("says the repository's instructions are all there is when the workspace adds none", () => {
    render(
      <WorkspaceContextSummary
        workspace={{ description: "Docs site", knowledgeBase: [] }}
        onEdit={() => {}}
      />
    )
    expect(screen.queryByTestId("workspace-context-instructions")).not.toBeInTheDocument()
    expect(screen.getByText(/only the repository's own instructions/)).toBeInTheDocument()
  })

  /**
   * Files that exist but are not injected are the case a reader would never
   * guess from a bare count.
   */
  it("says when the knowledge files are not reaching chat", () => {
    render(
      <WorkspaceContextSummary
        workspace={{ knowledgeBase: [file], knowledgeSettings: { enableProjectRag: false } }}
        onEdit={() => {}}
      />
    )
    expect(screen.getByTestId("workspace-context-knowledge")).toHaveTextContent(
      "not injected into chat"
    )
  })

  it("edits in the workspace manager rather than here", () => {
    const onEdit = jest.fn()
    render(<WorkspaceContextSummary workspace={{ knowledgeBase: [] }} onEdit={onEdit} />)
    fireEvent.click(screen.getByTestId("workspace-context-edit"))
    expect(onEdit).toHaveBeenCalledTimes(1)
  })

  it("has nothing to edit without a workspace", () => {
    render(<WorkspaceContextSummary workspace={null} onEdit={() => {}} />)
    expect(screen.getByTestId("workspace-context-edit")).toBeDisabled()
  })
})
