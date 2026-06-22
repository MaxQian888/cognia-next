import { defineView, defineTreeDataProvider } from "./define-view"

describe("defineView / defineTreeDataProvider", () => {
  it("returns the view definition unchanged", () => {
    const v = defineView({
      id: "files",
      containerId: "explorer",
      type: "tree",
      entry: "dist/views.js",
      export: "filesProvider",
    })
    expect(v).toMatchObject({ id: "files", type: "tree", export: "filesProvider" })
  })

  it("returns the tree data provider unchanged", () => {
    const nodes = [{ id: "a", label: "A" }]
    const p = defineTreeDataProvider({ getChildren: () => nodes })
    expect(p.getChildren(undefined)).toBe(nodes)
  })
})
