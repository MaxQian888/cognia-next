"use client"

// Master/detail shell for the Appearance settings section — a grouped nav on
// the left, one panel on the right. Mirrors `ocr-section.tsx` /
// `provider-settings.tsx`, the house pattern for sections with more entries
// than a tab strip can carry: below `md` the nav collapses into a left Sheet.
// `appearance` is a member of the shell's `FILL_HEIGHT_SECTIONS`, so this
// component owns its own scroll and fills the frame.
//
// The detail header mounts the section's *only* `AppearancePreview`. Panels
// don't ship previews of their own; the custom-theme editor drives this one
// through `preview-draft-context`, which is why a draft you haven't saved
// still shows up here.
//
// "Reset" is intentionally NOT rendered here: the settings shell already
// mounts a shared `SectionResetButton` for every section (see
// `settings-shell.tsx`), which resets all appearance-owned keys to defaults
// while preserving the user's uploaded wallpaper library (see
// `lib/settings/section-keys.ts` `RESET_EXCLUDE`). Whole-config export/import
// (the `AppearanceConfigToolbar`) is a separate, additive affordance.

import { useState } from "react"
import { useTranslations } from "next-intl"
import { useRouter, useSearchParams } from "next/navigation"
import { ChevronDownIcon, MenuIcon, PaletteIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Label } from "@/components/ui/label"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import {
  PluginExtensionSlot,
  usePluginSlotHasExtensions,
} from "@/components/plugins/plugin-extension-slot"
import { PanelTransition } from "@/components/settings/common/panel-transition"
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
import { APPEARANCE_NAV_GROUPS, resolveAppearancePanel, type AppearancePanelId } from "./nav-config"
import {
  AppearancePreviewDraftProvider,
  createPreviewDraftStore,
  usePreviewDraft,
} from "./preview-draft-context"
import { PersonalizationCard } from "../personalization-card"

// Unchanged from the tabbed layout, so pre-merge deep links keep resolving
// (`nav-config.ts` maps the retired values).
const APPEARANCE_TAB_PARAM = "appearanceTab"

function renderPanel(panel: AppearancePanelId) {
  switch (panel) {
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
 * keystroke in the custom-theme editor re-renders this and nothing else.
 * Collapsible because it now sits above every panel rather than only in the
 * `xl` rail, and an always-open preview would crowd a short viewport.
 */
function AppearancePreviewRail() {
  const t = useTranslations("settings.appearance.preview")
  const draft = usePreviewDraft()
  return (
    <Collapsible defaultOpen data-testid="appearance-preview-rail">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-muted-foreground">{t("title")}</p>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm" className="h-6 px-2" aria-label={t("title")}>
            <ChevronDownIcon className="size-4 transition-transform data-[state=open]:rotate-180" />
          </Button>
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent className="pt-2">
        <AppearancePreview colors={draft?.colors} isDark={draft?.isDark} />
        <p className="mt-1 text-[11px] text-muted-foreground">{t("hint")}</p>
      </CollapsibleContent>
    </Collapsible>
  )
}

export function AppearanceSection() {
  const t = useTranslations("settings.appearance")
  const router = useRouter()
  const searchParams = useSearchParams()
  const [mobileSheetOpen, setMobileSheetOpen] = useState(false)
  // Lazy init: one store per mounted section, so tests can't leak into
  // each other the way a module singleton would.
  const [previewStore] = useState(createPreviewDraftStore)

  const pluginsAvailable = usePluginSlotHasExtensions("settings.appearance")
  const activePanel = resolveAppearancePanel(
    searchParams.get(APPEARANCE_TAB_PARAM),
    pluginsAvailable
  )

  const onSelect = (id: AppearancePanelId) => {
    const next = new URLSearchParams(searchParams.toString())
    next.set(APPEARANCE_TAB_PARAM, id)
    router.replace(`?${next.toString()}`, { scroll: false })
    setMobileSheetOpen(false)
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

        <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 md:grid-cols-[320px_1fr]">
          {/* Desktop nav */}
          <div className="hidden min-h-0 md:flex md:flex-col md:overflow-hidden md:rounded-lg md:border">
            {navNode}
          </div>

          {/* Below md the nav lives in a Sheet; the bar shows where you are. */}
          <div className="flex items-center gap-2 md:hidden">
            <Sheet open={mobileSheetOpen} onOpenChange={setMobileSheetOpen}>
              <SheetTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0 gap-1.5"
                  data-testid="appearance-mobile-nav-trigger"
                >
                  <MenuIcon className="size-4" />
                  {t("nav.mobileTrigger")}
                </Button>
              </SheetTrigger>
              <SheetContent side="left" className="w-[300px] p-0">
                <SheetHeader className="px-3 pt-3">
                  <SheetTitle className="text-sm">{t("nav.title")}</SheetTitle>
                </SheetHeader>
                {navNode}
              </SheetContent>
            </Sheet>
            <p className="min-w-0 flex-1 truncate text-sm font-medium">
              {t(`nav.items.${activePanel}.label`)}
            </p>
          </div>

          {/* Detail: pinned preview header + the scrolling panel body. A
              non-scrolling flex header rather than `position: sticky` — same
              result, no interaction with the overflow/min-h-0 chain. */}
          <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border">
            <div className="shrink-0 border-b p-3">
              <AppearancePreviewRail />
            </div>
            {/* `@container/appearance-pane`: panels are now ~700px wide
                regardless of viewport, so any multi-column layout inside them
                must size off this box, not the window. Same idea as
                `hooks-section.tsx`'s `@container/hooks-pane`. */}
            <div
              className="min-h-0 flex-1 overflow-y-auto p-3 @container/appearance-pane"
              data-testid="appearance-panel-body"
            >
              <PanelTransition activeKey={activePanel}>{renderPanel(activePanel)}</PanelTransition>
            </div>
          </div>
        </div>
      </div>
    </AppearancePreviewDraftProvider>
  )
}
