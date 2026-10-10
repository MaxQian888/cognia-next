jest.mock("@/lib/db/files-library-items", () => ({ setLibraryItemDisplayName: jest.fn() }))
jest.mock("@/lib/db/session-assets", () => ({ renameLibraryAsset: jest.fn() }))
jest.mock("@/stores/artifact/artifact-store", () => {
  const state = {
    canvasDocuments: {} as Record<string, unknown>,
    updateCanvasDocument: jest.fn(),
  }
  return { useArtifactStore: { getState: () => state } }
})

import { setLibraryItemDisplayName } from "@/lib/db/files-library-items"
import { renameLibraryAsset } from "@/lib/db/session-assets"
import { useArtifactStore } from "@/stores/artifact/artifact-store"

import { FilesRenameError, renameFilesEntry, renameTargetFor } from "./rename"
import type { FilesEntry } from "./types"

const setDisplayNameMock = setLibraryItemDisplayName as jest.Mock
const renameAssetMock = renameLibraryAsset as jest.Mock

function entry(overrides: Partial<FilesEntry> & Pick<FilesEntry, "kind" | "sourceId">): FilesEntry {
  return {
    key: `${overrides.kind}:${overrides.sourceId}`,
    title: "Original",
    sourceTitle: "Original",
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
    ...overrides,
  }
}

function deps() {
  return {
    renameCanvas: jest.fn((_id: string, _title: string) => true),
    renameAsset: jest.fn(async (_assetId: string, _filename: string) => undefined),
    setDisplayName: jest.fn(async (_source: unknown, _name: string | null) => undefined),
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  const state = useArtifactStore.getState() as unknown as {
    canvasDocuments: Record<string, unknown>
  }
  state.canvasDocuments = {}
})

describe("renameTargetFor", () => {
  it("renames canvas documents at the source", () => {
    expect(renameTargetFor({ kind: "canvas", ownedByFiles: false })).toBe("canvas-title")
    expect(renameTargetFor({ kind: "canvas", ownedByFiles: true })).toBe("canvas-title")
  })

  it("renames Files-owned uploads at the source", () => {
    expect(renameTargetFor({ kind: "upload", ownedByFiles: true })).toBe("library-asset")
  })

  it("stores a display name for everything else", () => {
    expect(renameTargetFor({ kind: "upload", ownedByFiles: false })).toBe("display-name")
    expect(renameTargetFor({ kind: "artifact", ownedByFiles: false })).toBe("display-name")
    expect(renameTargetFor({ kind: "session-upload", ownedByFiles: false })).toBe("display-name")
    // An image uploaded into Files has no filename of its own.
    expect(renameTargetFor({ kind: "image", ownedByFiles: true })).toBe("display-name")
    expect(renameTargetFor({ kind: "image", ownedByFiles: false })).toBe("display-name")
  })
})

