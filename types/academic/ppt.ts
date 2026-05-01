/**
 * Academic Paper-to-PPT Conversion Type Definitions
 * PPT generation options, sections, and results
 */

import type { Paper } from "./paper"
import type {
  PPTAudienceTone,
  PPTContentDensity,
  PPTGenerationBlueprint,
  PPTStyleKitId,
  PPTTemplateDirection,
} from "@/types/workflow"

// ============================================================================
// PPT Conversion Types
// ============================================================================

/**
 * Options for converting academic papers to presentations
 */
export interface PaperToPPTOptions {
  /** Papers to convert (single or multiple for comparison) */
  papers: Paper[]

  /** Presentation style */
  style: "academic" | "conference" | "seminar" | "thesis-defense" | "journal-club"

  /** Target slide count */
  slideCount?: number

  /** Target audience level */
  audienceLevel?: "expert" | "graduate" | "undergraduate" | "general"

  /** Language for the presentation */
  language?: string

  /** Include specific sections */
  includeSections?: PaperPPTSection[]

  /** Template-first direction for Canva-like generation */
  templateDirection?: PPTTemplateDirection

  /** Audience tone control used by generation prompts */
  audienceTone?: PPTAudienceTone

  /** Content density for slide brevity/detail tradeoff */
  contentDensity?: PPTContentDensity

  /** Style kit identifier for palette/typography consistency */
  styleKitId?: PPTStyleKitId

  /** Optional explicit generation blueprint override */
  generationBlueprint?: Partial<PPTGenerationBlueprint>

  /** Include AI-generated images */
  generateImages?: boolean

  /** Image style for generated images */
  imageStyle?: "diagram" | "illustration" | "minimalist" | "scientific"

  /** Include speaker notes */
  includeNotes?: boolean

  /** Include citations in slides */
  includeCitations?: boolean

  /** Include references slide */
  includeReferences?: boolean

  /** Custom instructions for AI */
  customInstructions?: string
}

/**
 * Sections that can be included in academic PPT
 */
export type PaperPPTSection =
  | "title"
  | "authors"
  | "abstract"
  | "introduction"
  | "background"
  | "related-work"
  | "methodology"
  | "experiments"
  | "results"
  | "discussion"
  | "limitations"
  | "future-work"
  | "conclusion"
  | "references"
  | "qa"

/**
 * Default sections for different presentation styles
 */
export const DEFAULT_PPT_SECTIONS: Record<PaperToPPTOptions["style"], PaperPPTSection[]> = {
  academic: [
    "title",
    "authors",
    "abstract",
    "introduction",
    "methodology",
    "results",
    "discussion",
    "conclusion",
    "references",
    "qa",
  ],
  conference: [
    "title",
    "authors",
    "introduction",
    "background",
    "methodology",
    "experiments",
    "results",
    "conclusion",
    "qa",
  ],
  seminar: [
    "title",
    "introduction",
    "background",
    "methodology",
    "results",
    "discussion",
    "future-work",
    "qa",
  ],
  "thesis-defense": [
    "title",
    "authors",
    "introduction",
    "related-work",
    "methodology",
    "experiments",
    "results",
    "discussion",
    "limitations",
    "future-work",
    "conclusion",
    "references",
    "qa",
  ],
  "journal-club": [
    "title",
    "authors",
    "abstract",
    "background",
    "methodology",
    "results",
    "limitations",
    "discussion",
    "qa",
  ],
}

/**
 * Result of paper to PPT conversion
 */
export interface PaperToPPTResult {
  success: boolean
  presentationId?: string
  outline?: PaperPPTOutlineItem[]
  error?: string
  warnings?: string[]
}

/**
 * Outline item for paper-based PPT
 */
export interface PaperPPTOutlineItem {
  id: string
  section: PaperPPTSection
  title: string
  keyPoints: string[]
  suggestedLayout: string
  imageNeeded: boolean
  imageSuggestion?: string
  citations?: string[]
  speakerNotes?: string
}
