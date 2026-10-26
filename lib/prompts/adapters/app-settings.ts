/**
 * The app's default system prompt (`AppSettings.defaultSystemPrompt`) as a
 * Prompt Center resource (ADR-0236 §5.1).
 *
 * It is the last rung of the base selection (`selectBaseSystemPrompt`): a turn
 * starts from it only when the session, team member and character supply no
 * prompt. The settings store stays its writer, the same `save` the agent
 * runtime defaults tab uses.
 */

import { useSettingsStore } from "@/stores/settings"
import { resourceKey, type OwnerPromptAdapter } from "../resources"

export const DEFAULT_SYSTEM_PROMPT_KEY = resourceKey("app-setting", "defaultSystemPrompt")

export const appSettingPromptAdapter: OwnerPromptAdapter = {
  source: "app-setting",

  async list() {
    const value = useSettingsStore.getState().settings?.defaultSystemPrompt
    return [
      {
        key: DEFAULT_SYSTEM_PROMPT_KEY,
        source: "app-setting",
        kind: "runtime-baseline",
        operation: "legacy-replace",
        builtIn: false,
        modified: Boolean(value?.trim()),
        edit: "source",
        ownerSection: "agent-runtime",
      },
    ]
  },

  async read(key) {
    if (key !== DEFAULT_SYSTEM_PROMPT_KEY) return undefined
    return { key, text: useSettingsStore.getState().settings?.defaultSystemPrompt ?? "" }
  },

  async save(key, text) {
    if (key !== DEFAULT_SYSTEM_PROMPT_KEY) throw new Error(`not an app setting resource: ${key}`)
    const trimmed = text.trim()
    await useSettingsStore.getState().save({ defaultSystemPrompt: trimmed || undefined })
    return (await appSettingPromptAdapter.read(key, {}))!
  },
}
