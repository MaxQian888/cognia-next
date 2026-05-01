/**
 * A2UI App Generator
 * AI-powered app generation from natural language descriptions
 *
 * Split into sub-modules for maintainability:
 * - app-generator/config.ts — Localization, styles, patterns, detection
 * - app-generator/component-factories.ts — Component array factories per template
 * - app-generator/generators.ts — Generator functions that compose components + data
 * - app-generator/index.ts — Barrel re-export + main generateAppFromDescription
 */

// Re-export everything from the sub-module barrel
export {
  // Config
  texts,
  styles,
  appPatterns,
  getLocalizedTexts,
  getStyleConfig,
  detectAppType,
  detectLanguage,
  extractAppName,
  createGenerationContext,

  // Generators
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
  generateAppFromDescription,

  // Component factories
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
} from "./app-generator/index"

// Re-export types
export type {
  LocalizedTexts,
  StyleConfig,
  GenerationContext,
  AppGenerationRequest,
  GeneratedApp,
} from "./app-generator/index"
