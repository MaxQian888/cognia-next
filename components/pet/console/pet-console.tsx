// The /pet console: a full-page home for the pet with nurture, dex, achievements,
// and character-binding tabs. The nurture tab hatches the egg (utility LLM, with
// fallback) and hosts the responsive interaction layout. Structured like the
// sibling consoles (`EvalWorkspace`, `MemoryConsole`): a full-height flex column
// with a persistent identity header, a top segmented tab bar, and a scrolling
// content region — so it matches the rest of the app instead of a narrow card.

"use client"

import { useState, useSyncExternalStore, type ComponentType } from "react"
import { useTranslations } from "next-intl"
import { usePlatform } from "@/hooks/use-platform"
import { getPetWindowRole } from "@/lib/pet/window-role"
import { resolvePetAvailability } from "@/lib/pet/access/availability"
import {
  BookOpenIcon,
  HeartIcon,
  LibraryIcon,
  MenuIcon,
  MessageCircleIcon,
  PaletteIcon,
  PlugIcon,
  ScanLineIcon,
  ShoppingBagIcon,
  TrophyIcon,
  UsersIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
} from "@/components/ui/empty"
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import { cn } from "@/lib/utils"
import { usePet } from "@/hooks/pet/use-pet"
import { useSettingsStore } from "@/stores/settings"
import { hatchPet } from "@/lib/pet/runtime/init-pet"
import { renamePet } from "@/lib/pet/runtime/rename-pet"
import { emitPetEvent } from "@/lib/pet/events/pet-event-bus"
import { buildUtilityLlmClient } from "@/lib/ai/generation/utility-client"
import { useActiveLive2dModel } from "@/hooks/pet/use-active-live2d-model"
import { useActiveSpritePack } from "@/hooks/pet/use-active-sprite-pack"
import {
  PluginExtensionSlot,
  usePluginSlotHasExtensions,
} from "@/components/plugins/plugin-extension-slot"
import { DEFAULT_PET_SETTINGS } from "@/types/pet"
import type { PetAssetDiagnostic } from "@/types/pet"
import { PET_CONSOLE_TABS, type PetConsoleTab } from "@/lib/pet/console-tabs"
import { toPetAssetDiagnostics } from "@/lib/pet/live2d/compatibility-diagnostics"
import { getPetSkinRuntime } from "@/lib/pet/skin-runtime"
import { resolveEffectiveSkinSelection } from "../skins/resolve-effective-skin"
import { PetRenderer } from "../pet-renderer"
import { PetSkinStatus } from "../settings/pet-skin-status"
import { PetNameEditor } from "../pet-name-editor"
import { NurtureTab } from "./nurture-tab"
import { ChatTab } from "./chat-tab"
import { ShopTab } from "./shop-tab"
import { CustomizeTab } from "./customize-tab"
import { DexTab } from "./dex-tab"
import { JournalTab } from "./journal-tab"
import { AchievementsTab } from "./achievements-tab"
import { BindingTab } from "./binding-tab"
import { RadarPanel } from "./radar-panel"
import { CaptureSettingsPanel } from "@/components/capture/capture-settings-panel"

const TABS: readonly PetConsoleTab[] = PET_CONSOLE_TABS

const TAB_ICONS: Record<PetConsoleTab, ComponentType<{ className?: string }>> = {
  nurture: HeartIcon,
  chat: MessageCircleIcon,
  shop: ShoppingBagIcon,
  customize: PaletteIcon,
  binding: UsersIcon,
  insights: ScanLineIcon,
  journal: BookOpenIcon,
  dex: LibraryIcon,
  achievements: TrophyIcon,
  plugins: PlugIcon,
}

