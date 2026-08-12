/**
 * Artifact Detector - Automatically detect and extract artifact-worthy content from AI responses
 * Similar to OpenAI Canvas auto-triggering behavior
 */

import type { ArtifactType, ArtifactLanguage, ArtifactRendererProfile } from "@/types"
import { LANGUAGE_MAP, ALWAYS_CREATE_TYPES, generateArtifactTitle } from "@/lib/artifacts"

// Configuration for auto-detection
export interface ArtifactDetectionConfig {
  /** Minimum lines for auto-trigger (default: 10) */
  minLines: number
  /** Whether to auto-create artifacts */
  autoCreate: boolean
  /** Content types to auto-detect */
  enabledTypes: ArtifactType[]
}

export const DEFAULT_DETECTION_CONFIG: ArtifactDetectionConfig = {
  minLines: 10,
  autoCreate: true,
  enabledTypes: ["code", "html", "react", "svg", "mermaid", "chart", "math", "document", "jupyter"],
}

// Detected artifact from content
export interface DetectedArtifact {
  type: ArtifactType
  language?: ArtifactLanguage
  rendererProfile?: ArtifactRendererProfile
  content: string
  title: string
  startIndex: number
  endIndex: number
  lineCount: number
  confidence: number // 0-1, higher means more confident in detection
}

// Code block regex - matches ```language\n...\n```
const CODE_BLOCK_REGEX = /```(\w+)?\n([\s\S]*?)```/g

// HTML detection patterns
const HTML_PATTERNS = [/<!DOCTYPE\s+html/i, /<html[\s>]/i, /<head[\s>]/i, /<body[\s>]/i]

