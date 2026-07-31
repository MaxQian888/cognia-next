// Fixture builders for Canvas stories. Spread `over` to vary a single field;
// every required field gets a realistic default so the object satisfies the
// `@/types` Canvas shapes and is valid to seed into the artifact / comment
// stores via `seedStore`.
import type {
  CanvasDocument,
  CanvasDocumentVersion,
  CanvasSuggestion,
} from "@/types/artifact/artifact"
import type { CanvasComment } from "@/types/canvas/collaboration"

let docSeq = 0
let suggestionSeq = 0
let versionSeq = 0
let commentSeq = 0

const SAMPLE_TS = `export function greet(name: string): string {
  // TODO: handle empty names
  return "Hello, " + name
}

const result = greet("Canvas")
console.log(result)
`

const SAMPLE_MD = `# Project Brief

A short summary of the **Canvas** subsystem.

- Monaco-powered editor
- AI actions and inline suggestions
- Version history and comments
`

export function makeCanvasDocument(over: Partial<CanvasDocument> = {}): CanvasDocument {
  docSeq += 1
  const createdAt = new Date(Date.UTC(2026, 5, 20, 9, 0, 0) + docSeq * 60_000)
  return {
    id: `doc-${docSeq}`,
    sessionId: "story-session",
    title: `Document ${docSeq}`,
    content: SAMPLE_TS,
    language: "typescript",
    type: "code",
    createdAt,
    updatedAt: createdAt,
    editorContext: { saveState: "saved" },
    aiSuggestions: [],
    ...over,
  }
}

export function makeMarkdownDocument(over: Partial<CanvasDocument> = {}): CanvasDocument {
  return makeCanvasDocument({
    title: "Project Brief",
    content: SAMPLE_MD,
    language: "markdown",
    type: "text",
    ...over,
  })
}

export function makeCanvasSuggestion(over: Partial<CanvasSuggestion> = {}): CanvasSuggestion {
  suggestionSeq += 1
  return {
    id: `suggestion-${suggestionSeq}`,
    type: "improve",
    range: { startLine: 2, endLine: 2 },
    originalText: `  return "Hello, " + name`,
    suggestedText: "  return `Hello, ${name}`",
    explanation: "Use a template literal instead of string concatenation.",
    status: "pending",
    ...over,
  }
}

export function makeCanvasVersion(
  over: Partial<CanvasDocumentVersion> = {}
): CanvasDocumentVersion {
  versionSeq += 1
  return {
    id: `version-${versionSeq}`,
    title: `Document ${docSeq || 1}`,
    content: SAMPLE_TS,
    createdAt: new Date(Date.UTC(2026, 5, 20, 9, 0, 0) + versionSeq * 3_600_000),
    description: `Checkpoint ${versionSeq}`,
    isAutoSave: false,
    ...over,
  }
}

export function makeCanvasComment(over: Partial<CanvasComment> = {}): CanvasComment {
  commentSeq += 1
  return {
    id: `comment-${commentSeq}`,
    documentId: "doc-1",
    authorId: "user-1",
    authorName: "Ada Lovelace",
    range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 10 },
    content: `This needs a closer look (#${commentSeq}).`,
    createdAt: new Date(Date.UTC(2026, 5, 20, 10, 0, 0) + commentSeq * 60_000),
    reactions: [],
    ...over,
  }
}
