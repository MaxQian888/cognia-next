/**
 * `readAppSettings` is the DEFAULT `readSettings` every production caller of
 * `buildAgentTeamRuntimeDeps` gets (the three initializers all call it with no
 * arguments). The rest of the lead-execution suite injects `readSettings`, so
 * nothing there would notice if this default read the wrong store — or no store
 * at all.
 */
import { readAppSettings } from "./lead-execution"
import { useSettingsStore } from "@/stores/settings"
import type { AppSettings } from "@cognia/agent-config-types"

describe("readAppSettings", () => {
  afterEach(() => {
    useSettingsStore.setState({ settings: null })
  })

  it("reads the live settings store", async () => {
    const settings = {
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-8",
      providerSettings: { anthropic: { enabled: true, apiKey: "sk-ant-test" } },
    } as unknown as AppSettings
    useSettingsStore.setState({ settings })

    await expect(readAppSettings()).resolves.toBe(settings)
  })

  it("returns null before settings have loaded", async () => {
    useSettingsStore.setState({ settings: null })

    await expect(readAppSettings()).resolves.toBeNull()
  })
})