const DIAGRAM_DESIGN_RENDERER_MARKER =
  /<meta\b(?=[^>]*\bname\s*=\s*["']cognia-renderer["'])(?=[^>]*\bcontent\s*=\s*["']diagram-design-v1["'])[^>]*>/i

// React/JSX detection patterns
const REACT_PATTERNS = [
  /import\s+(?:React|{[^}]*})\s+from\s+['"]react['"]/,
  /export\s+(?:default\s+)?function\s+\w+\s*\([^)]*\)\s*{[\s\S]*?return\s*\(/,
  /export\s+(?:default\s+)?const\s+\w+\s*=\s*\([^)]*\)\s*=>\s*(?:\(|{)/,
  /const\s+\w+\s*=\s*\(\)\s*=>\s*(?:\(|{)[\s\S]*?<\w+/,
  /<[A-Z]\w*[\s/>]/, // JSX component usage like <Component
]

// SVG detection patterns
const SVG_PATTERNS = [/<svg[\s>]/i, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/]

// Mermaid detection patterns
const MERMAID_PATTERNS = [
  /^(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram|erDiagram|journey|gantt|pie|gitGraph)/m,
]

// Chart data patterns (JSON with data arrays)
const CHART_PATTERNS = [
  /\[\s*{\s*"name"\s*:\s*"[^"]+"\s*,\s*"value"\s*:/,
  /{\s*"type"\s*:\s*"(line|bar|pie|area|scatter|radar)"/,
  /{\s*"data"\s*:\s*\[/,
]

// Math/LaTeX patterns
const MATH_PATTERNS = [
  /\$\$[\s\S]+?\$\$/,
  /\\begin\{(equation|align|matrix|bmatrix|pmatrix)/,
  /\\frac\{/,
  /\\sum_/,
  /\\int_/,
]

// Jupyter notebook patterns
const JUPYTER_PATTERNS = [
  /"cells"\s*:\s*\[/,
  /"cell_type"\s*:\s*"(code|markdown)"/,
  /"nbformat"\s*:/,
]

/**
 * Detect artifact type from content
 */
export function detectArtifactType(
  content: string,
  language?: string
): { type: ArtifactType; confidence: number } {
  // Check for Jupyter notebook first (JSON structure)
  if (JUPYTER_PATTERNS.some((p) => p.test(content))) {
    return { type: "jupyter", confidence: 0.95 }
  }

  // Check for mermaid diagrams
  if (language === "mermaid" || MERMAID_PATTERNS.some((p) => p.test(content))) {
    return { type: "mermaid", confidence: 0.9 }
  }

  // Check for math/LaTeX
  if (language === "latex" || language === "tex" || MATH_PATTERNS.some((p) => p.test(content))) {
    return { type: "math", confidence: 0.85 }
  }

  // A fenced HTML document can legitimately contain inline SVG. Honor the
  // explicit language before applying content-based SVG detection.
  if (language === "html") {
    return { type: "html", confidence: 0.9 }
  }

  // Check for SVG
  if (language === "svg" || SVG_PATTERNS.some((p) => p.test(content))) {
    return { type: "svg", confidence: 0.9 }
  }

  // Check for React/JSX (before HTML as React can contain HTML-like syntax)
  if (language === "jsx" || language === "tsx" || REACT_PATTERNS.some((p) => p.test(content))) {
    return { type: "react", confidence: 0.85 }
  }

  // Check for HTML
  if (language === "html" || HTML_PATTERNS.some((p) => p.test(content))) {
    return { type: "html", confidence: 0.9 }
  }

  // Check for chart data
  if (CHART_PATTERNS.some((p) => p.test(content))) {
    return { type: "chart", confidence: 0.8 }
  }

  // Check for markdown documents
  if (language === "markdown" || language === "md") {
    return { type: "document", confidence: 0.85 }
  }

  // Default to code for other languages
  return { type: "code", confidence: 0.7 }
}

export function detectArtifactRendererProfile(
  content: string
): ArtifactRendererProfile | undefined {
  return DIAGRAM_DESIGN_RENDERER_MARKER.test(content) ? "diagram-design-v1" : undefined
}

/**
 * Extract code blocks from markdown content
 */
export function extractCodeBlocks(content: string): Array<{
  language: string
  code: string
  startIndex: number
  endIndex: number
}> {
  const blocks: Array<{
    language: string
    code: string
    startIndex: number
    endIndex: number
  }> = []

  let match
  const regex = new RegExp(CODE_BLOCK_REGEX.source, "g")

  while ((match = regex.exec(content)) !== null) {
    blocks.push({
      language: match[1] || "",
      code: match[2].trim(),
      startIndex: match.index,
      endIndex: match.index + match[0].length,
    })
  }

  return blocks
}

/**
 * Generate a title from content
 * Delegates to centralized generateArtifactTitle from lib/artifacts
 */
export const generateTitle = generateArtifactTitle

/**
 * Count lines in content
 */
function countLines(content: string): number {
  return content.split("\n").length
}

/**
 * Check if content should trigger auto-creation
 */
export function shouldAutoCreate(
  content: string,
  type: ArtifactType,
  config: ArtifactDetectionConfig = DEFAULT_DETECTION_CONFIG
): boolean {
  if (!config.autoCreate) return false
  if (!config.enabledTypes.includes(type)) return false

  const lineCount = countLines(content)

  // Always auto-create for specific types regardless of line count
  if (ALWAYS_CREATE_TYPES.includes(type)) {
    return lineCount >= 3 // At least 3 lines for these types
  }

  // For code and documents, use the configured threshold
  return lineCount >= config.minLines
}

/**
 * Parse AI response and detect artifacts
 */
export function detectArtifacts(
  responseContent: string,
  config: ArtifactDetectionConfig = DEFAULT_DETECTION_CONFIG
): DetectedArtifact[] {
  const artifacts: DetectedArtifact[] = []
  const codeBlocks = extractCodeBlocks(responseContent)

  for (const block of codeBlocks) {
    const { type, confidence } = detectArtifactType(block.code, block.language)
    const language =
      LANGUAGE_MAP[block.language.toLowerCase()] || (block.language as ArtifactLanguage)
    const lineCount = countLines(block.code)

    if (shouldAutoCreate(block.code, type, config)) {
      artifacts.push({
        type,
        language,
        rendererProfile: type === "html" ? detectArtifactRendererProfile(block.code) : undefined,
        content: block.code,
        title: generateTitle(block.code, type, block.language),
        startIndex: block.startIndex,
        endIndex: block.endIndex,
        lineCount,
        confidence,
      })
    }
  }

  // Also check for inline content that might be artifacts (not in code blocks)
  // Check for standalone math expressions
  const mathMatches = responseContent.matchAll(/\$\$([\s\S]+?)\$\$/g)
  for (const match of mathMatches) {
    if (match[1].split("\n").length >= 3) {
      artifacts.push({
        type: "math",
        content: match[1].trim(),
        title: "Math Expression",
        startIndex: match.index!,
        endIndex: match.index! + match[0].length,
        lineCount: countLines(match[1]),
        confidence: 0.85,
      })
    }
  }

  return artifacts
}

/** A code block that is still being written in a streaming response. */
export interface StreamingArtifact {
  type: ArtifactType
  language?: ArtifactLanguage
  title: string
  lineCount: number
}

/**
 * The trailing fence that has been opened but not yet closed, if any. Every
 * completed block is dropped first so only an unterminated fence can match.
 */
function findOpenCodeBlock(content: string): { language: string; code: string } | null {
  const remainder = content.replace(new RegExp(CODE_BLOCK_REGEX.source, "g"), "")
  const match = /```(\w+)?\n([\s\S]*)$/.exec(remainder)
  return match ? { language: match[1] || "", code: match[2] } : null
}

/**
 * Detect the artifact an assistant turn is part-way through writing.
 *
 * `detectArtifacts` only ever matches *closed* fences, and auto-creation runs
 * when the turn seals — so nothing exists in the artifact store while the model
 * is mid-block, which is why a finished artifact appears to pop in from
 * nowhere. This reports the still-open fence instead, and only once it already
 * clears the same `shouldAutoCreate` bar the sealed block will have to clear,
 * so the UI never promises an artifact that is never going to arrive.
 */
export function detectStreamingArtifact(
  responseContent: string,
  config: ArtifactDetectionConfig = DEFAULT_DETECTION_CONFIG
): StreamingArtifact | null {
  const open = findOpenCodeBlock(responseContent)
  if (!open) return null
  const code = open.code.trim()
  if (!code) return null

  const { type } = detectArtifactType(code, open.language)
  if (!shouldAutoCreate(code, type, config)) return null

  return {
    type,
    language: LANGUAGE_MAP[open.language.toLowerCase()] || (open.language as ArtifactLanguage),
    title: generateTitle(code, type, open.language),
    lineCount: countLines(code),
  }
}

/**
 * Get the best artifact from a list (highest confidence, longest content)
 */
export function getBestArtifact(artifacts: DetectedArtifact[]): DetectedArtifact | null {
  if (artifacts.length === 0) return null

  return artifacts.reduce((best, current) => {
    // Prioritize by confidence, then by line count
    const bestScore = best.confidence * 100 + best.lineCount
    const currentScore = current.confidence * 100 + current.lineCount
    return currentScore > bestScore ? current : best
  })
}

/**
 * Check if content looks like a complete, standalone artifact
 */
export function isCompleteArtifact(content: string, type: ArtifactType): boolean {
  switch (type) {
    case "html":
      return HTML_PATTERNS[0].test(content) || HTML_PATTERNS[1].test(content)
    case "react":
      return /export\s+(default\s+)?/.test(content)
    case "svg":
      return content.includes("<svg") && content.includes("</svg>")
    case "mermaid":
      return MERMAID_PATTERNS.some((p) => p.test(content))
    case "jupyter":
      return content.includes('"cells"') && content.includes('"nbformat"')
    default:
      return true
  }
}

const artifactDetector = {
  detectArtifacts,
  detectArtifactType,
  extractCodeBlocks,
  generateTitle,
  shouldAutoCreate,
  getBestArtifact,
  isCompleteArtifact,
  DEFAULT_DETECTION_CONFIG,
}

export default artifactDetector
