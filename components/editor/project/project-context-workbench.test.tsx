import { act, fireEvent, render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
jest.mock("./project-file-review-panel", () => ({
  ProjectFileReviewPanel: () => <div>proposal-review-panel</div>,
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

import {
  PROJECT_FILES_PANEL_ID,
  PROJECT_SEARCH_PANEL_ID,
  ProjectContextWorkbench,
} from "./project-context-workbench"
import type { OpenFile } from "./use-project-editor"
import { useContextWorkbenchStore } from "@/stores/context-workbench/context-workbench-store"
import {
  getProjectFileResourceKey,
  proposeProjectFileUpdate,
} from "@/lib/context-workbench/project-file-proposals"
import { EDITOR_TITLE_ROW_CLASS } from "./editor-chrome"

function file(overrides: Partial<OpenFile> = {}): OpenFile {
  return {
    relPath: "src/index.ts",
    absolutePath: "/repo/src/index.ts",
    language: "typescript",
    monacoLanguage: "typescript",
    savedContent: "const value = 1",
    draftContent: "const value = 1",
    draftVersion: 1,
    ...overrides,
  }
}

function renderWorkbench(overrides: Partial<Parameters<typeof ProjectContextWorkbench>[0]> = {}) {
  const props = {
    scopeKey: "session:s-1",
    rootPath: "/repo",
    onDraftChange: jest.fn(),
    file: file(),
    railOnly: false,
    onCollapse: jest.fn(),
    onEnsureVisible: jest.fn(),
    onModeWidthHint: jest.fn(),
    projectViews: {
      files: () => <div data-testid="files-view" />,
      search: () => <div data-testid="search-view" />,
    },
    ...overrides,
  }
  return { props, ...render(<ProjectContextWorkbench {...props} />) }
}

describe("ProjectContextWorkbench", () => {
  beforeEach(() => {
    // The store persists the user's rail/tabs preference; these assertions are
    // written against the rail's button-per-activity navigation.
    useContextWorkbenchStore.setState({ layouts: {}, navigationStyle: "rail" })
  })

  it("binds the active draft and exposes the inspect details", () => {
    renderWorkbench({
      selection: { kind: "text", start: 0, end: 5 },
      file: file({ draftContent: "const value = 2", draftVersion: 2 }),
    })

    expect(screen.getByTestId("context-workbench-activity-rail")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "projectEditor.workbench.inspect" }))
    expect(screen.getByText("src/index.ts")).toBeInTheDocument()
    expect(screen.getByText("dirty")).toBeInTheDocument()
  })

  it("offers AI, comments, inspect and proposal review — not the editor's own surfaces", () => {
    renderWorkbench()

    fireEvent.click(screen.getByRole("button", { name: "projectEditor.workbench.ai" }))
    expect(screen.getByText("resource-chat-panel:const value = 1")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "contextWorkbench.proposalReview" }))
    expect(screen.getByText("proposal-review-panel")).toBeInTheDocument()

    // Preview, Problems and the Git diff live in the editor itself (preview
    // overlay, Problems panel, the dock's Review surface).
    expect(
      screen.queryByRole("button", { name: "projectEditor.workbench.previewRun" })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "projectEditor.workbench.review" })
    ).not.toBeInTheDocument()
    expect(screen.queryByText("projectEditor.workbench.problems")).not.toBeInTheDocument()
  })

  it("opens on the explorer so the content pane is never empty", () => {
    const onActivePanelChange = jest.fn()
    renderWorkbench({ scopeKey: "session:s-default", onActivePanelChange })
    // The explorer renders without any manual activity-rail click.
    expect(screen.getByTestId("files-view")).toBeInTheDocument()
    expect(onActivePanelChange).toHaveBeenLastCalledWith(PROJECT_FILES_PANEL_ID)
  })

  it("leads the rail with the explorer and search, peers of the file's views", () => {
    renderWorkbench({ scopeKey: "session:s-order" })
    const rail = screen.getByTestId("context-workbench-activity-rail")
    const labels = Array.from(rail.querySelectorAll("button[aria-label]")).map((button) =>
      button.getAttribute("aria-label")
    )
    const files = labels.indexOf("projectEditor.filesTab")
    const search = labels.indexOf("projectEditor.searchTab")
    const ai = labels.indexOf("projectEditor.workbench.ai")
    expect(files).toBeGreaterThanOrEqual(0)
    expect(search).toBe(files + 1)
    expect(ai).toBeGreaterThan(search)

    fireEvent.click(screen.getByRole("button", { name: "projectEditor.searchTab" }))
    expect(screen.getByTestId("search-view")).toBeInTheDocument()
  })

  it("keeps one layout per project root: switching files keeps the view in front", () => {
    const { rerender, props } = renderWorkbench({ scopeKey: "session:s-scope" })
    fireEvent.click(screen.getByRole("button", { name: "projectEditor.workbench.inspect" }))
    expect(screen.getByText("src/index.ts")).toBeInTheDocument()

    rerender(
      <ProjectContextWorkbench
        {...props}
        file={file({ relPath: "src/other.ts", absolutePath: "/repo/src/other.ts" })}
      />
    )
    // Still on Inspect — now for the other file — not back on a default.
    expect(screen.getByText("src/other.ts")).toBeVisible()
    // The explorer stays mounted (stateful) but out of sight.
    expect(screen.getByTestId("files-view")).not.toBeVisible()
  })

  it("keeps every view on the rail with no file, the file views asking for one", () => {
    renderWorkbench({ scopeKey: "session:s-nofile", file: null })

    expect(screen.getByTestId("files-view")).toBeInTheDocument()
    for (const name of [
      "projectEditor.searchTab",
      "projectEditor.workbench.ai",
      "projectEditor.workbench.comments",
      "projectEditor.workbench.inspect",
    ]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument()
    }
    fireEvent.click(screen.getByRole("button", { name: "projectEditor.workbench.ai" }))
    expect(screen.getByTestId("project-context-no-file")).toHaveTextContent("noFile")
    expect(screen.queryByText(/resource-chat-panel/)).not.toBeInTheDocument()
  })

  it("brings a view to the front on the host's reveal request", () => {
    const onActivePanelChange = jest.fn()
    const { rerender, props } = renderWorkbench({
      scopeKey: "session:s-reveal",
      onActivePanelChange,
    })
    rerender(
      <ProjectContextWorkbench
        {...props}
        revealRequest={{ panelId: PROJECT_SEARCH_PANEL_ID, seq: 1 }}
      />
    )
    expect(screen.getByTestId("search-view")).toBeInTheDocument()
    expect(onActivePanelChange).toHaveBeenLastCalledWith(PROJECT_SEARCH_PANEL_ID)
  })

  it("sizes its header to the editor's tab strip", () => {
    renderWorkbench({ scopeKey: "session:s-header" })
    expect(screen.getByTestId("context-workbench-header")).toHaveClass(EDITOR_TITLE_ROW_CLASS)
    // The workbench's own default height gives way rather than stacking.
    expect(screen.getByTestId("context-workbench-header")).not.toHaveClass("h-10")
  })

  it("draws only the rail while the host has it folded", () => {
    renderWorkbench({ railOnly: true })

    expect(screen.getByTestId("context-workbench-activity-rail")).toBeInTheDocument()
    expect(screen.queryByText("resource-chat-panel:const value = 1")).not.toBeInTheDocument()
  })

  it("routes the rail's open and close requests to the host", () => {
    const onEnsureVisible = jest.fn()
    const { rerender, props } = renderWorkbench({ railOnly: true, onEnsureVisible })

    fireEvent.click(screen.getByRole("button", { name: "projectEditor.workbench.ai" }))
    expect(onEnsureVisible).toHaveBeenCalled()

    rerender(<ProjectContextWorkbench {...props} railOnly={false} />)
    fireEvent.click(screen.getByTestId("context-workbench-collapse-toggle"))
    expect(props.onCollapse).toHaveBeenCalled()
  })

  it("leaves its width to the host and routes the header's width buttons there", () => {
    const onModeWidthHint = jest.fn()
    renderWorkbench({ onModeWidthHint, scopeKey: "session:s-width" })

    // Sized by the editor's resizable panel inside the chat dock — an inline
    // width of its own would measure against the window instead.
    const section = screen.getByTestId("context-workbench")
    expect(section.style.width).toBe("")
    expect(section).toHaveClass("w-full")
    expect(
      screen.queryByRole("separator", { name: "contextWorkbench.actions.resize" })
    ).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "contextWorkbench.actions.wide" }))
    expect(onModeWidthHint).toHaveBeenLastCalledWith("wide")
    fireEvent.click(screen.getByRole("button", { name: "contextWorkbench.actions.narrow" }))
    expect(onModeWidthHint).toHaveBeenLastCalledWith("narrow")
  })

  it("lights the width the host reports rather than the recorded intent", () => {
    renderWorkbench({ resolvedMode: "wide", scopeKey: "session:s-resolved" })

    expect(
      screen.getByRole("button", { name: "contextWorkbench.actions.wide" }).dataset.variant
    ).toBe("secondary")
    expect(
      screen.getByRole("button", { name: "contextWorkbench.actions.narrow" }).dataset.variant
    ).toBe("ghost")
  })

  it("unfolds itself when the AI answers with a proposal", () => {
    const onEnsureVisible = jest.fn()
    const onModeWidthHint = jest.fn()
    renderWorkbench({
      railOnly: true,
      onEnsureVisible,
      onModeWidthHint,
      scopeKey: "session:s-proposal",
    })

    const key = getProjectFileResourceKey({
      projectId: "session:s-proposal",
      rootId: "/repo",
      relPath: "src/index.ts",
    })
    act(() => {
      expect(proposeProjectFileUpdate(key, "const value = 42", "request-1")).not.toBeNull()
    })
    expect(onEnsureVisible).toHaveBeenCalledTimes(1)
    // The review wants room for a diff; the host owns the width, so it is
    // asked for the wide preset as well.
    expect(onModeWidthHint).toHaveBeenCalledWith("wide", "proposal-review")
  })

  it("does not crash when the bound file has no draft content", () => {
    expect(() =>
      renderWorkbench({
        file: file({ draftContent: undefined as unknown as string }),
      })
    ).not.toThrow()
    expect(screen.getByTestId("context-workbench-activity-rail")).toBeInTheDocument()
  })
})
