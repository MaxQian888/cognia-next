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
import { useActiveLive2dModel } from "@/hooks/pet/use-active-live2d-model"
import {
  PluginExtensionSlot,
  usePluginSlotHasExtensions,
} from "@/components/plugins/plugin-extension-slot"
import { DEFAULT_PET_SETTINGS } from "@/types/pet"
import { PET_CONSOLE_TABS, type PetConsoleTab } from "@/lib/pet/console-tabs"
import { resolveEffectiveSkin } from "../skins/resolve-effective-skin"
import { PetRenderer } from "../pet-renderer"
import { PetNameEditor } from "../pet-name-editor"
import { NurtureTab } from "./nurture-tab"
import { ShopTab } from "./shop-tab"
import { CustomizeTab } from "./customize-tab"
import { DexTab } from "./dex-tab"
import { AchievementsTab } from "./achievements-tab"
import { BindingTab } from "./binding-tab"
import { RadarPanel } from "./radar-panel"
import { CaptureSettingsCard } from "@/components/capture/capture-settings-card"

const TABS: readonly PetConsoleTab[] = PET_CONSOLE_TABS

export interface PetConsoleProps {
  /** Initial tab (deep link `?tab=` / bridge navigation). Default "nurture". */
  initialTab?: PetConsoleTab
}

export function PetConsole({ initialTab }: PetConsoleProps = {}) {
  const t = useTranslations("pet")
  const appSettings = useSettingsStore((s) => s.settings)
  const { profile, view, feed, play, petStroke, talk, sleep, clean, treat } = usePet()
  const [tab, setTab] = useState<PetConsoleTab>(initialTab ?? "nurture")

  // Follow later deep links too: navigating /pet?tab=shop while the console is
  // already mounted only changes the prop, not the mounted state. Adjusted
  // during render (not in an effect) per the React "derive from prop change"
  // pattern.
  const [prevInitialTab, setPrevInitialTab] = useState(initialTab)
  if (initialTab !== prevInitialTab) {
    setPrevInitialTab(initialTab)
    if (initialTab) setTab(initialTab)
  }

  // Resolve the effective skin so the console previews match the floating
  // sprite (Live2D when picked + ready, otherwise SVG) — same resolution as
  // the popup's stat-card avatar.
  const pet = appSettings?.petSettings ?? DEFAULT_PET_SETTINGS
  const { modelId, coreReady } = useActiveLive2dModel(pet)
  const effectiveSkin = resolveEffectiveSkin(pet.skinId, {
    coreReady,
    hasActiveModel: Boolean(modelId),
  })

  // The "Plugins" tab is host-owned and appears only while ≥1 plugin has
  // registered a `pet.console.tab` extension.
  const hasPluginTabs = usePluginSlotHasExtensions("pet.console.tab")
  const visibleTabs = hasPluginTabs ? TABS : TABS.filter((id) => id !== "plugins")

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
        <PetRenderer
          bones={view.effectiveBones}
          stage={profile.stage}
          state="idle"
          size={48}
          skinId={effectiveSkin}
          flavor={profile.evolutionFlavor}
        />
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
        {visibleTabs.map((id) => (
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
              skinId={effectiveSkin}
              onFeed={feed}
              onPlay={play}
              onPet={petStroke}
              onTalk={talk}
              onSleep={sleep}
              onClean={clean}
              onTreat={treat}
              onOpenShop={() => setTab("shop")}
            />
          ) : (
            <div data-testid="pet-hatch" className="flex flex-col items-center gap-3 py-8">
              <PetRenderer
                bones={view.effectiveBones}
                stage="egg"
                state="idle"
                size={120}
                skinId={effectiveSkin}
              />
              <p className="text-sm text-muted-foreground">{t("console.hatchPrompt")}</p>
              <Button onClick={() => void hatch()}>{t("console.hatch")}</Button>
            </div>
          ))}
        {tab === "shop" && <ShopTab />}
        {tab === "customize" && <CustomizeTab />}
        {tab === "insights" && (
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
            <RadarPanel />
            <CaptureSettingsCard />
          </div>
        )}
        {tab === "dex" && <DexTab bones={view.bones} />}
        {tab === "achievements" && <AchievementsTab />}
        {tab === "binding" && <BindingTab />}
        {tab === "plugins" && (
          <PluginExtensionSlot
            point="pet.console.tab"
            className="mx-auto flex w-full max-w-3xl flex-col gap-4"
            context={{
              level: profile.level,
              stage: profile.stage,
              mood: view.mood,
              condition: view.condition,
            }}
          />
        )}
      </div>
    </div>
  )
}
