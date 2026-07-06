import * as Barrel from "./index"

describe("hooks/artifacts barrel", () => {
  it("re-exports the public hooks", () => {
    expect(typeof Barrel.useArtifactList).toBe("function")
    expect(typeof Barrel.useArtifactPanelState).toBe("function")
    expect(typeof Barrel.useArtifactDockShortcuts).toBe("function")
  })
})
