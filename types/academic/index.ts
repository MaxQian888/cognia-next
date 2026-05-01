/**
 * Academic Type Definitions - Barrel Exports
 */

// Paper types
export type {
  Paper,
  PaperAuthor,
  PaperCitation,
  PaperReference,
  PaperMetadata,
  PaperUrl,
} from "./paper"

// Provider types
export type { AcademicProviderType, AcademicProviderConfig } from "./provider"
export { DEFAULT_ACADEMIC_PROVIDERS } from "./provider"

// Library types
export type {
  LibraryPaper,
  PaperReadingStatus,
  PaperPriority,
  PaperAnnotation,
  PaperNote,
} from "./library"

// Collection types
export type { PaperCollection, CreateCollectionOptions } from "./collection"

// Search types
export type {
  PaperSearchFilter,
  PaperSearchOptions,
  PaperSearchResult,
  AggregatedSearchResult,
} from "./search"

// Analysis types
export type {
  PaperAnalysisRequest,
  PaperAnalysisType,
  PaperAnalysisOptions,
  PaperAnalysisResult,
} from "./analysis"
export { ANALYSIS_TYPES } from "./analysis"

// Learning types
export type {
  AcademicLearningSession,
  AcademicLearningPhase,
  AcademicConcept,
  AcademicQuestion,
} from "./learning"

// Import/Export types
export type {
  ImportFormat,
  AcademicExportFormat,
  ImportOptions,
  ImportResult,
  AcademicExportOptions,
  AcademicExportResult,
} from "./import-export"

// Settings types
export type { AcademicModeSettings, AcademicStatistics } from "./settings"
export { DEFAULT_ACADEMIC_SETTINGS } from "./settings"

// PPT types
export type {
  PaperToPPTOptions,
  PaperPPTSection,
  PaperToPPTResult,
  PaperPPTOutlineItem,
} from "./ppt"
export { DEFAULT_PPT_SECTIONS } from "./ppt"

// Chat types
export type { ChatMessage, AcademicChatPanelProps } from "./chat"

// Smart collection types
export type { SmartCollectionRule } from "./smart-collection"
