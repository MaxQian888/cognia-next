/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { ProjectEditorTabs } from "./project-editor-tabs"
import type { OpenFile } from "./use-project-editor"

function file(relPath: string, dirty = false, externallyChanged = false): OpenFile {
  return {
    relPath,
    absolutePath: `/repo/${relPath}`,
    language: "typescript",
    savedContent: "a",
    draftContent: dirty ? "b" : "a",
    externallyChanged,
  }
}

describe("ProjectEditorTabs", () => {
  it("renders nothing with no open files", () => {
    const { container } = render(
      <ProjectEditorTabs
        files={[]}
        activePath={null}
        dirtyCount={0}
        onSelect={jest.fn()}
        onClose={jest.fn()}
        onSaveAll={jest.fn()}
      />
    )
    expect(container.firstChild).toBeNull()
  })

  it("renders one tab per open file and marks the active one", () => {
    render(
      <ProjectEditorTabs
        files={[file("src/a.ts"), file("src/b.ts")]}
        activePath="src/b.ts"
        dirtyCount={0}
        onSelect={jest.fn()}
        onClose={jest.fn()}
        onSaveAll={jest.fn()}
      />
    )
    expect(screen.getByTestId("editor-tab-src/a.ts")).toHaveAttribute("aria-selected", "false")
    expect(screen.getByTestId("editor-tab-src/b.ts")).toHaveAttribute("aria-selected", "true")
  })

  it("selecting a tab fires onSelect", () => {
    const onSelect = jest.fn()
    render(
      <ProjectEditorTabs
        files={[file("src/a.ts")]}
        activePath={null}
        dirtyCount={0}
        onSelect={onSelect}
        onClose={jest.fn()}
        onSaveAll={jest.fn()}
      />
    )
    fireEvent.click(screen.getByTestId("editor-tab-src/a.ts"))
    expect(onSelect).toHaveBeenCalledWith("src/a.ts")
  })

  it("close button fires onClose without selecting", () => {
    const onSelect = jest.fn()
    const onClose = jest.fn()
    render(
      <ProjectEditorTabs
        files={[file("src/a.ts")]}
        activePath={null}
        dirtyCount={0}
        onSelect={onSelect}
        onClose={onClose}
        onSaveAll={jest.fn()}
      />
    )
    fireEvent.click(screen.getByLabelText("closeTab"))
    expect(onClose).toHaveBeenCalledWith("src/a.ts")
    expect(onSelect).not.toHaveBeenCalled()
  })

  it("shows Save All only when dirtyCount > 0", () => {
    const onSaveAll = jest.fn()
    const { rerender } = render(
      <ProjectEditorTabs
        files={[file("src/a.ts")]}
        activePath={null}
        dirtyCount={0}
        onSelect={jest.fn()}
        onClose={jest.fn()}
        onSaveAll={onSaveAll}
      />
    )
    expect(screen.queryByTestId("editor-save-all")).toBeNull()
    rerender(
      <ProjectEditorTabs
        files={[file("src/a.ts", true)]}
        activePath={null}
        dirtyCount={1}
        onSelect={jest.fn()}
        onClose={jest.fn()}
        onSaveAll={onSaveAll}
      />
    )
    fireEvent.click(screen.getByTestId("editor-save-all"))
    expect(onSaveAll).toHaveBeenCalled()
  })

  it("marks externally-changed files", () => {
    render(
      <ProjectEditorTabs
        files={[file("src/a.ts", false, true)]}
        activePath={null}
        dirtyCount={0}
        onSelect={jest.fn()}
        onClose={jest.fn()}
        onSaveAll={jest.fn()}
      />
    )
    expect(screen.getByTitle("externallyChanged")).toBeInTheDocument()
  })
})
