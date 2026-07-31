import { defineSessionImporter } from "./define-session-importer"

describe("defineSessionImporter", () => {
  it("is a typesafe identity function", () => {
    const def = defineSessionImporter({
      id: "cursor",
      label: "Cursor",
      entry: "src/cursor.ts",
      export: "createImporter",
    })
    expect(def).toEqual({
      id: "cursor",
      label: "Cursor",
      entry: "src/cursor.ts",
      export: "createImporter",
    })
  })
})
