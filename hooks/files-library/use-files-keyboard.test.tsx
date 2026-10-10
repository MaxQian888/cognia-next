/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen } from "@testing-library/react"

import type { FilesEntry } from "@/lib/files-library/types"
import { useFilesLibraryStore } from "@/stores/files-library"

import { FILES_ITEM_KEY_ATTR, useFilesKeyboard } from "./use-files-keyboard"
import { useFilesSelection } from "./use-files-selection"

// jsdom ships no CSS.escape; the hook uses it to find the item to focus.
if (typeof globalThis.CSS === "undefined" || typeof globalThis.CSS.escape !== "function") {
  Object.defineProperty(globalThis, "CSS", {
    configurable: true,
    value: {
      ...(globalThis.CSS ?? {}),
      escape: (value: string) => value.replace(/["\\]/g, "\\$&"),
    },
  })
}

const scrollIntoView = jest.fn()
beforeAll(() => {
  Element.prototype.scrollIntoView = scrollIntoView
})

function entry(key: string): FilesEntry {
  const [kind, sourceId] = key.split(":") as [FilesEntry["kind"], string]
  return {
    key,
    kind,
    sourceId,
    title: sourceId,
    sourceTitle: sourceId,
    projectIds: [],
    sessionIds: [],
    originAlive: true,
    createdAt: 1,
    updatedAt: 1,
    ownedByFiles: false,
    hidden: false,
    sharedWithMe: false,
    creator: "user",
    searchText: sourceId,
  }
}

const ENTRIES = ["artifact:a", "canvas:b", "image:c"].map(entry)

const actions = {
  trash: jest.fn(async (_entries: readonly FilesEntry[]) => {}),
  preview: jest.fn((_entry: FilesEntry) => {}),
}

function List({ trash = false }: { trash?: boolean }) {
  const selection = useFilesSelection(ENTRIES)
  const onKeyDown = useFilesKeyboard({ entries: ENTRIES, selection, trash, actions })
  return (
    <div>
      <div data-testid="list" onKeyDown={onKeyDown}>
        <input aria-label="rename" />
        {ENTRIES.map((e) => (
          <div key={e.key} {...{ [FILES_ITEM_KEY_ATTR]: e.key }} tabIndex={0}>
            <span>{e.title}</span>
          </div>
        ))}
      </div>
      <output data-testid="selected">{[...selection.entries.map((e) => e.key)].join(",")}</output>
    </div>
  )
}

const item = (key: string) =>
  document.querySelector<HTMLElement>(`[${FILES_ITEM_KEY_ATTR}="${key}"]`)!
const selected = () => screen.getByTestId("selected").textContent
const press = (target: Element, init: Parameters<typeof fireEvent.keyDown>[1]) =>
  act(() => {
    fireEvent.keyDown(target, init)
  })

beforeEach(() => {
  jest.clearAllMocks()
  useFilesLibraryStore.setState({
    section: { kind: "all" },
    lens: "suggested",
    selectedKey: null,
    renameTarget: null,
    deleteForeverTarget: null,
  })
})

it("⌘A and Ctrl+A select every item", () => {
  render(<List />)
  press(item("artifact:a"), { key: "a", metaKey: true })
  expect(selected()).toBe("artifact:a,canvas:b,image:c")
  press(item("artifact:a"), { key: "Escape" })
  expect(selected()).toBe("")
  press(item("canvas:b"), { key: "A", ctrlKey: true })
  expect(selected()).toBe("artifact:a,canvas:b,image:c")
})

it("Delete trashes the selection, in view order, and clears it", () => {
  render(<List />)
  press(item("image:c"), { key: "a", metaKey: true })
  press(item("image:c"), { key: "Delete" })
  expect(actions.trash).toHaveBeenCalledTimes(1)
  expect(actions.trash.mock.calls[0]![0].map((e) => e.key)).toEqual([
    "artifact:a",
    "canvas:b",
    "image:c",
  ])
  expect(selected()).toBe("")
  expect(useFilesLibraryStore.getState().deleteForeverTarget).toBeNull()
})

it("Backspace with nothing selected trashes the focused item", () => {
  render(<List />)
  press(item("canvas:b"), { key: "Backspace" })
  expect(actions.trash.mock.calls[0]![0].map((e) => e.key)).toEqual(["canvas:b"])
})

it("Delete in the Trash asks to delete forever instead", () => {
  render(<List trash />)
  press(item("canvas:b"), { key: "Delete" })
  expect(actions.trash).not.toHaveBeenCalled()
  expect(useFilesLibraryStore.getState().deleteForeverTarget).toEqual(["canvas:b"])
})

it("F2 renames the one target, but not in the Trash", () => {
  const { unmount } = render(<List />)
  press(item("image:c"), { key: "F2" })
  expect(useFilesLibraryStore.getState().renameTarget).toBe("image:c")
  // Two selected: nothing to rename.
  useFilesLibraryStore.setState({ renameTarget: null })
  press(item("image:c"), { key: "a", metaKey: true })
  press(item("image:c"), { key: "F2" })
  expect(useFilesLibraryStore.getState().renameTarget).toBeNull()
  unmount()

  render(<List trash />)
  press(item("image:c"), { key: "F2" })
  expect(useFilesLibraryStore.getState().renameTarget).toBeNull()
})

it("ArrowDown / ArrowUp move focus, select and preview", () => {
  render(<List />)
  item("artifact:a").focus()
  press(item("artifact:a"), { key: "ArrowDown" })
  expect(document.activeElement).toBe(item("canvas:b"))
  expect(selected()).toBe("canvas:b")
  expect(actions.preview).toHaveBeenLastCalledWith(expect.objectContaining({ key: "canvas:b" }))
  expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" })

  press(document.activeElement!, { key: "ArrowDown" })
  expect(document.activeElement).toBe(item("image:c"))
  // The end of the list holds.
  press(document.activeElement!, { key: "ArrowDown" })
  expect(document.activeElement).toBe(item("image:c"))
  expect(selected()).toBe("image:c")

  press(document.activeElement!, { key: "ArrowUp" })
  expect(document.activeElement).toBe(item("canvas:b"))
  expect(selected()).toBe("canvas:b")
  expect(actions.preview).toHaveBeenLastCalledWith(expect.objectContaining({ key: "canvas:b" }))
})

it("an arrow from the container itself starts at the first or last item", () => {
  render(<List />)
  const list = screen.getByTestId("list")
  press(list, { key: "ArrowUp" })
  expect(document.activeElement).toBe(item("image:c"))
})

it("Shift+Arrow extends from the anchor without previewing", () => {
  render(<List />)
  press(item("artifact:a"), { key: "ArrowDown" })
  expect(selected()).toBe("canvas:b")
  actions.preview.mockClear()
  press(document.activeElement!, { key: "ArrowDown", shiftKey: true })
  expect(selected()).toBe("canvas:b,image:c")
  expect(document.activeElement).toBe(item("image:c"))
  expect(actions.preview).not.toHaveBeenCalled()
  press(document.activeElement!, { key: "ArrowUp", shiftKey: true })
  press(document.activeElement!, { key: "ArrowUp", shiftKey: true })
  expect(selected()).toBe("artifact:a,canvas:b")
})

it("Esc clears the selection first, then closes the preview", () => {
  render(<List />)
  press(item("artifact:a"), { key: "ArrowDown" })
  useFilesLibraryStore.setState({ selectedKey: "canvas:b" })
  press(document.activeElement!, { key: "Escape" })
  expect(selected()).toBe("")
  expect(useFilesLibraryStore.getState().selectedKey).toBe("canvas:b")
  press(document.activeElement!, { key: "Escape" })
  expect(useFilesLibraryStore.getState().selectedKey).toBeNull()
})

it("ignores keys typed into a field inside the list", () => {
  render(<List />)
  const input = screen.getByRole("textbox", { name: "rename" })
  press(input, { key: "a", metaKey: true })
  press(input, { key: "Delete" })
  press(input, { key: "ArrowDown" })
  press(input, { key: "F2" })
  expect(selected()).toBe("")
  expect(actions.trash).not.toHaveBeenCalled()
  expect(actions.preview).not.toHaveBeenCalled()
  expect(useFilesLibraryStore.getState().renameTarget).toBeNull()
})

it("prevents the default only for a command", () => {
  render(<List />)
  const handled = fireEvent.keyDown(item("canvas:b"), { key: "F2" })
  expect(handled).toBe(false)
  const ignored = fireEvent.keyDown(item("canvas:b"), { key: "x" })
  expect(ignored).toBe(true)
})
