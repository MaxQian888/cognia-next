"use client"

// Tabbed shell for the Appearance settings section. Mirrors the
// `data-section.tsx` pattern (URL-driven active tab, scrollable tabs
// strip on narrow screens).

import { useState } from "react"
import { useTranslations } from "next-intl"
import { useRouter, useSearchParams } from "next/navigation"
import { PaletteIcon } from "lucide-react"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { DEFAULT_BACKGROUND_SETTINGS } from "@/types/appearance"
import { ThemeTab } from "./tabs/theme-tab"
import { ThemePackTab } from "./tabs/theme-pack-tab"
import { TypographyTab } from "./tabs/typography-tab"
import { WallpaperTab } from "./tabs/wallpaper-tab"
import { CustomThemeTab } from "./tabs/custom-theme-tab"
import { VscodeImportTab } from "./tabs/vscode-import-tab"
import { AdvancedTab } from "./tabs/advanced-tab"
import { A11yTab } from "./tabs/a11y-tab"
import { PluginExtensionSlot } from "@/components/plugins/plugin-extension-slot"

const APPEARANCE_TAB_PARAM = "appearanceTab"

export type AppearanceTabId =
  | "theme"
  | "themePack"
  | "wallpaper"
  | "custom"
  | "import"
  | "typography"
  | "a11y"
  | "advanced"

const TAB_IDS: AppearanceTabId[] = [
  "theme",
  "themePack",
  "wallpaper",
  "custom",
  "import",
  "typography",
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

  const save = useSettingsStore((s) => s.save)
  const [showReset, setShowReset] = useState(false)

  const onTabChange = (value: string) => {
    if (!isAppearanceTab(value)) return
    const next = new URLSearchParams(searchParams.toString())
    next.set(APPEARANCE_TAB_PARAM, value)
    router.replace(`?${next.toString()}`, { scroll: false })
  }

  // Wallpapers (user-uploaded image library) is intentionally preserved.
  // It contains binary content the user added; resetting "appearance settings"
  // shouldn't destroy that. Users can delete individual wallpapers from the
  // wallpaper tab if they want to.
  async function handleReset() {
    await save({
      customThemes: [],
      activeCustomThemeId: null,
      customCss: "",
      customCssEnabled: false,
      background: { ...DEFAULT_BACKGROUND_SETTINGS },
    })
    setShowReset(false)
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
        <div className="flex items-center justify-between gap-2">
          <div className="-mx-1 flex-1 overflow-x-auto px-1">
            <TabsList className="w-max">
              <TabsTrigger value="theme">{t("tabs.theme")}</TabsTrigger>
              <TabsTrigger value="themePack">{t("tabs.themePack")}</TabsTrigger>
              <TabsTrigger value="wallpaper">{t("tabs.wallpaper")}</TabsTrigger>
              <TabsTrigger value="custom">{t("tabs.custom")}</TabsTrigger>
              <TabsTrigger value="import">{t("tabs.import")}</TabsTrigger>
              <TabsTrigger value="typography">{t("tabs.typography")}</TabsTrigger>
              <TabsTrigger value="a11y">{t("tabs.a11y")}</TabsTrigger>
              <TabsTrigger value="advanced">{t("tabs.advanced")}</TabsTrigger>
            </TabsList>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={() => setShowReset(true)}>
            {t("reset.button")}
          </Button>
        </div>
        <TabsContent value="theme" className="mt-4">
          <ThemeTab />
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
        <TabsContent value="a11y" className="mt-4">
          <A11yTab />
        </TabsContent>
        <TabsContent value="advanced" className="mt-4">
          <AdvancedTab />
        </TabsContent>
      </Tabs>

      <PluginExtensionSlot
        point="settings.appearance"
        className="space-y-2 border-t pt-4 empty:hidden"
      />

      <AlertDialog open={showReset} onOpenChange={setShowReset}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("reset.title")}</AlertDialogTitle>
            <AlertDialogDescription>{t("reset.body")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("reset.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={handleReset}>{t("reset.confirm")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
