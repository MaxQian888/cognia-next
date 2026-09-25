import manifestJson from "../plugin.json"
import { PLUGIN_ID } from "./ids"

it("reads the plugin id from plugin.json", () => {
  expect(PLUGIN_ID).toBe(manifestJson.id)
  expect(PLUGIN_ID).toBe("cognia-playwright-mcp")
})
