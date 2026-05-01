/**
 * A2UI App Generator - Barrel Export
 * Re-exports all sub-modules and provides the main generateAppFromDescription entry point
 */

export type { LocalizedTexts, StyleConfig, GenerationContext, AppGenerationRequest } from "./config"
export {
  texts,
  styles,
  appPatterns,
  getLocalizedTexts,
  getStyleConfig,
  detectAppType,
  detectLanguage,
  extractAppName,
  createGenerationContext,
} from "./config"

export type { GeneratedApp } from "./generators"
export {
  createAppMessages,
  generateCalculatorApp,
  generateTimerApp,
  generateTodoApp,
  generateNotesApp,
  generateFormApp,
  generateTrackerApp,
  generateUnitConverterApp,
  generateCustomApp,
  generateDashboardApp,
} from "./generators"

export {
  createBasicCalculatorComponents,
  createTipCalculatorComponents,
  createBMICalculatorComponents,
  createAgeCalculatorComponents,
  createLoanCalculatorComponents,
  createTimerComponents,
  createTodoComponents,
  createNotesComponents,
  createSurveyComponents,
  createContactComponents,
  createExpenseTrackerComponents,
  createHealthTrackerComponents,
  createHabitTrackerComponents,
} from "./component-factories"

import { detectAppType, extractAppName, createGenerationContext } from "./config"
import type { AppGenerationRequest } from "./config"
import type { GeneratedApp } from "./generators"
import {
  generateCalculatorApp,
  generateTimerApp,
  generateTodoApp,
  generateNotesApp,
  generateFormApp,
  generateTrackerApp,
  generateUnitConverterApp,
  generateCustomApp,
  generateDashboardApp,
} from "./generators"

/**
 * Main app generation function
 */
export function generateAppFromDescription(request: AppGenerationRequest): GeneratedApp {
  const { description } = request
  const ctx = createGenerationContext(request)
  const appType = detectAppType(description)
  const name = extractAppName(description, ctx)

  switch (appType) {
    case "calculator":
      return generateCalculatorApp(name, description, ctx)
    case "timer":
      return generateTimerApp(name, description, ctx)
    case "todo":
      return generateTodoApp(name, description, ctx)
    case "notes":
      return generateNotesApp(name, description, ctx)
    case "survey":
      return generateFormApp(name, description, "survey", ctx)
    case "contact":
      return generateFormApp(name, description, "contact", ctx)
    case "dashboard":
      return generateDashboardApp(name, description, ctx)
    default:
      if (/追踪|track|记录|log|打卡/i.test(description)) {
        return generateTrackerApp(name, description, ctx)
      }
      if (/转换|换算|convert/i.test(description)) {
        return generateUnitConverterApp(name, description, ctx)
      }
      return generateCustomApp(name, description, ctx)
  }
}
