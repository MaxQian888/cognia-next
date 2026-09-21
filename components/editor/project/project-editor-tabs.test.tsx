/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

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
    monacoLanguage: "typescript",
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

  it("scrolls the tab row without ever painting a scrollbar", () => {
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
    const strip = screen.getByRole("tablist")
    // `overflow-x-auto` keeps wheel/drag scrolling and scrollIntoView; the two
    // suppression rules are what stop a bare bar from hanging under the strip.
    expect(strip.className).toContain("overflow-x-auto")
    expect(strip.className).toContain("[scrollbar-width:none]")
    expect(strip.className).toContain("[&::-webkit-scrollbar]:hidden")
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

  it("keeps trailing editor controls on the same strip as fixed tabs", () => {
    render(
      <ProjectEditorTabs
        fixedTabs={[{ id: "review", label: "Review", active: true, onSelect: jest.fn() }]}
        trailingContent={<button data-testid="engine-toggle">Engine</button>}
        files={[]}
        activePath={null}
        dirtyCount={0}
        onSelect={jest.fn()}
        onClose={jest.fn()}
        onSaveAll={jest.fn()}
      />
    )

    expect(screen.getByTestId("project-editor-tabs")).toContainElement(
      screen.getByTestId("engine-toggle")
    )
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
  describe("preview tabs", () => {
    it("marks only the preview tab italic and offers a pin affordance", () => {
      render(
        <ProjectEditorTabs
          files={[file("src/a.ts"), file("src/b.ts")]}
          activePath="src/a.ts"
          previewPath="src/b.ts"
          dirtyCount={0}
          onSelect={jest.fn()}
          onClose={jest.fn()}
          onPin={jest.fn()}
          onSaveAll={jest.fn()}
        />
      )
      expect(screen.getByTestId("editor-tab-src/b.ts")).toHaveClass("italic")
      expect(screen.getByTestId("editor-tab-src/a.ts")).not.toHaveClass("italic")
      expect(screen.getByTestId("editor-tab-pin-src/b.ts")).toBeInTheDocument()
      expect(screen.queryByTestId("editor-tab-pin-src/a.ts")).toBeNull()
    })

    it("pins from the pin button without also selecting the tab", () => {
      const onPin = jest.fn()
      const onSelect = jest.fn()
      render(
        <ProjectEditorTabs
          files={[file("src/a.ts")]}
          activePath="src/a.ts"
          previewPath="src/a.ts"
          dirtyCount={0}
          onSelect={onSelect}
          onClose={jest.fn()}
          onPin={onPin}
          onSaveAll={jest.fn()}
        />
      )
      fireEvent.click(screen.getByTestId("editor-tab-pin-src/a.ts"))
      expect(onPin).toHaveBeenCalledWith("src/a.ts")
      expect(onSelect).not.toHaveBeenCalled()
    })

    it("pins on double-click", () => {
      const onPin = jest.fn()
      render(
        <ProjectEditorTabs
          files={[file("src/a.ts")]}
          activePath="src/a.ts"
          previewPath="src/a.ts"
          dirtyCount={0}
          onSelect={jest.fn()}
          onClose={jest.fn()}
          onPin={onPin}
          onSaveAll={jest.fn()}
        />
      )
      fireEvent.doubleClick(screen.getByTestId("editor-tab-src/a.ts"))
      expect(onPin).toHaveBeenCalledWith("src/a.ts")
    })

    it("renders no pin affordance for a host that does not track preview tabs", () => {
      render(
        <ProjectEditorTabs
          files={[file("src/a.ts")]}
          activePath="src/a.ts"
          dirtyCount={0}
          onSelect={jest.fn()}
          onClose={jest.fn()}
          onSaveAll={jest.fn()}
        />
      )
      expect(screen.queryByTestId("editor-tab-pin-src/a.ts")).toBeNull()
      expect(screen.getByTestId("editor-tab-src/a.ts")).not.toHaveClass("italic")
      // Double-clicking must be inert rather than throwing when `onPin` is absent.
      fireEvent.doubleClick(screen.getByTestId("editor-tab-src/a.ts"))
    })
  })

  describe("drag reorder", () => {
    const DRAG_MIME = "application/x-cognia-editor-tab"
    const dataTransfer = () => {
      const data: Record<string, string> = {}
      return {
        types: [DRAG_MIME],
        effectAllowed: "",
        dropEffect: "",
        setData: (k: string, v: string) => {
          data[k] = v
        },
        getData: (k: string) => data[k] ?? "",
      }
    }
    /** The draggable ContextMenuTrigger div wrapping a tab's button. */
    const wrap = (relPath: string) => screen.getByTestId(`editor-tab-${relPath}`).parentElement!

    const render3 = (onMove?: jest.Mock) =>
      render(
        <ProjectEditorTabs
          files={[file("src/a.ts"), file("src/b.ts"), file("src/c.ts")]}
          activePath="src/a.ts"
          dirtyCount={0}
          onSelect={jest.fn()}
          onClose={jest.fn()}
          onSaveAll={jest.fn()}
          onMove={onMove}
        />
      )

    it("makes tabs draggable only when the host wires onMove", () => {
      const { unmount } = render3(jest.fn())
      expect(wrap("src/a.ts")).toHaveAttribute("draggable", "true")
      unmount()
      render(
        <ProjectEditorTabs
          files={[file("src/a.ts")]}
          activePath="src/a.ts"
          dirtyCount={0}
          onSelect={jest.fn()}
          onClose={jest.fn()}
          onSaveAll={jest.fn()}
        />
      )
      expect(wrap("src/a.ts")).toHaveAttribute("draggable", "false")
    })

    it("dropping a tab on another calls onMove(from, to)", () => {
      const onMove = jest.fn()
      render3(onMove)
      const dt = dataTransfer()
      fireEvent.dragStart(wrap("src/a.ts"), { dataTransfer: dt })
      expect(fireEvent.dragOver(wrap("src/c.ts"), { dataTransfer: dt })).toBe(false)
      fireEvent.drop(wrap("src/c.ts"), { dataTransfer: dt })
      expect(onMove).toHaveBeenCalledWith("src/a.ts", "src/c.ts")
    })

    it("ignores a drop on the dragged tab itself", () => {
      const onMove = jest.fn()
      render3(onMove)
      const dt = dataTransfer()
      fireEvent.dragStart(wrap("src/a.ts"), { dataTransfer: dt })
      fireEvent.drop(wrap("src/a.ts"), { dataTransfer: dt })
      expect(onMove).not.toHaveBeenCalled()
    })

    it("does not claim a foreign drag payload", () => {
      render3(jest.fn())
      const foreign = { types: ["text/plain"], dropEffect: "", getData: () => "" }
      // Without the editor-tab MIME the dragover must not be prevented — the
      // browser keeps it a non-drop zone instead of advertising a reorder.
      expect(fireEvent.dragOver(wrap("src/b.ts"), { dataTransfer: foreign })).toBe(true)
    })
  })

  describe("tab context menu", () => {
    const openMenu = async (relPath: string) => {
      fireEvent.contextMenu(screen.getByTestId(`editor-tab-${relPath}`).parentElement!)
      return screen.findByTestId(`editor-tab-menu-${relPath}`)
    }

    it("fires close-others and close-all from the menu", async () => {
      const onCloseOthers = jest.fn()
      const onCloseAll = jest.fn()
      render(
        <ProjectEditorTabs
          files={[file("src/a.ts"), file("src/b.ts")]}
          activePath="src/a.ts"
          dirtyCount={0}
          onSelect={jest.fn()}
          onClose={jest.fn()}
          onSaveAll={jest.fn()}
          onCloseOthers={onCloseOthers}
          onCloseAll={onCloseAll}
        />
      )
      await openMenu("src/a.ts")
      fireEvent.click(await screen.findByText("tabs.closeOthers"))
      expect(onCloseOthers).toHaveBeenCalledWith("src/a.ts")
      // Selecting an item dismisses the menu — reopen it for the next action.
      await openMenu("src/a.ts")
      fireEvent.click(await screen.findByText("tabs.closeAll"))
      expect(onCloseAll).toHaveBeenCalled()
    })

    it("fires reopen-closed only when the host wires it", async () => {
      const onReopenClosed = jest.fn()
      const { unmount } = render(
        <ProjectEditorTabs
          files={[file("src/a.ts")]}
          activePath="src/a.ts"
          dirtyCount={0}
          onSelect={jest.fn()}
          onClose={jest.fn()}
          onSaveAll={jest.fn()}
          onReopenClosed={onReopenClosed}
        />
      )
      await openMenu("src/a.ts")
      fireEvent.click(await screen.findByText("tabs.reopenClosed"))
      expect(onReopenClosed).toHaveBeenCalled()
      unmount()

      render(
        <ProjectEditorTabs
          files={[file("src/a.ts")]}
          activePath="src/a.ts"
          dirtyCount={0}
          onSelect={jest.fn()}
          onClose={jest.fn()}
          onSaveAll={jest.fn()}
        />
      )
      await openMenu("src/a.ts")
      expect(screen.queryByText("tabs.reopenClosed")).toBeNull()
    })

    it("disables close-others on a single tab and close-to-right on the last tab", async () => {
      render(
        <ProjectEditorTabs
          files={[file("src/a.ts")]}
          activePath="src/a.ts"
          dirtyCount={0}
          onSelect={jest.fn()}
          onClose={jest.fn()}
          onSaveAll={jest.fn()}
          onCloseOthers={jest.fn()}
          onCloseToRight={jest.fn()}
        />
      )
      await openMenu("src/a.ts")
      expect(await screen.findByText("tabs.closeOthers")).toHaveAttribute("aria-disabled", "true")
      expect(await screen.findByText("tabs.closeToRight")).toHaveAttribute("aria-disabled", "true")
    })

    it("fires close-to-right with the tab's path", async () => {
      const onCloseToRight = jest.fn()
      render(
        <ProjectEditorTabs
          files={[file("src/a.ts"), file("src/b.ts"), file("src/c.ts")]}
          activePath="src/a.ts"
          dirtyCount={0}
          onSelect={jest.fn()}
          onClose={jest.fn()}
          onSaveAll={jest.fn()}
          onCloseToRight={onCloseToRight}
        />
      )
      await openMenu("src/a.ts")
      fireEvent.click(await screen.findByText("tabs.closeToRight"))
      expect(onCloseToRight).toHaveBeenCalledWith("src/a.ts")
    })

    it("offers revert only on a dirty tab", async () => {
      const onRevert = jest.fn()
      render(
        <ProjectEditorTabs
          files={[file("src/a.ts"), file("src/b.ts", true)]}
          activePath="src/a.ts"
          dirtyCount={1}
          onSelect={jest.fn()}
          onClose={jest.fn()}
          onSaveAll={jest.fn()}
          onRevert={onRevert}
        />
      )
      await openMenu("src/a.ts")
      expect(screen.queryByText("tabs.revert")).toBeNull()
      await openMenu("src/b.ts")
      fireEvent.click(await screen.findByText("tabs.revert"))
      expect(onRevert).toHaveBeenCalledWith("src/b.ts")
    })

    it("copies relative and absolute paths", async () => {
      const onCopyPath = jest.fn()
      render(
        <ProjectEditorTabs
          files={[file("src/a.ts")]}
          activePath="src/a.ts"
          dirtyCount={0}
          onSelect={jest.fn()}
          onClose={jest.fn()}
          onSaveAll={jest.fn()}
          onCopyPath={onCopyPath}
        />
      )
      await openMenu("src/a.ts")
      fireEvent.click(await screen.findByText("action.copyRelativePath"))
      expect(onCopyPath).toHaveBeenLastCalledWith("src/a.ts", false)
      await openMenu("src/a.ts")
      fireEvent.click(await screen.findByText("action.copyPath"))
      expect(onCopyPath).toHaveBeenLastCalledWith("src/a.ts", true)
    })
  })

  describe("overflow tab list", () => {
    it("renders the list trigger only with more than one tab", () => {
      const { unmount } = render(
        <ProjectEditorTabs
          files={[file("src/a.ts")]}
          activePath="src/a.ts"
          dirtyCount={0}
          onSelect={jest.fn()}
          onClose={jest.fn()}
          onSaveAll={jest.fn()}
        />
      )
      expect(screen.queryByTestId("editor-tabs-list")).toBeNull()
      unmount()
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
      expect(screen.getByTestId("editor-tabs-list")).toBeInTheDocument()
    })

    it("selecting from the list activates the file and closes the menu", async () => {
      const onSelect = jest.fn()
      render(
        <ProjectEditorTabs
          files={[file("src/a.ts"), file("src/b.ts"), file("src/c.ts")]}
          activePath="src/a.ts"
          dirtyCount={0}
          onSelect={onSelect}
          onClose={jest.fn()}
          onSaveAll={jest.fn()}
        />
      )
      // Radix dropdown triggers open on pointerdown, so the click must come
      // through userEvent's real pointer sequence rather than a bare fireEvent.
      await userEvent.click(screen.getByTestId("editor-tabs-list"))
      await userEvent.click(await screen.findByTestId("editor-tabs-list-src/c.ts"))
      expect(onSelect).toHaveBeenCalledWith("src/c.ts")
      expect(screen.queryByTestId("editor-tabs-list-src/c.ts")).toBeNull()
    })
  })
})
