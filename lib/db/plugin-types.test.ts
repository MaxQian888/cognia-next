import type { PluginRow } from "./plugin-types"

describe("PluginRow lifecycle metadata", () => {
  it("accepts the non-indexed lifecycle control-plane record", () => {
    const row = {
      lifecycle: {
        intent: "disabled",
        actual: "dirty",
        revision: 3,
        updatedAt: 1,
      },
    } as Pick<PluginRow, "lifecycle">

    expect(row.lifecycle).toMatchObject({ intent: "disabled", actual: "dirty", revision: 3 })
  })
})