describe("renameFilesEntry", () => {
  it("refuses an empty or blank name before any write", async () => {
    const d = deps()
    for (const name of ["", "   ", "\n\t"]) {
      const error = await renameFilesEntry(
        entry({ kind: "artifact", sourceId: "a1" }),
        name,
        d
      ).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(FilesRenameError)
      expect((error as FilesRenameError).code).toBe("files_name_required")
      expect((error as FilesRenameError).name).toBe("FilesRenameError")
    }
    expect(d.renameCanvas).not.toHaveBeenCalled()
    expect(d.renameAsset).not.toHaveBeenCalled()
    expect(d.setDisplayName).not.toHaveBeenCalled()
  })

  describe("canvas documents", () => {
    it("renames the document with the trimmed title", async () => {
      const d = deps()
      await renameFilesEntry(entry({ kind: "canvas", sourceId: "c1" }), "  Plan  ", d)
      expect(d.renameCanvas).toHaveBeenCalledWith("c1", "Plan")
      expect(d.setDisplayName).not.toHaveBeenCalled()
    })

    it("clears an older display name that would hide the new title", async () => {
      const d = deps()
      await renameFilesEntry(
        entry({ kind: "canvas", sourceId: "c1", title: "Old display", sourceTitle: "Doc" }),
        "Plan",
        d
      )
      expect(d.renameCanvas).toHaveBeenCalledWith("c1", "Plan")
      expect(d.setDisplayName).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "canvas", sourceId: "c1" }),
        null
      )
    })

    it("reports a missing document", async () => {
      const d = deps()
      d.renameCanvas.mockReturnValue(false)
      const error = await renameFilesEntry(
        entry({ kind: "canvas", sourceId: "c1" }),
        "Plan",
        d
      ).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(FilesRenameError)
      expect((error as FilesRenameError).code).toBe("files_source_missing")
      expect(d.setDisplayName).not.toHaveBeenCalled()
    })

    it("goes through the artifact store when no canvas renamer is injected", async () => {
      const state = useArtifactStore.getState() as unknown as {
        canvasDocuments: Record<string, unknown>
        updateCanvasDocument: jest.Mock
      }
      state.canvasDocuments = { c1: { id: "c1" } }
      await renameFilesEntry(entry({ kind: "canvas", sourceId: "c1" }), " Plan ", {
        setDisplayName: deps().setDisplayName,
      })
      expect(state.updateCanvasDocument).toHaveBeenCalledWith("c1", { title: "Plan" })

      const error = await renameFilesEntry(
        entry({ kind: "canvas", sourceId: "gone" }),
        "Plan"
      ).catch((e: unknown) => e)
      expect((error as FilesRenameError).code).toBe("files_source_missing")
      expect(state.updateCanvasDocument).toHaveBeenCalledTimes(1)
    })
  })

  describe("Files-owned uploads", () => {
    it("renames the asset's filename", async () => {
      const d = deps()
      await renameFilesEntry(
        entry({ kind: "upload", sourceId: "asset-1", ownedByFiles: true }),
        " deck.pdf ",
        d
      )
      expect(d.renameAsset).toHaveBeenCalledWith("asset-1", "deck.pdf")
      expect(d.setDisplayName).not.toHaveBeenCalled()
    })

    it("clears an older display name", async () => {
      const d = deps()
      await renameFilesEntry(
        entry({
          kind: "upload",
          sourceId: "asset-1",
          ownedByFiles: true,
          title: "Shown",
          sourceTitle: "a.pdf",
        }),
        "deck.pdf",
        d
      )
      expect(d.setDisplayName).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "upload", sourceId: "asset-1" }),
        null
      )
    })

    it("propagates an asset write failure", async () => {
      const d = deps()
      d.renameAsset.mockRejectedValue(new Error("not found"))
      await expect(
        renameFilesEntry(entry({ kind: "upload", sourceId: "asset-1", ownedByFiles: true }), "x", d)
      ).rejects.toThrow("not found")
    })

    it("uses renameLibraryAsset by default", async () => {
      await renameFilesEntry(
        entry({ kind: "upload", sourceId: "asset-1", ownedByFiles: true }),
        "deck.pdf"
      )
      expect(renameAssetMock).toHaveBeenCalledWith("asset-1", "deck.pdf")
    })
  })

  describe("display names", () => {
    it("stores the trimmed name with the entry's write source", async () => {
      const d = deps()
      await renameFilesEntry(
        entry({
          kind: "artifact",
          sourceId: "a1",
          originSessionId: "s1",
          projectIds: ["p1"],
          sourceTitle: "Parser",
          title: "Parser",
        }),
        "  My parser ",
        d
      )
      expect(d.setDisplayName).toHaveBeenCalledWith(
        {
          kind: "artifact",
          sourceId: "a1",
          originSessionId: "s1",
          projectId: "p1",
          snapshot: { title: "Parser" },
        },
        "My parser"
      )
      expect(d.renameCanvas).not.toHaveBeenCalled()
      expect(d.renameAsset).not.toHaveBeenCalled()
    })

    it("clears the display name when renaming back to the source title", async () => {
      const d = deps()
      await renameFilesEntry(
        entry({ kind: "image", sourceId: "h1", title: "Custom", sourceTitle: "shot.png" }),
        " shot.png ",
        d
      )
      expect(d.setDisplayName).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "image", sourceId: "h1" }),
        null
      )
    })

    it("uses setLibraryItemDisplayName by default", async () => {
      await renameFilesEntry(entry({ kind: "session-upload", sourceId: "c1" }), "Spec")
      expect(setDisplayNameMock).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "session-upload", sourceId: "c1" }),
        "Spec"
      )
    })
  })
})
