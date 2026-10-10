import {
  FILES_TRASH_RETENTION_MS,
  isLibraryFolderColor,
  isLibraryFolderIcon,
  isLibraryItemKept,
  LIBRARY_FOLDER_COLORS,
  LIBRARY_FOLDER_ICONS,
  LIBRARY_ITEM_KINDS,
  libraryItemKey,
  ROOT_LIBRARY_FOLDER_ID,
} from "./files-library-types"

describe("files-library-types", () => {
  it("keys an item by kind and source id", () => {
    expect(libraryItemKey("artifact", "a1")).toBe("artifact:a1")
    expect(LIBRARY_ITEM_KINDS).toEqual([
      "artifact",
      "canvas",
      "image",
      "session-upload",
      "upload",
      "workspace-file",
    ])
  })

  it("counts favorite, any folder (root included) and Files ownership as kept", () => {
    expect(isLibraryItemKept({})).toBe(false)
    expect(isLibraryItemKept({ favoritedAt: 0 })).toBe(true)
    expect(isLibraryItemKept({ folderId: ROOT_LIBRARY_FOLDER_ID })).toBe(true)
    expect(isLibraryItemKept({ ownedByFiles: true })).toBe(true)
  })

  it("keeps a trashed item until the purge, for thirty days", () => {
    expect(isLibraryItemKept({ trashedAt: 1 })).toBe(true)
    expect(FILES_TRASH_RETENTION_MS).toBe(30 * 24 * 60 * 60 * 1000)
  })

  it("accepts only the declared folder colors and icons", () => {
    for (const color of LIBRARY_FOLDER_COLORS) expect(isLibraryFolderColor(color)).toBe(true)
    for (const icon of LIBRARY_FOLDER_ICONS) expect(isLibraryFolderIcon(icon)).toBe(true)
    expect(isLibraryFolderColor("#ff0000")).toBe(false)
    expect(isLibraryFolderIcon("rocket")).toBe(false)
    expect(isLibraryFolderColor(undefined)).toBe(false)
  })
})
