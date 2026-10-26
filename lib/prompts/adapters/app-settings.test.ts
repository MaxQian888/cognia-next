/** @jest-environment jsdom */

import { createDbTestFixture } from "@/lib/db/test-fixture"
import { useSettingsStore } from "@/stores/settings"
import { appSettingPromptAdapter as adapter, DEFAULT_SYSTEM_PROMPT_KEY } from "./app-settings"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  await useSettingsStore.getState().retryLoad()
})
afterAll(dbFixture.dispose)

describe("appSettingPromptAdapter", () => {
  it("lists the default system prompt as the runtime baseline", async () => {
    expect(await adapter.list({})).toEqual([
      {
        key: DEFAULT_SYSTEM_PROMPT_KEY,
        source: "app-setting",
        kind: "runtime-baseline",
        operation: "legacy-replace",
        builtIn: false,
        modified: false,
        edit: "source",
        ownerSection: "agent-runtime",
      },
    ])
  })

  it("saves through the settings store and clears on blank text", async () => {
    expect(await adapter.save!(DEFAULT_SYSTEM_PROMPT_KEY, " Be kind. ", undefined, {})).toEqual({
      key: DEFAULT_SYSTEM_PROMPT_KEY,
      text: "Be kind.",
    })
    expect(useSettingsStore.getState().settings?.defaultSystemPrompt).toBe("Be kind.")
    expect((await adapter.list({}))[0].modified).toBe(true)
    await adapter.save!(DEFAULT_SYSTEM_PROMPT_KEY, "  ", undefined, {})
    expect(useSettingsStore.getState().settings?.defaultSystemPrompt).toBeUndefined()
  })

  it("rejects other keys", async () => {
    expect(await adapter.read("app-setting:other", {})).toBeUndefined()
    await expect(adapter.save!("app-setting:other", "x", undefined, {})).rejects.toThrow(
      "not an app setting"
    )
  })
})
