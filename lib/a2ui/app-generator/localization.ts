import enCatalog from "@/i18n/messages/en/a2uiGenerator.json"
import zhCatalog from "@/i18n/messages/zh-CN/a2uiGenerator.json"
import { applyComponentLocalization, mergeLocalizationOverlay } from "@/lib/a2ui/templates"
import type { A2UIComponent } from "@/types/a2ui/schema"

export type GeneratorFactoryKind = keyof typeof enCatalog.factories

const catalogs = {
  en: enCatalog,
  zh: zhCatalog,
} as const

export const generatorFactoryKinds = Object.keys(enCatalog.factories) as GeneratorFactoryKind[]

export function localizeGeneratedComponents(
  kind: GeneratorFactoryKind,
  components: A2UIComponent[],
  language: "zh" | "en"
): A2UIComponent[] {
  return applyComponentLocalization(components, catalogs[language].factories[kind])
}

export function localizeDashboardDataModel(
  dataModel: Record<string, unknown>,
  language: "zh" | "en"
): Record<string, unknown> {
  return mergeLocalizationOverlay(dataModel, catalogs[language].dashboardDataModel) as Record<
    string,
    unknown
  >
}
