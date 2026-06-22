import * as sdk from "./context-provider"

describe("plugin-sdk: api/context-provider", () => {
  it("re-exports defineContextProvider", () => {
    expect(typeof sdk.defineContextProvider).toBe("function")
  })

  it("defineContextProvider is a typesafe identity function", () => {
    const p = sdk.defineContextProvider({ id: "ctx", provide: () => "x" })
    expect(p.id).toBe("ctx")
  })

  it("defineContextProvider accepts declarative manifest entries", () => {
    const p = sdk.defineContextProvider({
      id: "repo",
      label: "Repository Context",
      entry: "src/context/repo.ts",
      export: "createRepoContextProvider",
    })
    expect(p.entry).toBe("src/context/repo.ts")
  })
})
