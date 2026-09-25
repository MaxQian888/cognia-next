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
 *  - Claims grant rewards via ctx.pet.emitEvent — the host clamps against the
 *    per-plugin daily budget; the tab shows the remainder. A failed grant is
 *    reported with a localized toast and leaves the quest claimable.
 *  - Day rollover is a lazy date-check inside the quest store — no scheduler.
 *
 * The desktop pet exists only in the Tauri shell, so the manifest blocks the
 * browser, mobile and headless profiles rather than loading a quest board for
 * a pet that is not there.
 */

import { definePlugin, definePluginManifest, type PluginHooksAll } from "@cognia/plugin-sdk"
import manifestJson from "../plugin.json"
import type { QuestState } from "./quest-engine"
import { configureQuestStore, disposeQuestStore, handleQuestEvent } from "./quest-store"
import { QuestsTab } from "./quests-tab"

/** plugin.json verbatim — including the `i18n.locales` bundle the tab reads. */
export const manifest = definePluginManifest(manifestJson)

const STORAGE_KEY = "quests"

/**
 * The pet event kind a claimed reward is emitted as. `workflowRun` is the only
 * non-nurture kind `ctx.pet.emitEvent` accepts today, and it is not neutral:
 * the host also counts it as a workflow run (achievements, stat growth, the
 * proactive "a workflow just ran" line). A dedicated neutral reward kind needs
 * a host change to the pet event vocabulary; until it lands this constant is
 * the one place to switch.
 */
export const REWARD_EVENT_KIND = "workflowRun"

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

export default definePlugin({
  manifest,
  activate: async (ctx) => {
    configureQuestStore(await ctx.storage.get<QuestState>(STORAGE_KEY), {
      persist: (state) => ctx.storage.set(STORAGE_KEY, state),
      reward: (reward) =>
        ctx.pet.emitEvent(REWARD_EVENT_KIND, {
          xp: reward.xp,
          coins: reward.coins,
          meta: { questId: "daily" },
        }),
      getRemainingBudget: () => ctx.pet.getRemainingBudget(),
      reportClaimFailure: (questId, error) => {
        ctx.logger.warn(`Claiming the "${questId}" quest reward failed`, error)
        ctx.ui.showToast(ctx.i18n.t("claimFailed"), "error")
      },
    })

    // Direct care interactions advance quests regardless of who performed
    // them (user / another plugin / a workflow) — the pet only gets fed once.
    disposeEvents = ctx.pet.onEvent((event) => {
      if (INTERACTION_KINDS.has(event.kind)) handleQuestEvent(event.kind)
    })

    disposeExtension = ctx.extensions.registerExtension("pet.console.tab", QuestsTab)

    return hooks
  },
  deactivate: () => {
    disposeEvents?.()
    disposeEvents = null
    disposeExtension?.()
    disposeExtension = null
    disposeQuestStore()
  },
})
