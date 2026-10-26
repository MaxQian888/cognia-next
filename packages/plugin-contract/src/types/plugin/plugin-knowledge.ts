import type { DocumentPageRange, DocumentSection } from "@cognia/document/types"

/** Host scopes are selected by identity, never by a plugin-provided allowlist. */
export type PluginKnowledgeScope =
  { kind: "project"; projectId: string } | { kind: "agent"; sessionId: string }

export interface PluginKnowledgeDocumentRequest {
  scope: PluginKnowledgeScope
  knowledgeBaseId: string
  sourceId: string
  generationId?: string
  /** Canonical original-text version, independent of binary/embedding fingerprints. */
  documentVersion?: string
}
export interface PluginKnowledgeRangeRequest extends PluginKnowledgeDocumentRequest {
  sectionId?: string
  pageStart?: number
  pageEnd?: number
  charStart?: number
  charEnd?: number
  maxChars?: number
}
export interface PluginKnowledgeListRequest {
  scope: PluginKnowledgeScope
  query?: string
  offset?: number
  limit?: number
}
export interface PluginKnowledgeBudget {
  calls: number
  maxCalls: number
  readChars: number
  totalReadChars: number
}
export interface PluginKnowledgeDocument {
  knowledgeBaseId: string
  sourceId: string
  generationId: string
  title: string
  format: string
  contentHash: string
  documentVersion?: string
  sectionCount: number
  pageCount: number
  versionStatus: "current" | "historical"
  score?: number
}
export interface PluginKnowledgeListResult {
  documents: PluginKnowledgeDocument[]
  total: number
  nextOffset: number | null
  contentPolicy: string
  budget: PluginKnowledgeBudget
}
export interface PluginKnowledgeOutlineResult {
  knowledgeBaseId: string
  sourceId: string
  generationId: string
  contentHash: string
  documentVersion?: string
  nodes: DocumentSection[]
  total: number
  nextOffset: number | null
  versionStatus: "current" | "historical"
  contentPolicy: string
  budget: PluginKnowledgeBudget
}
export interface PluginKnowledgeRangeResult {
  knowledgeBaseId: string
  sourceId: string
  generationId: string
  contentHash: string
  documentVersion?: string
  title: string
  text: string
  charStart: number
  charEnd: number
  sectionId?: string
  pages: DocumentPageRange[]
  versionStatus: "current" | "historical"
  nextCharStart: number | null
  contentPolicy: string
  budget: PluginKnowledgeBudget
}
export interface PluginKnowledgeLocation {
  knowledgeBaseId: string
  sourceId: string
  generationId: string
  contentHash: string
  documentVersion?: string
  title: string
  format: string
  charStart: number
  charEnd: number
  sectionId?: string
  pageNumber?: number
  versionStatus: "current" | "historical"
  budget: PluginKnowledgeBudget
}
