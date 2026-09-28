import type { LibraryFolder } from "@/lib/db/files-library-types"
import { childLibraryFolders, flattenLibraryFolders, libraryFolderPath } from "./folder-tree"

function folder(id: string, name: string, parentFolderId = "root"): LibraryFolder {
  return { id, name, parentFolderId, createdAt: 1, updatedAt: 1 }
}

const folders = [
  folder("b", "Beta"),
  folder("a", "alpha"),
  folder("a2", "Item 10", "a"),
  folder("a1", "Item 2", "a"),
  folder("x", "Orphan", "missing"),
]

describe("folder-tree", () => {
  it("walks the path from the top down and stops at a missing parent", () => {
    expect(libraryFolderPath(folders, "a2").map((f) => f.id)).toEqual(["a", "a2"])
    expect(libraryFolderPath(folders, "root")).toEqual([])
    expect(libraryFolderPath(folders, "x").map((f) => f.id)).toEqual(["x"])
    expect(libraryFolderPath(folders, "nope")).toEqual([])
  })

  it("survives a parent cycle", () => {
    const cyclic = [folder("p", "P", "q"), folder("q", "Q", "p")]
    expect(libraryFolderPath(cyclic, "p").length).toBeLessThanOrEqual(64)
    expect(flattenLibraryFolders(cyclic)).toEqual([])
  })

  it("lists children by natural name order and flattens depth-first", () => {
    expect(childLibraryFolders(folders, "a").map((f) => f.id)).toEqual(["a1", "a2"])
    expect(
      flattenLibraryFolders(folders).map(({ folder: f, depth }) => `${f.id}:${depth}`)
    ).toEqual(["a:0", "a1:1", "a2:1", "b:0"])
  })
})
