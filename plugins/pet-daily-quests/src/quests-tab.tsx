"use client"

/**
 * The `pet.console.tab` extension surface: three daily quests with progress
 * and claim buttons, plus the remaining reward-budget footer. Renders from
 * the module-level quest store; all mutation flows through the store's host
 * effects (persist / reward), never directly through ctx.
 */

import { useSyncExternalStore } from "react"
import { questDef } from "./quest-engine"
import {
  claimQuestReward,
  getQuestState,
  getRemainingBudget,
  subscribeQuestStore,
} from "./quest-store"
import { usePluginT } from "./use-plugin-t"

export function QuestsTab() {
  const t = usePluginT()
  const state = useSyncExternalStore(subscribeQuestStore, getQuestState, () => null)
  const budget = getRemainingBudget()

  if (!state) {
    return (
      <div data-testid="pet-daily-quests-empty" className="text-sm text-muted-foreground">
        {t("tab.empty")}
      </div>
    )
  }

  return (
    <div data-testid="pet-daily-quests-tab" className="flex flex-col gap-3">
      <div>
        <h3 className="text-sm font-medium">{t("tab.title")}</h3>
        <p className="text-xs text-muted-foreground">{t("tab.subtitle")}</p>
      </div>

      <div className="flex flex-col gap-2">
        {state.quests.map((quest) => {
          const def = questDef(quest.id)
          if (!def) return null
          return (
            <div
              key={quest.id}
              data-quest={quest.id}
              data-done={quest.done}
              className="flex items-center gap-3 rounded-lg border p-3"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{t(`quest.${quest.id}`)}</div>
                <div className="text-xs text-muted-foreground">
                  {t("progress", {
                    progress: String(Math.min(quest.progress, def.count)),
                    count: String(def.count),
                  })}
                  {" · "}
                  {t("reward", { xp: String(def.rewardXp), coins: String(def.rewardCoins) })}
                </div>
              </div>
              <button
                type="button"
                data-action={`claim-${quest.id}`}
                disabled={!quest.done || quest.claimed}
                // Swallow-and-log rather than `void`: `claimQuestReward`
                // rejects when the pet rate limiter trips or `pet:interact`
                // is denied, and an unhandled rejection left the user with no
                // signal at all. The quest stays claimable (the store only
                // marks it claimed after a successful grant).
                onClick={() => {
                  claimQuestReward(quest.id).catch((error: unknown) => {
                    console.warn("[pet-daily-quests] claim failed", error)
                  })
                }}
                className="shrink-0 rounded-md border px-2 py-1 text-xs font-medium disabled:opacity-50"
              >
                {quest.claimed ? t("claimed") : t("claim")}
              </button>
            </div>
          )
        })}
      </div>

      <p data-testid="pet-daily-quests-budget" className="text-xs text-muted-foreground">
        {t("budgetLeft", { xp: String(budget.xp), coins: String(budget.coins) })} {t("resetsDaily")}
      </p>
    </div>
  )
}