const NAV_GROUPS: readonly {
  id: "nurture" | "personalize" | "records" | "extensions"
  tabs: readonly PetConsoleTab[]
}[] = [
  { id: "nurture", tabs: ["nurture", "chat", "shop"] },
  { id: "personalize", tabs: ["customize", "binding"] },
  { id: "records", tabs: ["insights", "journal", "dex", "achievements"] },
  { id: "extensions", tabs: ["plugins"] },
]

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
  const { modelId, row: activeModel, coreReady } = useActiveLive2dModel(pet)
  const { row: activeSpritePack } = useActiveSpritePack(pet)
  const skinResolution = resolveEffectiveSkinSelection(
    pet.skinId,
    {
      coreReady,
      hasActiveModel: Boolean(modelId),
      modelReady: activeModel?.compatibility?.status !== "invalid",
      hasActiveSpritePack: Boolean(activeSpritePack),
    },
    { modelId, packId: activeSpritePack?.id }
  )
  const effectiveSkin = skinResolution.selection.skinId
  const selection = skinResolution.selection
  const runtime = getPetSkinRuntime()
  useSyncExternalStore(runtime.subscribe, runtime.snapshotRevision, runtime.snapshotRevision)
  const assetKey =
    pet.skinId === "live2d" && modelId
      ? `live2d:${modelId}`
      : pet.skinId === "sprite-v2" && activeSpritePack?.id
        ? `sprite-v2:${activeSpritePack.id}`
        : undefined
  const diagnostics: PetAssetDiagnostic[] = [
    ...skinResolution.diagnostics,
    ...(activeModel?.compatibility
      ? toPetAssetDiagnostics(activeModel.compatibility.diagnostics)
      : []),
  ]
  const runtimeDiagnostic = assetKey ? runtime.assetDiagnostic(assetKey) : undefined
  if (runtimeDiagnostic) diagnostics.push(runtimeDiagnostic)

  // The "Plugins" tab is host-owned and appears only while ≥1 plugin has
  // registered a `pet.console.tab` extension.
  const hasPluginTabs = usePluginSlotHasExtensions("pet.console.tab")
  const platform = usePlatform()
  // The STRUCTURAL question only, the way `PetMount` asks it for the main
  // desktop window. Whether the user has the pet switched off is deliberately
  // not asked: the widget and the overlay are what `enabled` turns off, while
  // the console is where the record of the pet lives and is worth reading
  // either way.
  const availability = resolvePetAvailability({
    enabled: true,
    role: getPetWindowRole(),
    platform,
  })
  const visibleTabs = hasPluginTabs ? TABS : TABS.filter((id) => id !== "plugins")

  // "Cannot run here" and "has not loaded yet" used to render the same
  // spinner. The surface contract lists /pet as a navigable route, and on the
  // Capacitor shell `PetMount` refuses to initialize the profile at all, so a
  // phone reaching this page waited at a spinner that could never resolve.
  if (!availability.available) {
    return (
      <div data-testid="pet-console-unavailable" className="p-6 text-muted-foreground">
        {t("console.unavailable.unsupportedHost")}
      </div>
    )
  }

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
          selection={selection}
          renderPriority="console"
          lowPower={pet.lowPower}
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
          <PetSkinStatus
            requestedSkinId={pet.skinId ?? "svg"}
            effectiveSkinId={effectiveSkin}
            diagnostics={diagnostics}
            onRetry={runtimeDiagnostic && assetKey ? () => runtime.retryAsset(assetKey) : undefined}
            onConfigure={pet.skinId !== "svg" ? () => setTab("customize") : undefined}
          />
        </div>
      </header>

      <div className="mt-3 flex items-center gap-2 border-y px-3 py-2 md:hidden">
        <Sheet>
          <SheetTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              className="min-w-0 flex-1 justify-start"
              data-testid="pet-console-mobile-nav-trigger"
              aria-label={t("console.openNavigation")}
            >
              <MenuIcon className="size-4" />
              <span className="truncate">{t(`console.tabs.${tab}`)}</span>
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="w-[min(20rem,88vw)] gap-0 p-0">
            <SheetHeader className="border-b">
              <SheetTitle>{t("console.navigation")}</SheetTitle>
              <SheetDescription>{t("console.navigationDescription")}</SheetDescription>
            </SheetHeader>
            <nav
              className="min-h-0 flex-1 overflow-y-auto p-3"
              aria-label={t("console.navigation")}
            >
              {NAV_GROUPS.map((group) => {
                const tabs = group.tabs.filter((id) => visibleTabs.includes(id))
                if (tabs.length === 0) return null
                return (
                  <div key={group.id} className="mb-5 flex flex-col gap-1 last:mb-0">
                    <p className="px-2 text-xs font-medium text-muted-foreground">
                      {t(`console.groups.${group.id}`)}
                    </p>
                    {tabs.map((id) => {
                      const Icon = TAB_ICONS[id]
                      return (
                        <SheetClose key={id} asChild>
                          <Button
                            type="button"
                            variant={tab === id ? "secondary" : "ghost"}
                            className="w-full justify-start"
                            aria-current={tab === id ? "page" : undefined}
                            data-mobile-tab={id}
                            onClick={() => setTab(id)}
                          >
                            <Icon className="size-4" />
                            <span className="truncate">{t(`console.tabs.${id}`)}</span>
                          </Button>
                        </SheetClose>
                      )
                    })}
                  </div>
                )
              })}
            </nav>
          </SheetContent>
        </Sheet>
      </div>

      <div className="grid min-h-0 flex-1 md:grid-cols-[13rem_minmax(0,1fr)]">
        <nav
          data-testid="pet-console-nav"
          className="hidden min-h-0 overflow-y-auto border-r p-3 md:block"
          role="tablist"
          aria-label={t("console.navigation")}
          aria-orientation="vertical"
        >
          {NAV_GROUPS.map((group) => {
            const tabs = group.tabs.filter((id) => visibleTabs.includes(id))
            if (tabs.length === 0) return null
            return (
              <div key={group.id} className="mb-5 flex flex-col gap-1 last:mb-0">
                <p className="px-2 text-xs font-medium text-muted-foreground">
                  {t(`console.groups.${group.id}`)}
                </p>
                {tabs.map((id) => {
                  const Icon = TAB_ICONS[id]
                  return (
                    <Button
                      key={id}
                      type="button"
                      size="sm"
                      variant={tab === id ? "secondary" : "ghost"}
                      role="tab"
                      aria-selected={tab === id}
                      data-tab={id}
                      onClick={() => setTab(id)}
                      className={cn("w-full justify-start", tab === id && "font-medium")}
                    >
                      <Icon className="size-4" />
                      <span className="truncate">{t(`console.tabs.${id}`)}</span>
                    </Button>
                  )
                })}
              </div>
            )
          })}
        </nav>

        <main className="@container/pet-pane min-h-0 min-w-0 overflow-auto p-4">
          {tab === "nurture" &&
            (profile.soul ? (
              <NurtureTab
                profile={profile}
                view={view}
                skinId={effectiveSkin}
                selection={selection}
                lowPower={pet.lowPower}
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
              <Empty data-testid="pet-hatch" className="py-8">
                <EmptyHeader>
                  <EmptyMedia>
                    <PetRenderer
                      bones={view.effectiveBones}
                      stage="egg"
                      state="idle"
                      size={120}
                      skinId={effectiveSkin}
                      selection={selection}
                      renderPriority="console"
                    />
                  </EmptyMedia>
                  <EmptyDescription>{t("console.hatchPrompt")}</EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                  <Button onClick={() => void hatch()}>{t("console.hatch")}</Button>
                </EmptyContent>
              </Empty>
            ))}
          {tab === "chat" && <ChatTab profile={profile} view={view} />}
          {tab === "shop" && <ShopTab />}
          {tab === "customize" && <CustomizeTab />}
          {tab === "insights" && (
            <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
              <RadarPanel />
              <CaptureSettingsPanel />
            </div>
          )}
          {tab === "journal" && <JournalTab />}
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
        </main>
      </div>
    </div>
  )
}
