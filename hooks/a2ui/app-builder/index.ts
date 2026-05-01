/**
 * A2UI App Builder - Composed Hook
 * Re-exports the split sub-modules and composes the main useA2UIAppBuilder hook
 */

export type { A2UIAppInstance, A2UIAppAuthor, A2UIAppStats } from "./types"
export type { A2UIAppTemplate } from "@/lib/a2ui/templates"
export {
  useAppActionHandlers,
  formatTime,
  performCalculation,
  performUnitConversion,
} from "./action-handlers"
export { useAppImportExport } from "./import-export"
export { useAppShare } from "./share"
export { getAppInstancesCache, saveAppInstances, loadAppInstances } from "./persistence"
