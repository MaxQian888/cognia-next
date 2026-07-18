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
    draftVersion: dirty ? 2 : 1,
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

  it("renders fixed leading tabs even when no files are open", () => {
    const onSelect = jest.fn()
    render(
      <ProjectEditorTabs
        fixedTabs={[{ id: "review", label: "Review", active: true, onSelect }]}
        files={[]}
        activePath={null}
        dirtyCount={0}
        onSelect={jest.fn()}
        onClose={jest.fn()}
        onSaveAll={jest.fn()}
      />
    )

    const review = screen.getByTestId("editor-fixed-tab-review")
    expect(review).toHaveAttribute("aria-selected", "true")
    fireEvent.click(review)
    expect(onSelect).toHaveBeenCalledTimes(1)
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

  it("exposes tablist semantics with native button tabs", () => {
    render(
      <ProjectEditorTabs
        files={[file("src/a.ts"), file("src/b.ts")]}
        activePath="src/a.ts"
        dirtyCount={0}
        onSelect={jest.fn()}
        onClose={jest.fn()}
        onSaveAll={jest.fn()}
      />
    )

    expect(screen.getByRole("tablist")).toBeInTheDocument()
    expect(screen.getByTestId("editor-tab-src/a.ts")).toHaveAttribute("tabindex", "0")
    expect(screen.getByTestId("editor-tab-src/b.ts")).toHaveAttribute("tabindex", "-1")
    expect(screen.getByTestId("editor-tab-src/a.ts").tagName).toBe("BUTTON")
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
    expect(screen.getByLabelText("closeTab").closest('[role="tab"]')).toBeNull()
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

  it("uses touch-sized tab controls in mobile density", () => {
    render(
      <ProjectEditorTabs
        density="touch"
        fixedTabs={[{ id: "review", label: "Review", active: false, onSelect: jest.fn() }]}
        files={[file("src/a.ts", true)]}
        activePath="src/a.ts"
        dirtyCount={1}
        onSelect={jest.fn()}
        onClose={jest.fn()}
        onSaveAll={jest.fn()}
      />
    )

    expect(screen.getByTestId("editor-tab-src/a.ts")).toHaveClass("min-h-11")
    expect(screen.getByTestId("editor-fixed-tab-review")).toHaveClass("min-h-11")
    expect(screen.getByLabelText("closeTab")).toHaveClass("size-11")
    expect(screen.getByTestId("editor-save-all")).toHaveClass("h-10")
  })
})
