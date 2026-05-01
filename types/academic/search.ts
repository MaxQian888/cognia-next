/**
 * Academic Search Type Definitions
 * Search filters, options, and result types
 */

import type { AcademicProviderType } from "./provider"
import type { Paper } from "./paper"

// ============================================================================
// Search Filter & Options
// ============================================================================

export interface PaperSearchFilter {
  query?: string
  authors?: string[]
  readingStatus?: string
  yearFrom?: number
  yearTo?: number
  venues?: string[]
  categories?: string[]
  fieldsOfStudy?: string[]
  openAccessOnly?: boolean
  minRating?: number
  hasFullText?: boolean
  hasPdf?: boolean
  minCitations?: number
  maxCitations?: number
  smartRuleId?: string
  topic?: string
  providers?: AcademicProviderType[]
  sortBy?: "relevance" | "date" | "citations" | "title"
  sortOrder?: "asc" | "desc"
}

export interface PaperSearchOptions {
  filter: PaperSearchFilter
  limit?: number
  offset?: number
  includeAbstract?: boolean
  includeAuthors?: boolean
  includeCitations?: boolean
  includeReferences?: boolean
}

// ============================================================================
// Search Results
// ============================================================================

export interface PaperSearchResult {
  papers: Paper[]
  totalResults: number
  hasMore: boolean
  offset: number
  provider: AcademicProviderType
  searchTime: number
}

export interface AggregatedSearchResult {
  papers: Paper[]
  totalResults: number
  providerResults: Record<
    string,
    {
      count: number
      success: boolean
      error?: string
    }
  >
  degradedProviders?: Record<
    string,
    {
      reason: string
      retriable: boolean
    }
  >
  searchTime: number
  searchTimeMs?: number
}
