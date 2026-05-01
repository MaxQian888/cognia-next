/**
 * Academic Import/Export Type Definitions
 * Import and export formats, options, and results
 */

import type { LibraryPaper } from "./library"

// ============================================================================
// Import/Export Formats
// ============================================================================

export type ImportFormat = "bibtex" | "ris" | "endnote" | "zotero" | "mendeley" | "json"
export type AcademicExportFormat = "bibtex" | "ris" | "json" | "csv" | "markdown"

// ============================================================================
// Import Types
// ============================================================================

export interface ImportOptions {
  format: ImportFormat
  mergeStrategy: "skip" | "replace" | "merge"
  importAnnotations?: boolean
  importNotes?: boolean
  targetCollection?: string
}

export interface ImportResult {
  imported: number
  skipped: number
  failed: number
  errors?: string[]
  papers: LibraryPaper[]
}

// ============================================================================
// Export Types
// ============================================================================

export interface AcademicExportOptions {
  format: AcademicExportFormat
  paperIds?: string[]
  collectionId?: string
  includeAnnotations?: boolean
  includeNotes?: boolean
  includeAiAnalysis?: boolean
}

export interface AcademicExportResult {
  success: boolean
  data: string
  filename: string
  paperCount: number
}
