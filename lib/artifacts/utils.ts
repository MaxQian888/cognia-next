/**
 * Artifact utility functions
 * Centralized logic shared across artifact components, hooks, and detectors
 */

import type { ArtifactType } from "@/types"
import {
  MERMAID_KEYWORD_PATTERN,
  MERMAID_TYPE_NAMES,
  LANGUAGE_DISPLAY_NAMES,
  matchesTypePatterns,
} from "./constants"

/**
 * Localized strings used to build a default artifact title.
 *
 * Callers that have a translator available (React components via
 * `useTranslations("artifacts.defaultTitles")` and `("artifacts.mermaidTypes")`)
 * should build this object and pass it in, so that titles persisted to Dexie
 * reflect the user's current locale. Non-React callers (detectors, tests,
 * background tasks) can omit it and get the English fallbacks.
 */
export interface ArtifactTitleMessages {
  codeSnippet: string
  /** Format string for type=code with a language. Receives the resolved language display name. */
  codeWithLanguage: (language: string) => string
  document: string
  svgGraphic: string
  htmlPage: string
  reactComponent: string
  mermaidDiagram: string
  dataChart: string
  mathExpression: string
  jupyterNotebook: string
  untitled: string
  /** Map keyed by mermaid keyword (`flowchart`, `sequenceDiagram`, ...). */
  mermaidTypes: Partial<Record<string, string>>
}

const DEFAULT_TITLE_MESSAGES: ArtifactTitleMessages = {
  codeSnippet: "Code Snippet",
  codeWithLanguage: (language: string) => `${language} Code`,
  document: "Document",
  svgGraphic: "SVG Graphic",
  htmlPage: "HTML Page",
  reactComponent: "React Component",
  mermaidDiagram: "Mermaid Diagram",
  dataChart: "Data Chart",
  mathExpression: "Math Expression",
  jupyterNotebook: "Jupyter Notebook",
  untitled: "Untitled",
  mermaidTypes: MERMAID_TYPE_NAMES,
}

/**
 * Generate a title from artifact content
 * Merges best logic from all previous implementations:
 * - HTML <title> extraction (from artifact-detector)
 * - Mermaid diagram type detection (from use-artifact-detection)
 * - Function/component/export name extraction
 * - Language-based fallback naming
 *
 * Pass `messages` to localize the generated title at the user's current locale.
 */
export function generateArtifactTitle(
  content: string,
  type?: ArtifactType,
  language?: string,
  messages?: ArtifactTitleMessages
): string {
  const m = messages ?? DEFAULT_TITLE_MESSAGES

  // Try to extract HTML title
  const titleMatch = content.match(/<title>([^<]+)<\/title>/i)
  if (titleMatch) {
    return titleMatch[1]
  }

  // Try to extract export name (more specific, check first)
  const exportMatch = content.match(/export\s+(?:default\s+)?(?:function|const|class)\s+(\w+)/)
  if (exportMatch) {
    return exportMatch[1]
  }

  // Try to extract function/component/class name
  const functionMatch = content.match(/(?:function|const|class)\s+(\w+)/)
  if (functionMatch) {
    return functionMatch[1]
  }

  // For mermaid, try to extract diagram type
  if (type === "mermaid") {
    const mermaidMatch = content.match(MERMAID_KEYWORD_PATTERN)
    if (mermaidMatch) {
      const key = mermaidMatch[1]
      return m.mermaidTypes[key] ?? MERMAID_TYPE_NAMES[key] ?? m.mermaidDiagram
    }
    return m.mermaidDiagram
  }

  // Generate default title based on type
  if (type) {
    const typeNames: Record<ArtifactType, string> = {
      code: language
        ? m.codeWithLanguage(
            LANGUAGE_DISPLAY_NAMES[language.toLowerCase()] ||
              language.charAt(0).toUpperCase() + language.slice(1)
          )
        : m.codeSnippet,
      document: m.document,
      svg: m.svgGraphic,
      html: m.htmlPage,
      react: m.reactComponent,
      mermaid: m.mermaidDiagram,
      chart: m.dataChart,
      math: m.mathExpression,
      jupyter: m.jupyterNotebook,
    }
    return typeNames[type] || m.untitled
  }

  // Use language display name as fallback. Brand display names (e.g.
  // "JavaScript", "React (JSX)") are not localized; only the synthesized
  // "{language} Code" pattern goes through codeWithLanguage.
  if (language) {
    const displayName = LANGUAGE_DISPLAY_NAMES[language.toLowerCase()]
    if (displayName) return displayName
    const capitalized = language.charAt(0).toUpperCase() + language.slice(1)
    return m.codeWithLanguage(capitalized)
  }

  return m.codeSnippet
}

/**
 * Enhanced artifact type detection with additional pattern matching
 * Combines base detection from artifact-detector with centralized pattern matching
 * for edge cases (JSX/TSX → react, JSON chart data → chart)
 */
export function enhancedDetectArtifactType(
  baseType: ArtifactType,
  language?: string,
  content?: string
): ArtifactType {
  if (baseType === "code" && content) {
    const lang = language?.toLowerCase()
    if ((lang === "jsx" || lang === "tsx") && matchesTypePatterns(content, "react")) {
      return "react"
    }
    if (lang === "json" && matchesTypePatterns(content, "chart")) {
      return "chart"
    }
  }
  return baseType
}
