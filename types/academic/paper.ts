/**
 * Academic Paper Type Definitions
 * Core paper, author, citation, and metadata types
 */

import type { AcademicProviderType } from "./provider"

// ============================================================================
// Author & Citation Types
// ============================================================================

export interface PaperAuthor {
  name: string
  authorId?: string
  affiliation?: string
  email?: string
  orcid?: string
}

export interface PaperCitation {
  paperId: string
  title: string
  authors?: PaperAuthor[]
  year?: number
  venue?: string
  citationCount?: number
  isInfluential?: boolean
}

export interface PaperReference extends PaperCitation {
  contexts?: string[] // Citation contexts in the paper
}

// ============================================================================
// Paper Metadata & URL Types
// ============================================================================

export interface PaperMetadata {
  doi?: string
  arxivId?: string
  pmid?: string
  pmcid?: string
  corpusId?: string
  magId?: string
  openAlexId?: string
  coreId?: string
  dblpKey?: string
}

export interface PaperUrl {
  url: string
  type: "pdf" | "html" | "abstract" | "repository" | "other"
  source: string
  isOpenAccess?: boolean
}

// ============================================================================
// Paper Type
// ============================================================================

export interface Paper {
  id: string
  providerId: AcademicProviderType
  externalId: string // Provider-specific ID

  // Basic metadata
  title: string
  abstract?: string
  authors: PaperAuthor[]
  year?: number
  publicationDate?: string
  venue?: string
  journal?: string
  conference?: string
  volume?: string
  issue?: string
  pages?: string

  // Classification
  categories?: string[]
  keywords?: string[]
  fieldsOfStudy?: string[]

  // Metrics
  citationCount?: number
  referenceCount?: number
  influentialCitationCount?: number

  // URLs and access
  urls: PaperUrl[]
  pdfUrl?: string
  openAccessUrl?: string
  isOpenAccess?: boolean

  // External IDs
  metadata: PaperMetadata

  // Timestamps
  createdAt: Date
  updatedAt: Date
  fetchedAt: Date
}
