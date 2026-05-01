/**
 * A2UI Constants
 * Shared constants used across A2UI components
 */

import type { PaperAnalysisType } from "@/types/academic"

// =============================================================================
// Category Constants (moved from hooks/a2ui/use-app-gallery-filter.ts)
// =============================================================================

export const CATEGORY_KEYS = ["productivity", "data", "form", "utility", "social"] as const

export const CATEGORY_I18N_MAP: Record<string, string> = {
  productivity: "categoryProductivity",
  data: "categoryData",
  form: "categoryForm",
  utility: "categoryUtility",
  social: "categorySocial",
}

// =============================================================================
// Surface Style Constants (moved from components/a2ui/a2ui-surface.tsx)
// =============================================================================

/**
 * Surface container styles by type
 */
export const surfaceStyles = {
  inline: "w-full",
  dialog: "fixed inset-0 z-50 flex items-center justify-center bg-black/50",
  panel: "w-full max-w-md border-l bg-background",
  fullscreen: "fixed inset-0 z-50 bg-background",
}

/**
 * Surface content wrapper styles
 */
export const contentStyles = {
  inline: "",
  dialog: "bg-background rounded-lg shadow-lg max-w-lg w-full max-h-[90vh] overflow-auto p-4",
  panel: "h-full overflow-auto p-4",
  fullscreen: "h-full overflow-auto p-4",
}

// =============================================================================
// Academic Analysis Constants (moved from components/a2ui/academic/academic-analysis-panel.tsx)
// =============================================================================

export const ANALYSIS_TYPE_ICONS: Record<PaperAnalysisType, string> = {
  summary: "📝",
  "key-insights": "💡",
  methodology: "🔬",
  findings: "📊",
  limitations: "⚠️",
  "future-work": "🚀",
  "related-work": "🔗",
  "technical-details": "⚙️",
  critique: "🎯",
  eli5: "👶",
  comparison: "⚖️",
  custom: "✏️",
}

export const ANALYSIS_TYPE_I18N_KEYS: Record<PaperAnalysisType, string> = {
  summary: "analysisSummary",
  "key-insights": "analysisKeyInsights",
  methodology: "analysisMethodology",
  findings: "analysisFindings",
  limitations: "analysisLimitations",
  "future-work": "analysisFutureWork",
  "related-work": "analysisRelatedWork",
  "technical-details": "analysisTechnicalDetails",
  critique: "analysisCritique",
  eli5: "analysisEli5",
  comparison: "analysisComparison",
  custom: "analysisCustom",
}

export const ANALYSIS_TYPE_VALUES: PaperAnalysisType[] = [
  "summary",
  "key-insights",
  "methodology",
  "findings",
  "limitations",
  "future-work",
  "related-work",
  "technical-details",
  "comparison",
  "critique",
  "eli5",
  "custom",
]
