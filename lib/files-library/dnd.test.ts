import type { LibraryFolder } from "@/lib/db/files-library-types"

import {
  DRAG_CHIP_GAP_PX,
  draggedKeys,
  FILES_TRASH_DROP_ID,
  filesFolderDropId,
  folderDescendants,
  resolveFilesDrop,
  snapChipToPointer,
} from "./dnd"
import type { FilesEntry } from "./types"

function folder(id: string, parentFolderId = "root"): LibraryFolder {
  return { id, name: id, parentFolderId, createdAt: 1, updatedAt: 1 }
}

// root ─ a ─ b ─ c
//      └ d
const folders = [folder("a"), folder("b", "a"), folder("c", "b"), folder("d")]

const entries = new Map<string, Pick<FilesEntry, "folderId" | "trashedAt">>([
  ["artifact:1", {}],
  ["artifact:2", { folderId: "a" }],
  ["canvas:3", { folderId: "root" }],
  ["image:4", { trashedAt: 5 }],
])
const context = { entries, folders }

describe("drop ids", () => {
  it("names folder and trash drop targets", () => {
    expect(filesFolderDropId("lbf_1")).toBe("files-drop:folder:lbf_1")
    expect(filesFolderDropId("root")).toBe("files-drop:folder:root")
    expect(FILES_TRASH_DROP_ID).toBe("files-drop:trash")
  })
})

describe("draggedKeys", () => {
  it("drags the whole selection when the item is part of it", () => {
    expect(draggedKeys("a", new Set(["a", "b", "c"]))).toEqual(["a", "b", "c"])
  })

  it("drags just the item otherwise", () => {
    expect(draggedKeys("z", new Set(["a", "b"]))).toEqual(["z"])
    expect(draggedKeys("z", new Set())).toEqual(["z"])
  })
})

describe("folderDescendants", () => {
  it("collects the whole subtree, not the folder itself", () => {
    expect(folderDescendants(folders, "a")).toEqual(new Set(["b", "c"]))
    expect(folderDescendants(folders, "b")).toEqual(new Set(["c"]))
    expect(folderDescendants(folders, "c")).toEqual(new Set())
    expect(folderDescendants(folders, "root")).toEqual(new Set(["a", "b", "c", "d"]))
    expect(folderDescendants(folders, "missing")).toEqual(new Set())
  })

  it("survives a corrupt parent cycle", () => {
    const cyclic = [folder("x", "y"), folder("y", "x")]
    expect(folderDescendants(cyclic, "x")).toEqual(new Set(["y", "x"]))
  })
})

