/**
 * Academic Library Type Definitions
 * Library paper, reading status, annotations, and notes
 */

import type { Paper, PaperAuthor } from "./paper"

// ============================================================================
// Reading Status & Priority
// ============================================================================

export type PaperReadingStatus = "unread" | "reading" | "completed" | "archived"
export type PaperPriority = "low" | "medium" | "high" | "urgent"

// ============================================================================
// Annotation & Note Types
// ============================================================================

export interface PaperAnnotation {
  id: string
  paperId: string
  type: "highlight" | "note" | "bookmark" | "question"
  content: string
  pageNumber?: number
  position?: {
    x: number
    y: number
    width: number
    height: number
  }
  color?: string
  createdAt: Date
  updatedAt: Date
}

export interface PaperNote {
  id: string
  paperId: string
  title?: string
  content: string
  tags?: string[]
  linkedAnnotations?: string[]
  createdAt: Date
  updatedAt: Date
}

// ============================================================================
// Library Paper Type
// ============================================================================

export interface LibraryPaper extends Paper {
  // Library-specific fields
  libraryId: string
  addedAt: Date
  lastAccessedAt?: Date

  // Organization
  collections?: string[]
  tags?: string[]

  // Reading progress
  readingStatus: PaperReadingStatus
  priority: PaperPriority
  readingProgress?: number // 0-100

  // User data
  userRating?: number // 1-5
  userNotes?: string
  annotations?: PaperAnnotation[]
  notes?: PaperNote[]

  // Local storage
  localPdfPath?: string
  localFullTextPath?: string
  hasCachedPdf?: boolean
  hasCachedFullText?: boolean

  // AI analysis
  aiSummary?: string
  aiKeyInsights?: string[]
  aiRelatedTopics?: string[]
  lastAnalyzedAt?: Date
}

// Re-export PaperAuthor for convenience (used by LibraryPaper consumers)
export type { PaperAuthor }
