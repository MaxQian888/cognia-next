/**
 * @jest-environment jsdom
 */

import * as Barrel from "./index"

describe("stores/artifact barrel", () => {
  it("re-exports useArtifactStore", () => {
    expect(typeof Barrel.useArtifactStore).toBe("function")
  })
})
