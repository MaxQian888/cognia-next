"use client"

/**
 * Drag and drop on the Files page (ADR-0223): items onto a folder or the
 * Trash, a folder onto another folder. What a drop means is decided by the
 * pure `resolveFilesDrop`; this module only wires dnd-kit to it and runs the
 * outcome through the page's actions.
 *
 * A pointer drag starts after 6px, so a click still selects and a double click
 * still opens. Keyboard users have the same moves through the item menu
 * ("Move to folder…", "Move to Trash"), so no keyboard sensor is registered.
 * Files dragged in from the system are a separate path (`FilesDropZone`).
 */

import { createContext, useContext, useMemo, useState, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core"
import { FilesIcon, FolderIcon } from "lucide-react"

import type { FilesActions } from "@/hooks/files-library/use-files-actions"
import type { LibraryFolder } from "@/lib/db/files-library-types"
import {
  draggedKeys,
  filesFolderDropId,
  FILES_TRASH_DROP_ID,
  resolveFilesDrop,
  snapChipToPointer,
  type FilesDragData,
  type FilesDropTarget,
} from "@/lib/files-library/dnd"
import type { FilesEntry } from "@/lib/files-library/types"

interface FilesDndContextValue {
  selected: ReadonlySet<string>
}

const FilesDndSelection = createContext<FilesDndContextValue>({ selected: new Set() })

export interface FilesDndProviderProps {
  entries: readonly FilesEntry[]
  folders: readonly LibraryFolder[]
  selected: ReadonlySet<string>
  actions: Pick<FilesActions, "moveToFolder" | "trash" | "moveFolder">
  children: ReactNode
}

function dragData(value: unknown): FilesDragData | null {
  if (!value || typeof value !== "object") return null
  const data = value as Partial<FilesDragData>
  if (data.type === "items" && Array.isArray((data as { keys?: unknown }).keys)) {
    return data as FilesDragData
  }
  if (data.type === "folder" && typeof (data as { folderId?: unknown }).folderId === "string") {
    return data as FilesDragData
  }
  return null
}

function dropTarget(value: unknown): FilesDropTarget | null {
  if (!value || typeof value !== "object") return null
  const data = value as Partial<FilesDropTarget>
  if (data.type === "trash") return { type: "trash" }
  if (data.type === "folder" && typeof (data as { folderId?: unknown }).folderId === "string") {
    return data as FilesDropTarget
  }
  return null
}

export function FilesDndProvider({
  entries,
  folders,
  selected,
  actions,
  children,
}: FilesDndProviderProps) {
  const t = useTranslations("files.dnd")
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))
  const [active, setActive] = useState<FilesDragData | null>(null)
  const byKey = useMemo(() => new Map(entries.map((entry) => [entry.key, entry])), [entries])
  const folderName = (id: string) => folders.find((folder) => folder.id === id)?.name ?? ""

  const describe = (data: FilesDragData | null) =>
    !data
      ? ""
      : data.type === "items"
        ? t("items", { count: data.keys.length })
        : t("folder", { name: folderName(data.folderId) })

  const onDragStart = (event: DragStartEvent) => setActive(dragData(event.active.data.current))

  const onDragEnd = (event: DragEndEvent) => {
    setActive(null)
    const drag = dragData(event.active.data.current)
    if (!drag) return
    const outcome = resolveFilesDrop(drag, dropTarget(event.over?.data.current), {
      entries: byKey,
      folders,
    })
    switch (outcome.action) {
      case "move-items":
        void actions.moveToFolder(
          outcome.keys.map((key) => byKey.get(key)!),
          outcome.folderId
        )
        break
      case "trash-items":
        void actions.trash(outcome.keys.map((key) => byKey.get(key)!))
        break
      case "move-folder":
        void actions.moveFolder(outcome.folderId, outcome.parentId)
        break
      case "none":
        break
    }
  }

  // dnd-kit's default announcements are English-only and read aloud, so they
  // come from the catalog like any other string.
  const accessibility = {
    announcements: {
      onDragStart: ({ active: start }: { active: { data: { current?: unknown } } }) =>
        t("pickedUp", { what: describe(dragData(start.data.current)) }),
      onDragOver: () => undefined,
      onDragEnd: ({ over }: { over: { id: unknown } | null }) =>
        over ? t("dropped") : t("cancelled"),
      onDragCancel: () => t("cancelled"),
    },
    screenReaderInstructions: { draggable: t("instructions") },
  }

  return (
    <FilesDndSelection.Provider value={{ selected }}>
      <DndContext
        sensors={sensors}
        collisionDetection={pointerWithin}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={() => setActive(null)}
        accessibility={accessibility}
      >
        {children}
        <DragOverlay dropAnimation={null} zIndex={60} modifiers={[snapChipToPointer]}>
          {active ? (
            <div
              className="inline-flex w-max items-center gap-2 rounded-md border bg-popover px-3 py-1.5 text-sm shadow-md"
              data-testid="files-drag-overlay"
            >
              {active.type === "items" ? (
                <FilesIcon className="size-4" aria-hidden />
              ) : (
                <FolderIcon className="size-4" aria-hidden />
              )}
              {describe(active)}
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </FilesDndSelection.Provider>
  )
}

/** Make an item draggable; a selected item carries the whole selection. */
export function useFilesItemDrag(key: string, disabled = false) {
  const { selected } = useContext(FilesDndSelection)
  return useDraggable({
    id: `files-drag:item:${key}`,
    data: { type: "items", keys: draggedKeys(key, selected) } satisfies FilesDragData,
    disabled,
  })
}

export function useFilesFolderDrag(folderId: string) {
  return useDraggable({
    id: `files-drag:folder:${folderId}`,
    data: { type: "folder", folderId } satisfies FilesDragData,
  })
}

export function useFilesFolderDrop(folderId: string) {
  return useDroppable({
    id: filesFolderDropId(folderId),
    data: { type: "folder", folderId } satisfies FilesDropTarget,
  })
}

export function useFilesTrashDrop() {
  return useDroppable({
    id: FILES_TRASH_DROP_ID,
    data: { type: "trash" } satisfies FilesDropTarget,
  })
}
