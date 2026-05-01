/**
 * Academic Analysis Type Definitions
 * Paper analysis types, options, results, and UI constants
 */

// ============================================================================
// Analysis Types
// ============================================================================

export interface PaperAnalysisRequest {
  paperId: string
  analysisType: PaperAnalysisType
  options?: PaperAnalysisOptions
}

export type PaperAnalysisType =
  | "summary"
  | "key-insights"
  | "methodology"
  | "findings"
  | "limitations"
  | "future-work"
  | "related-work"
  | "technical-details"
  | "comparison"
  | "critique"
  | "eli5" // Explain Like I'm 5
  | "custom"

export interface PaperAnalysisOptions {
  depth?: "brief" | "standard" | "detailed"
  language?: string
  customPrompt?: string
  includeCitations?: boolean
  compareWith?: string[] // Other paper IDs for comparison
}

export interface PaperAnalysisResult {
  paperId: string
  analysisType: PaperAnalysisType
  content: string
  structuredContent?: Record<string, unknown>
  relatedPapers?: string[]
  suggestedQuestions?: string[]
  createdAt: Date
  modelUsed?: string
}

// ============================================================================
// UI Constants for Analysis
// ============================================================================

export const ANALYSIS_TYPES: { value: PaperAnalysisType; label: string; description: string }[] = [
  { value: "summary", label: "Summary", description: "Comprehensive paper summary" },
  { value: "key-insights", label: "Key Insights", description: "Main takeaways and findings" },
  { value: "methodology", label: "Methodology", description: "Research methods analysis" },
  { value: "findings", label: "Findings", description: "Key results and findings" },
  { value: "limitations", label: "Limitations", description: "Paper limitations" },
  { value: "future-work", label: "Future Work", description: "Future research directions" },
  { value: "related-work", label: "Related Work", description: "Related research analysis" },
  {
    value: "technical-details",
    label: "Technical Details",
    description: "In-depth technical analysis",
  },
  { value: "comparison", label: "Comparison", description: "Compare with other papers" },
  { value: "critique", label: "Critique", description: "Critical analysis" },
  { value: "eli5", label: "ELI5", description: "Simple explanation" },
]
