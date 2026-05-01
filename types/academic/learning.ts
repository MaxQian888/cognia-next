/**
 * Academic Learning Type Definitions
 * Guided learning sessions, concepts, and questions
 */

// ============================================================================
// Guided Learning Types
// ============================================================================

export interface AcademicLearningSession {
  id: string
  chatSessionId: string
  topic: string
  papers: string[] // Paper IDs
  currentPaperId?: string

  // Learning state
  phase: AcademicLearningPhase
  progress: number

  // Learning path
  learningObjectives?: string[]
  conceptsToLearn?: AcademicConcept[]
  questionsAnswered?: AcademicQuestion[]

  // Session data
  notes?: string
  insights?: string[]

  // Timestamps
  createdAt: Date
  updatedAt: Date
  completedAt?: Date
}

export type AcademicLearningPhase =
  | "overview" // Getting paper overview
  | "background" // Understanding prerequisites
  | "deep-dive" // Detailed study
  | "methodology" // Understanding methods
  | "analysis" // Analyzing findings
  | "synthesis" // Connecting ideas
  | "application" // Practical applications
  | "review" // Review and consolidation
  | "completed"

export interface AcademicConcept {
  id: string
  name: string
  description?: string
  paperId?: string
  mastery: number // 0-100
  relatedConcepts?: string[]
  createdAt: Date
  lastReviewedAt?: Date
}

export interface AcademicQuestion {
  id: string
  sessionId: string
  paperId?: string
  question: string
  answer?: string
  isCorrect?: boolean
  difficulty: "easy" | "medium" | "hard"
  conceptIds?: string[]
  createdAt: Date
  answeredAt?: Date
}
