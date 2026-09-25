import manifestJson from "../plugin.json"
import { PANEL_ACTIVITY, PANEL_FULL_ID, PANEL_ID, PLUGIN_ID, SECRET_API_KEY } from "./ids"

describe("e2b-sandbox ids", () => {
  it("names the plugin exactly as plugin.json does", () => {
    // `usePluginTranslations(PLUGIN_ID)` and the workbench registry both key on
    // this id; a drift would silently resolve every panel string to its key.
    expect(PLUGIN_ID).toBe(manifestJson.id)
  })

  it("namespaces the panel id the way the workbench registry stores it", () => {
    expect(PANEL_FULL_ID).toBe(`${manifestJson.id}:${PANEL_ID}`)
  })

  it("claims its own rail activity rather than the crowded `inspect` group", () => {
    expect(PANEL_ACTIVITY).not.toBe("inspect")
    expect(PANEL_ACTIVITY).toMatch(/^[a-z0-9-]+$/)
  })

  it("keeps the keyring key stable — renaming it would orphan every saved API key", () => {
    expect(SECRET_API_KEY).toBe("e2b.apiKey")
  })
})
