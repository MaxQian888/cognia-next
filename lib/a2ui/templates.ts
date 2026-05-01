/**
 * A2UI App Templates
 * Re-export barrel — templates are now organized by category in templates/ directory
 *
 * @see ./templates/productivity.ts - Todo, Notes, Habit Tracker, Shopping List
 * @see ./templates/utility.ts - Calculator, Timer, Weather, Unit Converter
 * @see ./templates/form.ts - Survey Form, Contact Form
 * @see ./templates/data.ts - Data Dashboard, Expense Tracker
 * @see ./templates/social.ts - Profile Card
 * @see ./templates/types.ts - Shared types and utilities
 */

export {
  // Types
  type A2UIAppTemplate,
  // Utilities
  generateTemplateId,
  createAppFromTemplate,
  templateCategories,
  // Query functions
  appTemplates,
  getTemplateById,
  getTemplatesByCategory,
  searchTemplates,
  // Productivity
  todoListTemplate,
  notesTemplate,
  habitTrackerTemplate,
  shoppingListTemplate,
  // Utility
  calculatorTemplate,
  timerTemplate,
  weatherTemplate,
  unitConverterTemplate,
  // Form
  surveyFormTemplate,
  contactFormTemplate,
  // Data
  dataDashboardTemplate,
  expenseTrackerTemplate,
  // Social
  profileCardTemplate,
} from "./templates/index"
