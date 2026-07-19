/**
 * A2UI Templates - Barrel Export
 * Re-exports all templates organized by category
 */

// Types and utilities
export type { A2UIAppTemplate } from "./types"
export { generateTemplateId, createAppFromTemplate, templateCategories } from "./types"
export {
  applyComponentLocalization,
  formatBuiltInRuntimeMessage,
  localizeTemplate,
  mergeLocalizationOverlay,
  type BuiltInRuntimeMessageKey,
} from "./localization"

// Category templates
export {
  todoListTemplate,
  notesTemplate,
  habitTrackerTemplate,
  shoppingListTemplate,
} from "./productivity"
export {
  calculatorTemplate,
  timerTemplate,
  weatherTemplate,
  unitConverterTemplate,
} from "./utility"
export { surveyFormTemplate, contactFormTemplate } from "./form"
export { dataDashboardTemplate, expenseTrackerTemplate } from "./data"
export { profileCardTemplate } from "./social"

// Re-import all for the appTemplates array
import {
  todoListTemplate,
  notesTemplate,
  habitTrackerTemplate,
  shoppingListTemplate,
} from "./productivity"
import {
  calculatorTemplate,
  timerTemplate,
  weatherTemplate,
  unitConverterTemplate,
} from "./utility"
import { surveyFormTemplate, contactFormTemplate } from "./form"
import { dataDashboardTemplate, expenseTrackerTemplate } from "./data"
import { profileCardTemplate } from "./social"
import type { A2UIAppTemplate } from "./types"
import type { Locale } from "@/i18n/config"
import { localizeTemplate } from "./localization"

/**
 * All available templates
 */
export const appTemplates: A2UIAppTemplate[] = [
  todoListTemplate,
  calculatorTemplate,
  surveyFormTemplate,
  dataDashboardTemplate,
  timerTemplate,
  notesTemplate,
  weatherTemplate,
  contactFormTemplate,
  unitConverterTemplate,
  habitTrackerTemplate,
  shoppingListTemplate,
  expenseTrackerTemplate,
  profileCardTemplate,
]

/**
 * Get template by ID
 */
export function getTemplateById(id: string): A2UIAppTemplate | undefined {
  return appTemplates.find((t) => t.id === id)
}

/**
 * Get templates by category
 */
export function getTemplatesByCategory(category: A2UIAppTemplate["category"]): A2UIAppTemplate[] {
  return appTemplates.filter((t) => t.category === category)
}

/**
 * Search templates by name or tags
 */
export function searchTemplates(query: string): A2UIAppTemplate[] {
  const lowerQuery = query.toLowerCase()
  return appTemplates.filter(
    (t) =>
      t.name.toLowerCase().includes(lowerQuery) ||
      t.description.toLowerCase().includes(lowerQuery) ||
      t.tags.some((tag) => tag.toLowerCase().includes(lowerQuery))
  )
}

/** Return isolated, locale-owned copies of all canonical built-in templates. */
export function getLocalizedTemplates(locale: Locale): A2UIAppTemplate[] {
  return appTemplates.map((template) => localizeTemplate(template, locale))
}

/** Resolve one canonical template and return an isolated localized copy. */
export function getLocalizedTemplateById(id: string, locale: Locale): A2UIAppTemplate | undefined {
  const template = getTemplateById(id)
  return template ? localizeTemplate(template, locale) : undefined
}

export function getLocalizedTemplatesByCategory(
  category: A2UIAppTemplate["category"],
  locale: Locale
): A2UIAppTemplate[] {
  return getTemplatesByCategory(category).map((template) => localizeTemplate(template, locale))
}

export function searchLocalizedTemplates(query: string, locale: Locale): A2UIAppTemplate[] {
  const lowerQuery = query.trim().toLocaleLowerCase(locale)
  if (!lowerQuery) return getLocalizedTemplates(locale)
  return getLocalizedTemplates(locale).filter(
    (template) =>
      template.name.toLocaleLowerCase(locale).includes(lowerQuery) ||
      template.description.toLocaleLowerCase(locale).includes(lowerQuery) ||
      template.tags.some((tag) => tag.toLocaleLowerCase(locale).includes(lowerQuery))
  )
}
