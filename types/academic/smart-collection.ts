/**
 * Academic Smart Collection Type Definitions
 * Smart collection rules for auto-categorization
 */

import type { LibraryPaper } from "./library"

// ============================================================================
// Smart Collection Rule Types
// ============================================================================

export interface SmartCollectionRule {
  id: string
  name: string
  description: string
  icon: string
  color: string
  enabled: boolean
  paperCount: number
  lastUpdated: Date
  criteria: {
    type: "keyword" | "field" | "year" | "citations" | "status" | "ai-topic"
    value: string | number
    operator?: "contains" | "equals" | "greater" | "less" | "range"
  }[]
  matchFn: (
    paper: LibraryPaper,
    criteria: {
      type: string
      value: string | number
      operator?: string
    }
  ) => boolean
}
