import manifestJson from "../plugin.json"
import { PLUGIN_ID, PROVIDER_ID } from "./ids"

describe("remote-desktop-vnc ids", () => {
  it("matches the manifest and forms the binding provider id", () => {
    expect(PLUGIN_ID).toBe(manifestJson.id)
    expect(`${PLUGIN_ID}.${PROVIDER_ID}`).toBe("cognia-remote-desktop-vnc.vnc")
  })
})
