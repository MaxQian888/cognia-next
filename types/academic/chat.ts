/**
 * Academic Chat Type Definitions
 * Chat panel types extracted from components
 */

import type { Paper, PaperAuthor } from "./paper"
import type { PaperAnalysisType } from "./analysis"

// ============================================================================
// Chat Types
// ============================================================================

export interface ChatMessage {
  id: string
  role: "user" | "assistant"
  content: string
  timestamp: Date
  papers?: Paper[]
  analysisType?: PaperAnalysisType
}

export interface AcademicChatPanelProps {
  onPaperSelect?: (paper: Paper) => void
  onAddToLibrary?: (paper: Paper) => void
  initialQuery?: string
  className?: string
}

// Re-export for convenience
export type { PaperAuthor }