describe("resolveFilesDrop", () => {
  it("does nothing without a target", () => {
    expect(resolveFilesDrop({ type: "items", keys: ["artifact:1"] }, null, context)).toEqual({
      action: "none",
    })
    expect(resolveFilesDrop({ type: "folder", folderId: "a" }, null, context)).toEqual({
      action: "none",
    })
  })

  describe("items", () => {
    it("files items in a folder, skipping those already there", () => {
      expect(
        resolveFilesDrop(
          { type: "items", keys: ["artifact:1", "artifact:2", "canvas:3"] },
          { type: "folder", folderId: "a" },
          context
        )
      ).toEqual({ action: "move-items", keys: ["artifact:1", "canvas:3"], folderId: "a" })
    })

    it("files items at the root", () => {
      expect(
        resolveFilesDrop(
          { type: "items", keys: ["artifact:1", "canvas:3"] },
          { type: "folder", folderId: "root" },
          context
        )
      ).toEqual({ action: "move-items", keys: ["artifact:1"], folderId: "root" })
    })

    it("does nothing when every item is already in the folder", () => {
      expect(
        resolveFilesDrop(
          { type: "items", keys: ["artifact:2"] },
          { type: "folder", folderId: "a" },
          context
        )
      ).toEqual({ action: "none" })
    })

    it("sends items to the Trash", () => {
      expect(
        resolveFilesDrop(
          { type: "items", keys: ["artifact:1", "artifact:2"] },
          { type: "trash" },
          context
        )
      ).toEqual({ action: "trash-items", keys: ["artifact:1", "artifact:2"] })
    })

    it("ignores trashed and unknown items", () => {
      expect(
        resolveFilesDrop({ type: "items", keys: ["image:4", "gone:9"] }, { type: "trash" }, context)
      ).toEqual({ action: "none" })
      expect(
        resolveFilesDrop(
          { type: "items", keys: ["image:4", "gone:9"] },
          { type: "folder", folderId: "d" },
          context
        )
      ).toEqual({ action: "none" })
      expect(
        resolveFilesDrop(
          { type: "items", keys: ["image:4", "artifact:1"] },
          { type: "folder", folderId: "d" },
          context
        )
      ).toEqual({ action: "move-items", keys: ["artifact:1"], folderId: "d" })
    })
  })

  describe("folders", () => {
    it("re-parents a folder onto another folder", () => {
      expect(
        resolveFilesDrop(
          { type: "folder", folderId: "c" },
          { type: "folder", folderId: "d" },
          context
        )
      ).toEqual({ action: "move-folder", folderId: "c", parentId: "d" })
    })

    it("moves a nested folder to the root", () => {
      expect(
        resolveFilesDrop(
          { type: "folder", folderId: "b" },
          { type: "folder", folderId: "root" },
          context
        )
      ).toEqual({ action: "move-folder", folderId: "b", parentId: "root" })
    })

    it("refuses a drop onto itself", () => {
      expect(
        resolveFilesDrop(
          { type: "folder", folderId: "a" },
          { type: "folder", folderId: "a" },
          context
        )
      ).toEqual({ action: "none" })
    })

    it("refuses a no-op onto its current parent", () => {
      expect(
        resolveFilesDrop(
          { type: "folder", folderId: "b" },
          { type: "folder", folderId: "a" },
          context
        )
      ).toEqual({ action: "none" })
      expect(
        resolveFilesDrop(
          { type: "folder", folderId: "a" },
          { type: "folder", folderId: "root" },
          context
        )
      ).toEqual({ action: "none" })
    })

    it("refuses a move into its own subtree", () => {
      expect(
        resolveFilesDrop(
          { type: "folder", folderId: "a" },
          { type: "folder", folderId: "c" },
          context
        )
      ).toEqual({ action: "none" })
      expect(
        resolveFilesDrop(
          { type: "folder", folderId: "a" },
          { type: "folder", folderId: "b" },
          context
        )
      ).toEqual({ action: "none" })
    })

    it("does nothing for the Trash or an unknown folder", () => {
      expect(
        resolveFilesDrop({ type: "folder", folderId: "a" }, { type: "trash" }, context)
      ).toEqual({ action: "none" })
      expect(
        resolveFilesDrop(
          { type: "folder", folderId: "missing" },
          { type: "folder", folderId: "d" },
          context
        )
      ).toEqual({ action: "none" })
    })
  })
})

describe("snapChipToPointer", () => {
  const transform = { x: 5, y: 7, scaleX: 1, scaleY: 1 }

  it("moves the chip to where the drag began inside the row", () => {
    const activatorEvent = { clientX: 300, clientY: 140 } as unknown as Event
    expect(
      snapChipToPointer({ activatorEvent, activeNodeRect: { left: 100, top: 120 }, transform })
    ).toEqual({ x: 5 + 200 + DRAG_CHIP_GAP_PX, y: 7 + 20 + DRAG_CHIP_GAP_PX, scaleX: 1, scaleY: 1 })
  })

  it("reads the first touch of a touch drag", () => {
    const activatorEvent = { touches: [{ clientX: 50, clientY: 60 }] } as unknown as Event
    expect(
      snapChipToPointer({ activatorEvent, activeNodeRect: { left: 40, top: 40 }, transform })
    ).toMatchObject({ x: 5 + 10 + DRAG_CHIP_GAP_PX, y: 7 + 20 + DRAG_CHIP_GAP_PX })
  })

  it("leaves the transform alone without an event, a rect or coordinates", () => {
    expect(snapChipToPointer({ activatorEvent: null, activeNodeRect: null, transform })).toBe(
      transform
    )
    expect(
      snapChipToPointer({
        activatorEvent: {} as Event,
        activeNodeRect: { left: 0, top: 0 },
        transform,
      })
    ).toBe(transform)
  })
})
