import manifest from "../plugin.json"
import { PLUGIN_ID } from "./model"

describe("model", () => {
  it("names the plugin by its manifest id", () => {
    expect(PLUGIN_ID).toBe(manifest.id)
  })
})
