/**
 * @jest-environment jsdom
 */
import { act, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"

// Capture what the provider hands dnd-kit; a pointer drag needs layout jsdom
// does not have, and the drop rules themselves are pinned in lib/files-library/dnd.
const captured: { props?: Record<string, unknown> } = {}
jest.mock("@dnd-kit/core", () => {
  const actual = jest.requireActual("@dnd-kit/core")
  return {
    ...actual,
    DndContext: (props: Record<string, unknown> & { children: ReactNode }) => {
      captured.props = props
      return <actual.DndContext {...props} />
    },
  }
})

import type { FilesActions } from "@/hooks/files-library/use-files-actions"
import type { LibraryFolder } from "@/lib/db/files-library-types"
import type { FilesEntry } from "@/lib/files-library/types"
import {
  FilesDndProvider,
  useFilesFolderDrop,
  useFilesItemDrag,
  useFilesTrashDrop,
} from "./files-dnd"

function entry(key: string, extra: Partial<FilesEntry> = {}): FilesEntry {
  return {
    key,
    kind: "artifact",
    sourceId: key,
    title: key,
    sourceTitle: key,
    projectIds: [],
    sessionIds: [],
    originAlive: true,
    createdAt: 1,
    updatedAt: 1,
    ownedByFiles: false,
    hidden: false,
    sharedWithMe: false,
    creator: "user",
    searchText: "",
    ...extra,
  }
}

const folders: LibraryFolder[] = [
  { id: "lbf_a", name: "Specs", parentFolderId: "root", createdAt: 1, updatedAt: 1 },
  { id: "lbf_b", name: "Drafts", parentFolderId: "root", createdAt: 1, updatedAt: 1 },
]
const entries = [entry("a"), entry("b"), entry("c")]

function actions() {
  return {
    moveToFolder: jest.fn(async () => {}),
    trash: jest.fn(async () => {}),
    moveFolder: jest.fn(async () => {}),
  } satisfies Pick<FilesActions, "moveToFolder" | "trash" | "moveFolder">
}

function Item({ id }: { id: string }) {
  const { setNodeRef, attributes } = useFilesItemDrag(id)
  return <div ref={setNodeRef} {...attributes} data-testid={`item-${id}`} />
}

function Targets() {
  const { setNodeRef: folderRef } = useFilesFolderDrop("lbf_a")
  const { setNodeRef: trashRef } = useFilesTrashDrop()
  return (
    <>
      <div ref={folderRef} data-testid="folder" />
      <div ref={trashRef} data-testid="trash" />
    </>
  )
}

function dragEnd(active: unknown, over: unknown) {
  const onDragEnd = captured.props?.onDragEnd as (event: unknown) => void
  act(() => onDragEnd({ active: { data: { current: active } }, over }))
}

function setup(selected: ReadonlySet<string> = new Set()) {
  const a = actions()
  render(
    <FilesDndProvider entries={entries} folders={folders} selected={selected} actions={a}>
      <Item id="a" />
      <Targets />
    </FilesDndProvider>
  )
  return a
}

it("moves dragged items into the folder they land on", () => {
  const a = setup()
  dragEnd(
    { type: "items", keys: ["a", "b"] },
    { id: "x", data: { current: { type: "folder", folderId: "lbf_a" } } }
  )
  expect(a.moveToFolder).toHaveBeenCalledWith([entries[0], entries[1]], "lbf_a")
})

it("trashes items dropped on the Trash", () => {
  const a = setup()
  dragEnd({ type: "items", keys: ["c"] }, { id: "t", data: { current: { type: "trash" } } })
  expect(a.trash).toHaveBeenCalledWith([entries[2]])
})

it("re-parents a folder and ignores drops on nothing", () => {
  const a = setup()
  dragEnd(
    { type: "folder", folderId: "lbf_b" },
    { id: "x", data: { current: { type: "folder", folderId: "lbf_a" } } }
  )
  expect(a.moveFolder).toHaveBeenCalledWith("lbf_b", "lbf_a")
  dragEnd({ type: "items", keys: ["a"] }, null)
  dragEnd({ nonsense: true }, { id: "t", data: { current: { type: "trash" } } })
  expect(a.moveToFolder).not.toHaveBeenCalled()
  expect(a.trash).not.toHaveBeenCalled()
})

it("makes items draggable and announces drags from the catalog", () => {
  setup(new Set(["a", "c"]))
  expect(screen.getByTestId("item-a")).toHaveAttribute("aria-roledescription", "draggable")
  const announcements = (
    captured.props?.accessibility as {
      announcements: { onDragStart: (e: unknown) => string; onDragEnd: (e: unknown) => string }
    }
  ).announcements
  expect(
    announcements.onDragStart({
      active: { data: { current: { type: "items", keys: ["a", "c"] } } },
    })
  ).toBe("Picked up 2 items.")
  expect(
    announcements.onDragStart({
      active: { data: { current: { type: "folder", folderId: "lbf_a" } } },
    })
  ).toBe("Picked up folder Specs.")
  expect(announcements.onDragEnd({ over: { id: "x" } })).toBe("Dropped.")
  expect(announcements.onDragEnd({ over: null })).toBe("Drag cancelled.")
})
