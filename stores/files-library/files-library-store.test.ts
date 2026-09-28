import { useFilesLibraryStore } from "./files-library-store"

const initial = useFilesLibraryStore.getState()
beforeEach(() => useFilesLibraryStore.setState(initial, true))

describe("files library store", () => {
  it("starts on Recent at the Folders root with nothing selected", () => {
    expect(useFilesLibraryStore.getState()).toMatchObject({
      viewMode: "grid",
      sort: "recent",
      type: "all",
      projectScope: "current",
      tab: "recent",
      folderId: "root",
      search: "",
      selectedKey: null,
    })
  })

  it("resets the folder and preview when the tab changes, and entering a folder opens Folders", () => {
    const s = useFilesLibraryStore.getState()
    s.enterFolder("lbf_a")
    s.select("image:h")
    expect(useFilesLibraryStore.getState()).toMatchObject({
      tab: "folders",
      folderId: "lbf_a",
      selectedKey: "image:h",
    })
    s.select("image:h")
    s.setTab("images")
    expect(useFilesLibraryStore.getState()).toMatchObject({
      tab: "images",
      folderId: "root",
      selectedKey: null,
    })
  })

  it("sets preferences and search", () => {
    const s = useFilesLibraryStore.getState()
    s.setViewMode("list")
    s.setSort("size")
    s.setType("file")
    s.setProjectScope("all")
    s.setSearch("spec")
    expect(useFilesLibraryStore.getState()).toMatchObject({
      viewMode: "list",
      sort: "size",
      type: "file",
      projectScope: "all",
      search: "spec",
    })
  })

  it("opens and closes every dialog target", () => {
    const s = useFilesLibraryStore.getState()
    s.openMove(["a", "b"])
    s.openDelete("upload:u")
    s.openFolderDialog({ mode: "create", parentId: "root" })
    s.openDeleteFolder("lbf_a")
    expect(useFilesLibraryStore.getState()).toMatchObject({
      moveTarget: ["a", "b"],
      deleteTarget: "upload:u",
      folderDialog: { mode: "create", parentId: "root" },
      deleteFolderTarget: "lbf_a",
    })
    s.closeMove()
    s.closeDelete()
    s.closeFolderDialog()
    s.closeDeleteFolder()
    expect(useFilesLibraryStore.getState()).toMatchObject({
      moveTarget: null,
      deleteTarget: null,
      folderDialog: null,
      deleteFolderTarget: null,
    })
  })

  it("persists only the view preferences", () => {
    const options = (
      useFilesLibraryStore as unknown as {
        persist: { getOptions: () => { partialize: (s: unknown) => unknown; name: string } }
      }
    ).persist.getOptions()
    expect(options.name).toBe("files-library-prefs")
    useFilesLibraryStore.getState().setSearch("secret")
    expect(options.partialize(useFilesLibraryStore.getState())).toEqual({
      viewMode: "grid",
      sort: "recent",
      type: "all",
      projectScope: "current",
    })
  })
})
