"use client"

// Tabbed shell for the Appearance settings section. Mirrors the
// `data-section.tsx` pattern (URL-driven active tab). The tab strip wraps to
// multiple rows on narrow screens so every tab stays visible without a
// horizontal scroll the user might miss; each trigger carries an icon so the
// wrapped strip stays scannable.
//
// Layout: on `xl` the tabs share a two-column grid with a sticky live-preview
// rail; below `xl` the preview collapses into a disclosure above the tabs.
//
// "Reset" is intentionally NOT rendered here: the settings shell already
// mounts a shared `SectionResetButton` for every section (see
// `settings-shell.tsx`), which resets all appearance-owned keys to defaults
// while preserving the user's uploaded wallpaper library (see
// `lib/settings/section-keys.ts` `RESET_EXCLUDE`). Whole-config export/import
// (the `AppearanceConfigToolbar`) is a separate, additive affordance.

import type { ComponentType } from "react"
import { useTranslations } from "next-intl"
import { useRouter, useSearchParams } from "next/navigation"
import {
  AccessibilityIcon,
  BlocksIcon,
  ChevronDownIcon,
  DownloadIcon,
  ImageIcon,
  LayoutGridIcon,
  PackageIcon,
  PaintbrushIcon,
  PaletteIcon,
  SunMoonIcon,
  TypeIcon,
  WrenchIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Label } from "@/components/ui/label"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ThemeTab } from "./tabs/theme-tab"
import { ThemePackTab } from "./tabs/theme-pack-tab"
import { TypographyTab } from "./tabs/typography-tab"
import { LayoutTab } from "./tabs/layout-tab"
import { WallpaperTab } from "./tabs/wallpaper-tab"
import { CustomThemeTab } from "./tabs/custom-theme-tab"
import { VscodeImportTab } from "./tabs/vscode-import-tab"
import { AdvancedTab } from "./tabs/advanced-tab"
import { A11yTab } from "./tabs/a11y-tab"
import { ComponentsTab } from "./tabs/components-tab"
import { AutoModeTab } from "./tabs/auto-mode-tab"
import { AppearancePreview } from "./components/appearance-preview"
import { AppearanceConfigToolbar } from "./components/appearance-config-toolbar"
import { PluginExtensionSlot } from "@/components/plugins/plugin-extension-slot"
import { PersonalizationCard } from "../personalization-card"

const APPEARANCE_TAB_PARAM = "appearanceTab"

export type AppearanceTabId =
  | "theme"
  | "auto"
  | "themePack"
  | "wallpaper"
  | "custom"
  | "import"
  | "typography"
  | "layout"
  | "components"
  | "a11y"
  | "advanced"

const TAB_IDS: AppearanceTabId[] = [
  "theme",
  "auto",
  "themePack",
  "wallpaper",
  "custom",
  "import",
  "typography",
  "layout",
  "components",
  "a11y",
  "advanced",
]

const TAB_ICONS: Record<AppearanceTabId, ComponentType<{ className?: string }>> = {
  theme: PaletteIcon,
  auto: SunMoonIcon,
  themePack: PackageIcon,
  wallpaper: ImageIcon,
  custom: PaintbrushIcon,
  import: DownloadIcon,
  typography: TypeIcon,
  layout: LayoutGridIcon,
  components: BlocksIcon,
  a11y: AccessibilityIcon,
  advanced: WrenchIcon,
}

function isAppearanceTab(value: string | null): value is AppearanceTabId {
  return !!value && (TAB_IDS as string[]).includes(value)
}

export function AppearanceSection() {
  const t = useTranslations("settings.appearance")
  const router = useRouter()
  const searchParams = useSearchParams()
  const requested = searchParams.get(APPEARANCE_TAB_PARAM)
  const activeTab: AppearanceTabId = isAppearanceTab(requested) ? requested : "theme"

  const onTabChange = (value: string) => {
    if (!isAppearanceTab(value)) return
    const next = new URLSearchParams(searchParams.toString())
    next.set(APPEARANCE_TAB_PARAM, value)
    router.replace(`?${next.toString()}`, { scroll: false })
  }

  return (
    <div className="space-y-6">
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

      {/* Mobile / narrow: live preview as a disclosure above the tabs. */}
      <Collapsible className="xl:hidden">
        <CollapsibleTrigger asChild>
          <Button variant="outline" size="sm" className="w-full justify-between">
            {t("preview.title")}
            <ChevronDownIcon className="size-4 transition-transform data-[state=open]:rotate-180" />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-3">
          <AppearancePreview />
        </CollapsibleContent>
      </Collapsible>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <Tabs value={activeTab} onValueChange={onTabChange}>
          {/* Wrap to multiple rows on narrow viewports instead of a hidden
              horizontal scroll — all tabs stay visible and tappable. */}
          <TabsList className="flex h-auto w-full flex-wrap justify-start gap-1">
            {TAB_IDS.map((id) => {
              const Icon = TAB_ICONS[id]
              return (
                <TabsTrigger key={id} value={id} className="gap-1.5">
                  <Icon className="size-3.5" />
                  {t(`tabs.${id}`)}
                </TabsTrigger>
              )
            })}
          </TabsList>
          <TabsContent value="theme" className="mt-4">
            <ThemeTab />
          </TabsContent>
          <TabsContent value="auto" className="mt-4">
            <AutoModeTab />
          </TabsContent>
          <TabsContent value="themePack" className="mt-4">
            <ThemePackTab />
          </TabsContent>
          <TabsContent value="wallpaper" className="mt-4">
            <WallpaperTab />
          </TabsContent>
          <TabsContent value="custom" className="mt-4">
            <CustomThemeTab />
          </TabsContent>
          <TabsContent value="import" className="mt-4">
            <VscodeImportTab />
          </TabsContent>
          <TabsContent value="typography" className="mt-4">
            <TypographyTab />
          </TabsContent>
          <TabsContent value="layout" className="mt-4">
            <LayoutTab />
          </TabsContent>
          <TabsContent value="components" className="mt-4">
            <ComponentsTab />
          </TabsContent>
          <TabsContent value="a11y" className="mt-4">
            <A11yTab />
          </TabsContent>
          <TabsContent value="advanced" className="mt-4">
            <AdvancedTab />
          </TabsContent>
        </Tabs>

        {/* Desktop: sticky live-preview rail beside the tabs. */}
        <aside className="hidden xl:block">
          <div className="sticky top-2 space-y-2">
            <p className="text-xs font-medium text-muted-foreground">{t("preview.title")}</p>
            <AppearancePreview />
            <p className="text-[11px] text-muted-foreground">{t("preview.hint")}</p>
          </div>
        </aside>
      </div>

      <div className="border-t pt-4">
        <PersonalizationCard />
      </div>

      <PluginExtensionSlot
        point="settings.appearance"
        className="space-y-2 border-t pt-4 empty:hidden"
      />
    </div>
  )
}
