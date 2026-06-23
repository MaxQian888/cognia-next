// The /pet console: a full-page home for the pet with nurture, dex, achievements,
// and character-binding tabs. The nurture tab hatches the egg (utility LLM, with
// fallback) and hosts the responsive interaction layout. Structured like the
// sibling consoles (`EvalWorkspace`, `MemoryConsole`): a full-height flex column
// with a persistent identity header, a top segmented tab bar, and a scrolling
// content region — so it matches the rest of the app instead of a narrow card.

"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { usePet } from "@/hooks/pet/use-pet"
import { useSettingsStore } from "@/stores/settings"
import { hatchPet } from "@/lib/pet/runtime/init-pet"
import { renamePet } from "@/lib/pet/runtime/rename-pet"
import { emitPetEvent } from "@/lib/pet/events/pet-event-bus"
import { buildUtilityLlmClient } from "@/lib/ai/generation/utility-client"
import { PetRenderer } from "../pet-renderer"
import { PetNameEditor } from "../pet-name-editor"
import { NurtureTab } from "./nurture-tab"
import { CustomizeTab } from "./customize-tab"
import { DexTab } from "./dex-tab"
import { AchievementsTab } from "./achievements-tab"
import { BindingTab } from "./binding-tab"

type ConsoleTab = "nurture" | "customize" | "dex" | "achievements" | "binding"
const TABS: ConsoleTab[] = ["nurture", "customize", "dex", "achievements", "binding"]

export function PetConsole() {
  const t = useTranslations("pet")
  const appSettings = useSettingsStore((s) => s.settings)
  const { profile, view, feed, play, petStroke, talk, sleep, clean, treat } = usePet()
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
    <div data-testid="pet-console" className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-3 px-4 pt-4">
        <PetRenderer bones={view.effectiveBones} stage={profile.stage} state="idle" size={48} />
        <div className="min-w-0">
          {profile.soul ? (
            <PetNameEditor
              name={profile.soul.name}
              onRename={(name) => void renamePet(name)}
              nameClassName="text-xl"
            />
          ) : (
            <h1 className="text-xl font-semibold">{t("console.title")}</h1>
          )}
          <p className="truncate text-sm text-muted-foreground">{t("console.subtitle")}</p>
        </div>
      </header>

      <nav
        className="mt-3 flex items-center gap-1 border-b bg-background/80 px-2 py-2 backdrop-blur"
        role="tablist"
      >
        {TABS.map((id) => (
          <Button
            key={id}
            size="sm"
            variant={tab === id ? "secondary" : "ghost"}
            role="tab"
            aria-selected={tab === id}
            data-tab={id}
            onClick={() => setTab(id)}
            className={cn(tab === id && "font-medium")}
          >
            {t(`console.tabs.${id}`)}
          </Button>
        ))}
      </nav>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        {tab === "nurture" &&
          (profile.soul ? (
            <NurtureTab
              profile={profile}
              view={view}
              onFeed={feed}
              onPlay={play}
              onPet={petStroke}
              onTalk={talk}
              onSleep={sleep}
              onClean={clean}
              onTreat={treat}
            />
          ) : (
            <div data-testid="pet-hatch" className="flex flex-col items-center gap-3 py-8">
              <PetRenderer bones={view.effectiveBones} stage="egg" state="idle" size={120} />
              <p className="text-sm text-muted-foreground">{t("console.hatchPrompt")}</p>
              <Button onClick={() => void hatch()}>{t("console.hatch")}</Button>
            </div>
          ))}
        {tab === "customize" && <CustomizeTab />}
        {tab === "dex" && <DexTab bones={view.bones} />}
        {tab === "achievements" && <AchievementsTab />}
        {tab === "binding" && <BindingTab />}
      </div>
    </div>
  )
}
