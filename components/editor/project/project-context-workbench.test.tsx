import { fireEvent, render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
jest.mock("./project-git-review-panel", () => ({
  ProjectGitReviewPanel: () => <div>git-review-panel</div>,
}))
jest.mock("./project-file-review-panel", () => ({
  ProjectFileReviewPanel: () => <div>proposal-review-panel</div>,
}))
jest.mock("./project-file-preview-panel", () => ({
  ProjectFilePreviewPanel: () => <div>preview-panel</div>,
}))
jest.mock("./project-resource-session-relinker", () => ({
  ProjectResourceSessionRelinker: () => <div>session-relinker</div>,
}))
jest.mock("@/components/context-workbench/resource-workbench-chat-panel", () => ({
  ResourceWorkbenchChatPanel: ({ getResourceContext }: { getResourceContext: () => string }) => (
    <div>{`resource-chat-panel:${getResourceContext()}`}</div>
  ),
}))
jest.mock("@/hooks/chat/use-resource-workbench-session", () => ({
  useResourceWorkbenchSession: () => ({ id: "resource-session" }),
}))

import { ProjectContextWorkbench } from "./project-context-workbench"

describe("ProjectContextWorkbench", () => {
  it("binds the active draft and exposes all core activities", () => {
    render(
      <ProjectContextWorkbench
        scopeKey="session:s-1"
        rootPath="/repo"
        onDraftChange={jest.fn()}
        selection={{ kind: "text", start: 0, end: 5 }}
        file={{
          relPath: "src/index.ts",
          absolutePath: "/repo/src/index.ts",
          language: "typescript",
          savedContent: "const value = 1",
          draftContent: "const value = 2",
          draftVersion: 2,
        }}
      />
    )

    expect(screen.getByTestId("context-workbench-activity-rail")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "projectEditor.workbench.inspect" }))
    expect(screen.getByText("src/index.ts")).toBeInTheDocument()
    expect(screen.getByText("dirty")).toBeInTheDocument()
  })

  it("reuses real review and preview activities for the bound file", () => {
    render(
      <ProjectContextWorkbench
        scopeKey="session:s-1"
        rootPath="/repo"
        onDraftChange={jest.fn()}
        file={{
          relPath: "src/index.ts",
          absolutePath: "/repo/src/index.ts",
          language: "typescript",
          savedContent: "const value = 1",
          draftContent: "const value = 1",
          draftVersion: 1,
        }}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "projectEditor.workbench.comments" }))
    expect(screen.queryByText("git-review-panel")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "projectEditor.workbench.review" }))
    expect(screen.getByText("git-review-panel")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("tab", { name: "contextWorkbench.proposalReview" }))
    expect(screen.getByText("proposal-review-panel")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "projectEditor.workbench.previewRun" }))
    expect(screen.getByText("preview-panel")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "projectEditor.workbench.ai" }))
    expect(screen.getByText("resource-chat-panel:const value = 1")).toBeInTheDocument()
  })

  it("activates a default panel on first mount so the content pane is never empty", () => {
    render(
      <ProjectContextWorkbench
        scopeKey="session:s-default"
        rootPath="/repo"
        onDraftChange={jest.fn()}
        file={{
          relPath: "src/main.ts",
          absolutePath: "/repo/src/main.ts",
          language: "typescript",
          savedContent: "x",
          draftContent: "x",
          draftVersion: 1,
        }}
      />
    )
    // The AI panel renders without any manual activity-rail click.
    expect(screen.getByText("resource-chat-panel:x")).toBeInTheDocument()
  })

  it("does not crash when the bound file has no draft content", () => {
    expect(() =>
      render(
        <ProjectContextWorkbench
          scopeKey="session:s-1"
          rootPath="/repo"
          onDraftChange={jest.fn()}
          file={{
            relPath: "src/index.ts",
            absolutePath: "/repo/src/index.ts",
            language: "typescript",
            savedContent: "const value = 1",
            draftContent: undefined as unknown as string,
            draftVersion: 1,
          }}
        />
      )
    ).not.toThrow()
    expect(screen.getByTestId("context-workbench-activity-rail")).toBeInTheDocument()
  })
})
