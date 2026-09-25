"use client"

/**
 * The `pet.console.tab` extension surface: three daily quests with progress
 * and claim buttons, plus the remaining reward-budget footer. Renders from
 * the module-level quest store; all mutation flows through the store's host
 * effects (persist / reward / failure report), never directly through ctx.
 */

import { useSyncExternalStore } from "react"
import { usePluginTranslations } from "@cognia/plugin-sdk/api/i18n"
import { Button } from "@cognia/plugin-ui"
import manifestJson from "../plugin.json"
import { questDef } from "./quest-engine"
import {
  claimQuestReward,
  getQuestState,
  getQuestStoreVersion,
  getRemainingBudget,
  isClaimInFlight,
  subscribeQuestStore,
} from "./quest-store"

export function QuestsTab() {
  const t = usePluginTranslations(manifestJson.id)
  // Subscribed on the store's version, not its state: a claim starting or
  // settling changes no quest but does change what the buttons show.
  useSyncExternalStore(subscribeQuestStore, getQuestStoreVersion, getQuestStoreVersion)
  const state = getQuestState()
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
          const title = t(`quest.${quest.id}`)
          const claiming = isClaimInFlight(quest.id)
          return (
            <div
              key={quest.id}
              data-quest={quest.id}
              data-done={quest.done}
              className="flex items-center gap-3 rounded-lg border p-3"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{title}</div>
                <div className="text-xs text-muted-foreground">
                  {t("progress", {
                    progress: Math.min(quest.progress, def.count),
                    count: def.count,
                  })}
                  {" · "}
                  {t("reward", { xp: def.rewardXp, coins: def.rewardCoins })}
                </div>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-action={`claim-${quest.id}`}
                aria-label={quest.claimed ? undefined : t("claimAria", { quest: title })}
                aria-busy={claiming}
                disabled={!quest.done || quest.claimed || claiming}
                // The store reports a failed grant itself (localized toast via
                // ctx.ui) and keeps the quest claimable; the rejection is
                // settled here only so it is not left unhandled.
                onClick={() => {
                  claimQuestReward(quest.id).catch(() => undefined)
                }}
                className="min-h-9 shrink-0"
              >
                {quest.claimed ? t("claimed") : claiming ? t("claiming") : t("claim")}
              </Button>
            </div>
          )
        })}
      </div>

      <p data-testid="pet-daily-quests-budget" className="text-xs text-muted-foreground">
        {t("budgetLeft", { xp: budget.xp, coins: budget.coins })} {t("resetsDaily")}
      </p>
    </div>
  )
}
