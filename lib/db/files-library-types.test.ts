import {
  isLibraryItemKept,
  LIBRARY_ITEM_KINDS,
  libraryItemKey,
  ROOT_LIBRARY_FOLDER_ID,
} from "./files-library-types"

describe("files-library-types", () => {
  it("keys an item by kind and source id", () => {
    expect(libraryItemKey("artifact", "a1")).toBe("artifact:a1")
    expect(LIBRARY_ITEM_KINDS).toEqual(["artifact", "canvas", "image", "session-upload", "upload"])
  })

  it("counts favorite, any folder (root included) and Files ownership as kept", () => {
    expect(isLibraryItemKept({})).toBe(false)
    expect(isLibraryItemKept({ favoritedAt: 0 })).toBe(true)
    expect(isLibraryItemKept({ folderId: ROOT_LIBRARY_FOLDER_ID })).toBe(true)
    expect(isLibraryItemKept({ ownedByFiles: true })).toBe(true)
  })
})
