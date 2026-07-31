import type { Locale } from "@/i18n/config"
import enCatalog from "@/i18n/messages/en/a2uiTemplates.json"
import zhCNCatalog from "@/i18n/messages/zh-CN/a2uiTemplates.json"
import { deepClone } from "@/lib/a2ui/data-model"
import type { A2UIComponent } from "@/types/a2ui/schema"
import type { A2UIAppTemplate } from "./types"

interface TemplateLocalization {
  name: string
  description: string
  tags: string[]
  components?: Record<string, Record<string, unknown>>
  dataModel?: Record<string, unknown>
}

interface TemplateMessageCatalog {
  runtime: Record<string, string>
  templates: Record<string, TemplateLocalization>
}

export type BuiltInRuntimeMessageKey = keyof typeof enCatalog.runtime

const catalogs: Record<Locale, TemplateMessageCatalog> = {
  en: enCatalog,
  "zh-CN": zhCNCatalog,
}

export function mergeLocalizationOverlay(base: unknown, overlay: unknown): unknown {
  if (
    base !== null &&
    overlay !== null &&
    typeof base === "object" &&
    typeof overlay === "object" &&
    !Array.isArray(base) &&
    !Array.isArray(overlay)
  ) {
    const result = deepClone(base as Record<string, unknown>)
    for (const [key, value] of Object.entries(overlay as Record<string, unknown>)) {
      result[key] = mergeLocalizationOverlay(result[key], value)
    }
    return result
  }

  return deepClone(overlay)
}

export function applyComponentLocalization(
  components: A2UIComponent[],
  overlays: Record<string, Record<string, unknown>> | undefined
): A2UIComponent[] {
  return components.map((component) => {
    const overlay = overlays?.[component.id]
    return overlay
      ? (mergeLocalizationOverlay(component, overlay) as A2UIComponent)
      : deepClone(component)
  })
}

/**
 * Clone a canonical built-in template and apply locale-owned copy without
 * duplicating its component structure or behavioral values.
 */
export function localizeTemplate(template: A2UIAppTemplate, locale: Locale): A2UIAppTemplate {
  const localized = catalogs[locale].templates[template.id]
  const clone = deepClone(template)
  if (!localized) return clone

  const componentCopy = applyComponentLocalization(clone.components, localized.components)

  return {
    ...clone,
    name: localized.name,
    description: localized.description,
    tags: deepClone(localized.tags),
    components: componentCopy,
    dataModel: localized.dataModel
      ? (mergeLocalizationOverlay(clone.dataModel, localized.dataModel) as Record<string, unknown>)
      : clone.dataModel,
  }
}

/** Format locale-stable copy emitted by built-in action handlers. */
export function formatBuiltInRuntimeMessage(
  locale: Locale,
  key: BuiltInRuntimeMessageKey,
  values: Record<string, string | number> = {}
): string {
  const template = catalogs[locale].runtime[key]
  return Object.entries(values).reduce(
    (message, [name, value]) => message.replaceAll(`{${name}}`, String(value)),
    template
  )
}
