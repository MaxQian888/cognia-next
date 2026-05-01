/**
 * Academic Settings & Statistics Type Definitions
 * Mode settings, defaults, and statistics
 */

import type { AcademicProviderType } from "./provider"
import type { PaperReadingStatus } from "./library"
// ZoteroConfig stub: cognia-next does not yet ship Cognia's
// `lib/academic/zotero-integration` runtime. The shape mirrors Cognia's
// definition so settings round-trips stay typed.
interface ZoteroConfig {
  apiKey: string
  userId: string
  libraryType: "user" | "group"
  libraryId: string
  syncEnabled: boolean
  [key: string]: unknown
}

// ============================================================================
// Settings Types
// ============================================================================

export interface AcademicModeSettings {
  // Provider settings
  providers: Record<
    AcademicProviderType,
    {
      enabled: boolean
      apiKey?: string
      priority: number
    }
  >
  defaultProviders: AcademicProviderType[]

  // Search settings
  defaultSearchLimit: number
  aggregateSearch: boolean
  preferOpenAccess: boolean

  // Download settings
  autoDownloadPdf: boolean
  pdfStoragePath?: string
  maxStorageSize?: number // MB

  // Analysis settings
  defaultAnalysisDepth: "brief" | "standard" | "detailed"
  autoAnalyzeOnAdd: boolean
  preferredLanguage: string

  // Learning settings
  enableGuidedLearning: boolean
  learningDifficulty: "beginner" | "intermediate" | "advanced"
  enableSpacedRepetition: boolean

  // UI settings
  defaultView: "grid" | "list" | "table"
  showCitationCounts: boolean
  showAbstractPreview: boolean

  // Zotero integration
  zoteroConfig?: ZoteroConfig | null
}

export const DEFAULT_ACADEMIC_SETTINGS: AcademicModeSettings = {
  providers: {
    arxiv: { enabled: true, priority: 1 },
    "semantic-scholar": { enabled: true, priority: 2 },
    core: { enabled: true, priority: 3 },
    openalex: { enabled: true, priority: 4 },
    dblp: { enabled: true, priority: 5 },
    unpaywall: { enabled: true, priority: 6 },
    openreview: { enabled: true, priority: 7 },
    "huggingface-papers": { enabled: true, priority: 8 },
  },
  defaultProviders: ["arxiv", "semantic-scholar", "core"],
  defaultSearchLimit: 20,
  aggregateSearch: true,
  preferOpenAccess: true,
  autoDownloadPdf: false,
  defaultAnalysisDepth: "standard",
  autoAnalyzeOnAdd: false,
  preferredLanguage: "en",
  enableGuidedLearning: true,
  learningDifficulty: "intermediate",
  enableSpacedRepetition: true,
  defaultView: "list",
  showCitationCounts: true,
  showAbstractPreview: true,
}

// ============================================================================
// Statistics Types
// ============================================================================

export interface AcademicStatistics {
  totalPapers: number
  totalCollections: number
  totalAnnotations: number
  totalNotes: number

  papersByStatus: Record<PaperReadingStatus, number>
  papersByProvider: Record<AcademicProviderType, number>
  papersByYear: Record<number, number>
  papersByCategory: Record<string, number>

  readingStreak: number
  papersReadThisWeek: number
  papersReadThisMonth: number
  averageReadingTime?: number

  topAuthors: { name: string; count: number }[]
  topVenues: { name: string; count: number }[]
  topKeywords: { keyword: string; count: number }[]

  lastUpdated: Date
}
