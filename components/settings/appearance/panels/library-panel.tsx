"use client"

// "Theme library" panel — the two ways to get a theme you didn't author:
// plugin-contributed theme packs, and themes imported from VSCode. They were
// separate tabs (`themePack`, `import`) whose contents are 103 and 109 lines;
// as one panel they read as the single task they are. Both children are
// unchanged — this file only composes them.

import { useTranslations } from "next-intl"
import { SettingsDivider } from "../../common/settings-section"
import { ThemePackTab } from "../tabs/theme-pack-tab"
import { VscodeImportTab } from "../tabs/vscode-import-tab"

export function AppearanceLibraryPanel() {
  const t = useTranslations("settings.appearance.library")
  return (
    <div className="space-y-4" data-testid="appearance-library-panel">
      <section className="space-y-3">
        <h3 className="text-sm font-medium">{t("packsTitle")}</h3>
        <ThemePackTab />
      </section>
      <SettingsDivider />
      <section className="space-y-3">
        <h3 className="text-sm font-medium">{t("importTitle")}</h3>
        <VscodeImportTab />
      </section>
    </div>
  )
}
