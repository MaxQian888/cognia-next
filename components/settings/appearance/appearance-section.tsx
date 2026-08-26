"use client"

// Master/detail shell for the Appearance settings section — a grouped nav on
// the left, one panel on the right. The nav/detail split itself belongs to
// `SettingsMasterDetail`, which tiers the rail (full → compact → icon →
// drawer) off *this pane's* width. The `md:grid-cols-[320px_1fr]` this file
// used to carry measured the viewport, which this pane never gets: it is the
// window minus the app rail minus the settings sidebar, so the two-column
// layout locked in at 768px of window while the pane was still ~440px wide and
// the detail column was down to 171px.
// `appearance` is a member of the shell's `FILL_HEIGHT_SECTIONS`, so this
// component owns its own scroll and fills the frame.
//
// The detail header names the panel you are in (icon + label + description,
// read from the same `nav.items.*` keys the nav renders) and mounts the
// section's *only* `AppearancePreview`. Panels don't ship previews of their
// own; the custom-theme editor drives this one through `preview-draft-context`,
// which is why a draft you haven't saved still shows up here.
//
// "Reset" is intentionally NOT rendered here: the settings shell already
// mounts a shared `SectionResetButton` for every section (see
// `settings-shell.tsx`), which resets all appearance-owned keys to defaults
// while preserving the user's uploaded wallpaper library (see
// `lib/settings/section-keys.ts` `RESET_EXCLUDE`). Whole-config export/import
// (the `AppearanceConfigToolbar`) is a separate, additive affordance.

import { useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { useRouter, useSearchParams } from "next/navigation"
import { ChevronDownIcon, PaletteIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Label } from "@/components/ui/label"
import { useElementWidth } from "@/hooks/use-element-width"
import {
  PluginExtensionSlot,
  usePluginSlotHasExtensions,
} from "@/components/plugins/plugin-extension-slot"
import { PanelTransition } from "@/components/settings/common/panel-transition"
import { SettingsMasterDetail } from "@/components/settings/common/settings-master-detail"
import { StylePanel } from "./panels/style-panel"
import { ThemeTab } from "./tabs/theme-tab"
import { WallpaperTab } from "./tabs/wallpaper-tab"
import { CustomThemeTab } from "./tabs/custom-theme-tab"
import { AdvancedTab } from "./tabs/advanced-tab"
import { A11yTab } from "./tabs/a11y-tab"
import { ComponentsTab } from "./tabs/components-tab"
import { CursorTab } from "./tabs/cursor-tab"
import { AutoModeTab } from "./tabs/auto-mode-tab"
import { AppearanceLibraryPanel } from "./panels/library-panel"
import { AppearanceTypographyPanel } from "./panels/typography-panel"
import { AppearanceNav } from "./components/appearance-nav"
import { AppearancePreview } from "./components/appearance-preview"
import { AppearanceConfigToolbar } from "./components/appearance-config-toolbar"
import {
  APPEARANCE_NAV_GROUPS,
  APPEARANCE_PANEL_ICONS,
  resolveAppearancePanel,
  type AppearancePanelId,
} from "./nav-config"
import {
  AppearancePreviewDraftProvider,
  createPreviewDraftStore,
  usePreviewDraft,
} from "./preview-draft-context"
import { PersonalizationCard } from "../personalization-card"
import { cn } from "@/lib/utils"

// Unchanged from the tabbed layout, so pre-merge deep links keep resolving
// (`nav-config.ts` maps the retired values).
const APPEARANCE_TAB_PARAM = "appearanceTab"

function renderPanel(panel: AppearancePanelId) {
  switch (panel) {
    case "style":
      return <StylePanel />
    case "theme":
      return <ThemeTab />
    case "auto":
      return <AutoModeTab />
    case "custom":
      return <CustomThemeTab />
    case "library":
      return <AppearanceLibraryPanel />
    case "wallpaper":
      return <WallpaperTab />
    case "typography":
      return <AppearanceTypographyPanel />
    case "components":
      return <ComponentsTab />
    case "cursor":
      return <CursorTab />
    case "personalization":
      return <PersonalizationCard />
    case "a11y":
      return <A11yTab />
    case "advanced":
      return <AdvancedTab />
    case "plugins":
      return <PluginExtensionSlot point="settings.appearance" className="space-y-2" />
  }
}

/**
 * The section's single preview. Subscribes to the draft on its own so a
 * keystroke in the custom-theme editor re-renders this and nothing else — the
 * panel identity beside it is deliberately outside this component for the same
 * reason.
 */
function AppearancePreviewBody() {
  const t = useTranslations("settings.appearance.preview")
  const draft = usePreviewDraft()
  return (
    <>
      <AppearancePreview colors={draft?.colors} isDark={draft?.isDark} />
      <p className="mt-1 text-[11px] text-muted-foreground">{t("hint")}</p>
    </>
  )
}

/**
 * The detail pane's header: which panel you are in, and the live preview.
 *
 * The two belong in one block rather than stacked. Before, the pane opened with
 * a bare "Live preview" strip and the panel itself carried no title, so on
 * desktop the only thing naming the current panel was the highlight in the nav.
 * The preview stays collapsible — it is the tallest thing in the header and
 * means little on, say, the Custom CSS panel.
 *
 * It also starts collapsed once the detail column is narrow. In a 400px column
 * the preview is a ~300px-tall card sitting between you and the controls you
 * opened the panel to change, and it is the one thing here that degrades
 * gracefully by not being shown. An explicit toggle still overrides the
 * default in either direction, for the rest of the panel's life.
 */
const PREVIEW_MIN_DETAIL_WIDTH = 520

function AppearanceDetailHeader({ panel }: { panel: AppearancePanelId }) {
  const t = useTranslations("settings.appearance")
  const tPreview = useTranslations("settings.appearance.preview")
  const headerRef = useRef<HTMLDivElement>(null)
  const width = useElementWidth(headerRef)
  const [previewChoice, setPreviewChoice] = useState<boolean | null>(null)
  // Width 0 is `useElementWidth`'s "not measured yet"; defaulting it to open
  // keeps the desktop case from painting a collapsed preview for one frame.
  const previewOpen = previewChoice ?? (width === 0 || width >= PREVIEW_MIN_DETAIL_WIDTH)
  const Icon = APPEARANCE_PANEL_ICONS[panel]
  return (
    <Collapsible
      ref={headerRef}
      open={previewOpen}
      onOpenChange={setPreviewChoice}
      data-testid="appearance-preview-rail"
    >
      <div className="flex items-start gap-2">
        <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium" data-testid="appearance-panel-title">
            {t(`nav.items.${panel}.label`)}
          </p>
          <p className="truncate text-[11px] text-muted-foreground">
            {t(`nav.items.${panel}.description`)}
          </p>
        </div>
        <CollapsibleTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 shrink-0 gap-1 px-2 text-xs text-muted-foreground"
            data-testid="appearance-preview-toggle"
          >
            {tPreview("title")}
            <ChevronDownIcon
              className={cn("size-3.5 transition-transform", previewOpen && "rotate-180")}
            />
          </Button>
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent className="pt-2">
        <AppearancePreviewBody />
      </CollapsibleContent>
    </Collapsible>
  )
}

export function AppearanceSection() {
  const t = useTranslations("settings.appearance")
  const router = useRouter()
  const searchParams = useSearchParams()
  // Lazy init: one store per mounted section, so tests can't leak into
  // each other the way a module singleton would.
  const [previewStore] = useState(createPreviewDraftStore)

  const pluginsAvailable = usePluginSlotHasExtensions("settings.appearance")
  const activePanel = resolveAppearancePanel(
    searchParams.get(APPEARANCE_TAB_PARAM),
    pluginsAvailable
  )

  // The scroll container outlives the panel it holds, so switching panels used
  // to keep the previous panel's offset — leaving you halfway down a panel you
  // had never scrolled. Assigning `scrollTop` rather than calling `scrollTo`
  // keeps this working under jsdom, which does not implement the method.
  const bodyRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0
  }, [activePanel])

  const onSelect = (id: AppearancePanelId) => {
    const next = new URLSearchParams(searchParams.toString())
    next.set(APPEARANCE_TAB_PARAM, id)
    router.replace(`?${next.toString()}`, { scroll: false })
  }

  const navNode = (
    <AppearanceNav
      groups={APPEARANCE_NAV_GROUPS}
      activeId={activePanel}
      onSelect={onSelect}
      hiddenIds={pluginsAvailable ? [] : ["plugins"]}
    />
  )

  return (
    <AppearancePreviewDraftProvider store={previewStore}>
      <div className="flex h-full min-h-0 flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <Label className="flex items-center gap-2">
              <PaletteIcon className="size-4" />
              {t("title")}
            </Label>
            <p className="text-xs text-muted-foreground">{t("description")}</p>
          </div>
          <AppearanceConfigToolbar />
        </div>

        <SettingsMasterDetail
          nav={() => navNode}
          navTitle={t("nav.title")}
          mobileTriggerLabel={t("nav.mobileTrigger")}
          activeKey={activePanel}
          activeLabel={t(`nav.items.${activePanel}.label`)}
          navWidth={320}
          triggerTestId="appearance-mobile-nav-trigger"
        >
          {/* Detail: pinned preview header + the scrolling panel body. A
              non-scrolling flex header rather than `position: sticky` — same
              result, no interaction with the overflow/min-h-0 chain. */}
          <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border">
            <div className="shrink-0 border-b p-3">
              <AppearanceDetailHeader panel={activePanel} />
            </div>
            {/* `@container/appearance-pane`: panels are now ~700px wide
                regardless of viewport, so any multi-column layout inside them
                must size off this box, not the window. Same idea as
                `hooks-section.tsx`'s `@container/hooks-pane`. */}
            <div
              ref={bodyRef}
              className="min-h-0 flex-1 overflow-y-auto p-3 @container/appearance-pane"
              data-testid="appearance-panel-body"
            >
              <PanelTransition activeKey={activePanel}>{renderPanel(activePanel)}</PanelTransition>
            </div>
          </div>
        </SettingsMasterDetail>
      </div>
    </AppearancePreviewDraftProvider>
  )
}
