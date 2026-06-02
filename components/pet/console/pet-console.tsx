// The /pet console: a full-page home for the pet with nurture, dex, achievements,
// and character-binding tabs. The nurture tab hatches the egg (utility LLM, with
// fallback) and hosts the interaction panel.

"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { usePet } from "@/hooks/pet/use-pet"
import { useSettingsStore } from "@/stores/settings"
import { hatchPet } from "@/lib/pet/runtime/init-pet"
import { emitPetEvent } from "@/lib/pet/events/pet-event-bus"
import { buildUtilityLlmClient } from "@/lib/ai/generation/utility-client"
import { PetInteractionPanel } from "../pet-interaction-panel"
import { PetRenderer } from "../pet-renderer"
import { DexTab } from "./dex-tab"
import { AchievementsTab } from "./achievements-tab"
import { BindingTab } from "./binding-tab"

type ConsoleTab = "nurture" | "dex" | "achievements" | "binding"
const TABS: ConsoleTab[] = ["nurture", "dex", "achievements", "binding"]

export function PetConsole() {
  const t = useTranslations("pet")
  const appSettings = useSettingsStore((s) => s.settings)
  const { profile, view, feed, play, petStroke, talk } = usePet()
  const [tab, setTab] = useState<ConsoleTab>("nurture")

  if (!profile || !view) {
    return (
      <div data-testid="pet-console-loading" className="p-6 text-muted-foreground">
        {t("console.loading")}
      </div>
    )
  }

  const hatch = async () => {
    const client = buildUtilityLlmClient({ session: null, appSettings, featureId: "pet-soul" })
    await hatchPet(client)
    emitPetEvent({ source: "system", kind: "hatched" })
  }

  return (
    <div
      data-testid="pet-console"
      className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4 sm:p-6"
    >
      <header className="flex items-center gap-4">
        <PetRenderer bones={view.effectiveBones} stage={profile.stage} state="idle" size={64} />
        <div>
          <h1 className="text-xl font-semibold">{profile.soul?.name ?? t("console.title")}</h1>
          <p className="text-sm text-muted-foreground">{t("console.subtitle")}</p>
        </div>
      </header>

      <nav className="flex gap-1 rounded-lg border p-1" role="tablist">
        {TABS.map((id) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            data-tab={id}
            onClick={() => setTab(id)}
            className={cn(
              "flex-1 rounded-md px-3 py-1.5 text-sm",
              tab === id ? "bg-primary text-primary-foreground" : "hover:bg-muted"
            )}
          >
            {t(`console.tabs.${id}`)}
          </button>
        ))}
      </nav>

      <section>
        {tab === "nurture" &&
          (profile.soul ? (
            <PetInteractionPanel
              profile={profile}
              view={view}
              onFeed={feed}
              onPlay={play}
              onPet={petStroke}
              onTalk={talk}
              className="w-full max-w-sm"
            />
          ) : (
            <div data-testid="pet-hatch" className="flex flex-col items-center gap-3 py-8">
              <PetRenderer bones={view.effectiveBones} stage="egg" state="idle" size={120} />
              <p className="text-sm text-muted-foreground">{t("console.hatchPrompt")}</p>
              <Button onClick={() => void hatch()}>{t("console.hatch")}</Button>
            </div>
          ))}
        {tab === "dex" && <DexTab bones={view.bones} />}
        {tab === "achievements" && <AchievementsTab />}
        {tab === "binding" && <BindingTab />}
      </section>
    </div>
  )
}
