/**
 * Pet Daily Quests — built-in reference plugin for the full pet integration
 * surface: ctx.pet (read + budget-capped rewards), the `pet.console.tab` UI
 * slot, and the goal lifecycle hooks.
 *
 * Wiring:
 *  - activate() hydrates the quest state from ctx.storage, subscribes
 *    ctx.pet.onEvent (interaction kinds advance quests), registers the
 *    QuestsTab into `pet.console.tab`, and returns `{ onGoalComplete }` so
 *    the goal quest advances too (hooks are registered by RETURNING them).
 *  - Claims grant rewards via ctx.pet.emitEvent("workflowRun", …) — the host
 *    clamps against the per-plugin daily budget; the tab shows the remainder.
 *  - Day rollover is a lazy date-check inside the quest store — no scheduler.
 */

import type { PluginContext, PluginDefinition } from "@cognia/plugin-sdk"
import type { PluginHooksAll } from "@cognia/plugin-sdk"
import type { QuestState } from "./quest-engine"
import { configureQuestStore, disposeQuestStore, handleQuestEvent } from "./quest-store"
import { I18N_MESSAGES } from "./i18n"
import { QuestsTab } from "./quests-tab"
import manifest from "../plugin.json"

const STORAGE_KEY = "quests"

const INTERACTION_KINDS = new Set([
  "fed",
  "played",
  "petted",
  "talked",
  "slept",
  "cleaned",
  "treated",
])

let disposeEvents: (() => void) | null = null
let disposeExtension: (() => void) | null = null

const hooks: PluginHooksAll = {
  onGoalComplete: () => handleQuestEvent("goalComplete"),
}

const definition: PluginDefinition = {
  // The module-side manifest overlays plugin.json via `builtinManifest()` —
  // this is what carries the declarative i18n bundle into the host.
  manifest: { ...(manifest as object), i18n: { locales: I18N_MESSAGES } } as never,
  activate: async (ctx: PluginContext) => {
    const stored = (await ctx.storage.get<QuestState>(STORAGE_KEY)) ?? undefined
    configureQuestStore(stored, {
      persist: (state) => ctx.storage.set(STORAGE_KEY, state),
      reward: async (reward) =>
        (await ctx.pet.emitEvent("workflowRun", {
          xp: reward.xp,
          coins: reward.coins,
          meta: { questId: "daily" },
        })) ?? { grantedXp: 0, grantedCoins: 0 },
      getRemainingBudget: () => ctx.pet.getRemainingBudget(),
    })

    // Direct care interactions advance quests regardless of who performed
    // them (user / another plugin / a workflow) — the pet only gets fed once.
    disposeEvents =
      ctx.pet.onEvent((event) => {
        if (INTERACTION_KINDS.has(event.kind)) handleQuestEvent(event.kind)
      }) ?? null

    disposeExtension = ctx.extensions.registerExtension("pet.console.tab", QuestsTab)

    ctx.logger?.info("pet-daily-quests activated")
    return hooks
  },
  deactivate: async (ctx?: PluginContext) => {
    disposeEvents?.()
    disposeEvents = null
    disposeExtension?.()
    disposeExtension = null
    disposeQuestStore()
    ctx?.logger?.info("pet-daily-quests deactivated")
  },
}

export default definition
