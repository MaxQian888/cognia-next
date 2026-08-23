export interface WorkflowAnswerCitation {
  sourceId: string
  documentId: string
  revisionId: string
  chunkId: string
  label?: string
  location?: string
  previewUrl?: string
}

export interface WorkflowAnswerFile {
  ref: string
  name?: string
  mediaType?: string
}

/** Chatflow-facing terminal output. Every field is renderer-safe structured data. */
export interface WorkflowAnswer {
  text?: string
  content?: unknown
  citations: WorkflowAnswerCitation[]
  files: WorkflowAnswerFile[]
  suggestions: string[]
}
