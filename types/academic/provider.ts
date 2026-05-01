/**
 * Academic Provider Type Definitions
 * Provider configuration and defaults
 */

// ============================================================================
// Provider Types
// ============================================================================

export type AcademicProviderType =
  | "arxiv"
  | "semantic-scholar"
  | "core"
  | "openalex"
  | "dblp"
  | "unpaywall"
  | "openreview"
  | "huggingface-papers"

export interface AcademicProviderConfig {
  providerId: AcademicProviderType
  name: string
  description: string
  baseUrl: string
  apiKey?: string
  enabled: boolean
  rateLimit?: {
    requestsPerSecond: number
    requestsPerDay?: number
  }
  features: {
    search: boolean
    fullText: boolean
    citations: boolean
    references: boolean
    pdfDownload: boolean
    openAccess: boolean
  }
}

// ============================================================================
// Default Provider Configurations
// ============================================================================

export const DEFAULT_ACADEMIC_PROVIDERS: Record<AcademicProviderType, AcademicProviderConfig> = {
  arxiv: {
    providerId: "arxiv",
    name: "arXiv",
    description: "Open-access archive for scholarly articles in physics, mathematics, CS, and more",
    baseUrl: "https://export.arxiv.org/api",
    enabled: true,
    rateLimit: { requestsPerSecond: 0.33 }, // 3 second delay recommended
    features: {
      search: true,
      fullText: true,
      citations: false,
      references: false,
      pdfDownload: true,
      openAccess: true,
    },
  },
  "semantic-scholar": {
    providerId: "semantic-scholar",
    name: "Semantic Scholar",
    description: "AI-powered research tool with citation analysis",
    baseUrl: "https://api.semanticscholar.org/graph/v1",
    enabled: true,
    rateLimit: { requestsPerSecond: 10 },
    features: {
      search: true,
      fullText: false,
      citations: true,
      references: true,
      pdfDownload: true,
      openAccess: true,
    },
  },
  core: {
    providerId: "core",
    name: "CORE",
    description: "World's largest collection of open access research papers",
    baseUrl: "https://api.core.ac.uk/v3",
    enabled: true,
    rateLimit: { requestsPerSecond: 10 },
    features: {
      search: true,
      fullText: true,
      citations: false,
      references: false,
      pdfDownload: true,
      openAccess: true,
    },
  },
  openalex: {
    providerId: "openalex",
    name: "OpenAlex",
    description: "Open catalog of scholarly papers, authors, and institutions",
    baseUrl: "https://api.openalex.org",
    enabled: true,
    rateLimit: { requestsPerSecond: 10 },
    features: {
      search: true,
      fullText: false,
      citations: true,
      references: true,
      pdfDownload: true,
      openAccess: true,
    },
  },
  dblp: {
    providerId: "dblp",
    name: "DBLP",
    description: "Computer science bibliography database",
    baseUrl: "https://dblp.org/search",
    enabled: true,
    rateLimit: { requestsPerSecond: 1 },
    features: {
      search: true,
      fullText: false,
      citations: false,
      references: false,
      pdfDownload: false,
      openAccess: false,
    },
  },
  unpaywall: {
    providerId: "unpaywall",
    name: "Unpaywall",
    description: "Find free versions of research papers",
    baseUrl: "https://api.unpaywall.org/v2",
    enabled: true,
    rateLimit: { requestsPerSecond: 10 },
    features: {
      search: false,
      fullText: false,
      citations: false,
      references: false,
      pdfDownload: true,
      openAccess: true,
    },
  },
  openreview: {
    providerId: "openreview",
    name: "OpenReview",
    description: "Open peer review platform for scientific papers",
    baseUrl: "https://api2.openreview.net",
    enabled: true,
    rateLimit: { requestsPerSecond: 5 },
    features: {
      search: true,
      fullText: true,
      citations: false,
      references: false,
      pdfDownload: true,
      openAccess: true,
    },
  },
  "huggingface-papers": {
    providerId: "huggingface-papers",
    name: "HuggingFace Papers",
    description: "AI/ML papers curated by HuggingFace community",
    baseUrl: "https://huggingface.co/api/papers",
    enabled: true,
    rateLimit: { requestsPerSecond: 5 },
    features: {
      search: true,
      fullText: false,
      citations: false,
      references: false,
      pdfDownload: true,
      openAccess: true,
    },
  },
}
