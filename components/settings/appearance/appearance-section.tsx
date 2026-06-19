"use client"

// Tabbed shell for the Appearance settings section. Mirrors the
// `data-section.tsx` pattern (URL-driven active tab). The tab strip wraps to
// multiple rows on narrow screens so every tab stays visible without a
// horizontal scroll the user might miss.
//
// "Reset" is intentionally NOT rendered here: the settings shell already
// mounts a shared `SectionResetButton` for every section (see
// `settings-shell.tsx`), which resets all appearance-owned keys to defaults
// while preserving the user's uploaded wallpaper library (see
// `lib/settings/section-keys.ts` `RESET_EXCLUDE`).

import { useTranslations } from "next-intl"
import { useRouter, useSearchParams } from "next/navigation"
import { PaletteIcon } from "lucide-react"
import { Label } from "@/components/ui/label"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ThemeTab } from "./tabs/theme-tab"
import { ThemePackTab } from "./tabs/theme-pack-tab"
import { TypographyTab } from "./tabs/typography-tab"
import { WallpaperTab } from "./tabs/wallpaper-tab"
import { CustomThemeTab } from "./tabs/custom-theme-tab"
import { VscodeImportTab } from "./tabs/vscode-import-tab"
import { AdvancedTab } from "./tabs/advanced-tab"
import { A11yTab } from "./tabs/a11y-tab"
import { ComponentsTab } from "./tabs/components-tab"
import { AutoModeTab } from "./tabs/auto-mode-tab"
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
  "components",
  "a11y",
  "advanced",
]

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
      <div className="space-y-1">
        <Label className="flex items-center gap-2">
          <PaletteIcon className="size-4" />
          {t("title")}
        </Label>
        <p className="text-xs text-muted-foreground">{t("description")}</p>
      </div>

      <Tabs value={activeTab} onValueChange={onTabChange}>
        {/* Wrap to multiple rows on narrow viewports instead of a hidden
            horizontal scroll — all 10 tabs stay visible and tappable. */}
        <TabsList className="flex h-auto w-full flex-wrap justify-start gap-1">
          <TabsTrigger value="theme">{t("tabs.theme")}</TabsTrigger>
          <TabsTrigger value="auto">{t("tabs.auto")}</TabsTrigger>
          <TabsTrigger value="themePack">{t("tabs.themePack")}</TabsTrigger>
          <TabsTrigger value="wallpaper">{t("tabs.wallpaper")}</TabsTrigger>
          <TabsTrigger value="custom">{t("tabs.custom")}</TabsTrigger>
          <TabsTrigger value="import">{t("tabs.import")}</TabsTrigger>
          <TabsTrigger value="typography">{t("tabs.typography")}</TabsTrigger>
          <TabsTrigger value="components">{t("tabs.components")}</TabsTrigger>
          <TabsTrigger value="a11y">{t("tabs.a11y")}</TabsTrigger>
          <TabsTrigger value="advanced">{t("tabs.advanced")}</TabsTrigger>
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
