/**
 * What a drag on the Files page means (ADR-0223). Pure: the page's dnd-kit
 * wiring turns a drop into one of these outcomes and runs it.
 *
 * - Items onto a folder (the root included) file them there; onto the Trash,
 *   they go to the Trash. Dragging a selected item drags the whole selection.
 * - A folder onto another folder re-parents it — never into itself or its own
 *   subtree, and never as a no-op onto the parent it already has.
 * - Anything else does nothing.
 */

import { ROOT_LIBRARY_FOLDER_ID, type LibraryFolder } from "@/lib/db/files-library-types"

import type { FilesEntry } from "./types"

export type FilesDragData =
  { type: "items"; keys: readonly string[] } | { type: "folder"; folderId: string }

export type FilesDropTarget = { type: "folder"; folderId: string } | { type: "trash" }

export type FilesDropOutcome =
  | { action: "move-items"; keys: string[]; folderId: string }
  | { action: "trash-items"; keys: string[] }
  | { action: "move-folder"; folderId: string; parentId: string }
  | { action: "none" }

export const FILES_TRASH_DROP_ID = "files-drop:trash"

export function filesFolderDropId(folderId: string): string {
  return `files-drop:folder:${folderId}`
}

/** The keys a drag of `key` carries: the selection when `key` is part of it. */
export function draggedKeys(key: string, selected: ReadonlySet<string>): string[] {
  return selected.has(key) ? [...selected] : [key]
}

/** Every folder under `folderId`, by walking the in-memory tree. */
export function folderDescendants(
  folders: readonly LibraryFolder[],
  folderId: string
): Set<string> {
  const children = new Map<string, string[]>()
  for (const folder of folders) {
    const list = children.get(folder.parentFolderId) ?? []
    list.push(folder.id)
    children.set(folder.parentFolderId, list)
  }
  const out = new Set<string>()
  const stack = [...(children.get(folderId) ?? [])]
  while (stack.length > 0) {
    const id = stack.pop()!
    if (out.has(id)) continue
    out.add(id)
    stack.push(...(children.get(id) ?? []))
  }
  return out
}

export function resolveFilesDrop(
  drag: FilesDragData,
  target: FilesDropTarget | null,
  context: {
    entries: ReadonlyMap<string, Pick<FilesEntry, "folderId" | "trashedAt">>
    folders: readonly LibraryFolder[]
  }
): FilesDropOutcome {
  if (!target) return { action: "none" }
  if (drag.type === "items") {
    const live = drag.keys.filter((key) => {
      const entry = context.entries.get(key)
      return entry !== undefined && entry.trashedAt === undefined
    })
    if (target.type === "trash") {
      return live.length > 0 ? { action: "trash-items", keys: live } : { action: "none" }
    }
    const moving = live.filter((key) => context.entries.get(key)?.folderId !== target.folderId)
    return moving.length > 0
      ? { action: "move-items", keys: moving, folderId: target.folderId }
      : { action: "none" }
  }
  if (target.type !== "folder") return { action: "none" }
  const folder = context.folders.find((candidate) => candidate.id === drag.folderId)
  if (!folder) return { action: "none" }
  if (target.folderId === folder.id || folder.parentFolderId === target.folderId) {
    return { action: "none" }
  }
  if (
    target.folderId !== ROOT_LIBRARY_FOLDER_ID &&
    folderDescendants(context.folders, folder.id).has(target.folderId)
  ) {
    return { action: "none" }
  }
  return { action: "move-folder", folderId: folder.id, parentId: target.folderId }
}

/**
 * Keep the drag chip beside the pointer (ADR-0223). The overlay starts where
 * the dragged row starts — for a full-width row that is far from the cursor —
 * so shift it by where inside the row the drag began, plus a small gap.
 */
export const DRAG_CHIP_GAP_PX = 12

export function snapChipToPointer(args: {
  activatorEvent: Event | null
  activeNodeRect: { left: number; top: number } | null
  transform: { x: number; y: number; scaleX: number; scaleY: number }
}) {
  const { activatorEvent, activeNodeRect, transform } = args
  if (!activatorEvent || !activeNodeRect) return transform
  const point = pointerOf(activatorEvent)
  if (!point) return transform
  return {
    ...transform,
    x: transform.x + point.x - activeNodeRect.left + DRAG_CHIP_GAP_PX,
    y: transform.y + point.y - activeNodeRect.top + DRAG_CHIP_GAP_PX,
  }
}

function pointerOf(event: Event): { x: number; y: number } | null {
  const touch = (event as TouchEvent).touches?.[0]
  if (touch) return { x: touch.clientX, y: touch.clientY }
  const { clientX, clientY } = event as MouseEvent
  return typeof clientX === "number" && typeof clientY === "number"
    ? { x: clientX, y: clientY }
    : null
}
