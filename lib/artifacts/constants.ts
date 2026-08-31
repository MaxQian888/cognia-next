/**
 * Artifact Constants - Centralized constants for artifact types, icons, colors, and labels
 * This file eliminates duplicate definitions across components
 */

import type { ArtifactType, ArtifactLanguage } from "@/types"

/**
 * File extensions for each artifact type
 */
export const ARTIFACT_EXTENSIONS: Record<ArtifactType, string | ((language?: string) => string)> = {
  code: (language) => {
    const extMap: Record<string, string> = {
      javascript: "js",
      typescript: "ts",
      python: "py",
      html: "html",
      css: "css",
      json: "json",
      markdown: "md",
      jsx: "jsx",
      tsx: "tsx",
      sql: "sql",
      bash: "sh",
      yaml: "yaml",
      xml: "xml",
    }
    return extMap[language || ""] || "txt"
  },
  document: "md",
  svg: "svg",
  html: "html",
  react: "tsx",
  mermaid: "mmd",
  chart: "json",
  math: "tex",
  jupyter: "ipynb",
}

/**
 * Get file extension for an artifact
 */
export function getArtifactExtension(type: ArtifactType, language?: string): string {
  const ext = ARTIFACT_EXTENSIONS[type]
  if (typeof ext === "function") {
    return ext(language)
  }
  return ext
}

/**
 * Color schemes for each artifact type (Tailwind classes)
 */
export const ARTIFACT_COLORS: Record<ArtifactType, string> = {
  code: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  document: "bg-green-500/10 text-green-600 dark:text-green-400",
  svg: "bg-purple-500/10 text-purple-600 dark:text-purple-400",
  html: "bg-orange-500/10 text-orange-600 dark:text-orange-400",
  react: "bg-cyan-500/10 text-cyan-600 dark:text-cyan-400",
  mermaid: "bg-pink-500/10 text-pink-600 dark:text-pink-400",
  chart: "bg-yellow-500/10 text-yellow-600 dark:text-yellow-400",
  math: "bg-red-500/10 text-red-600 dark:text-red-400",
  jupyter: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
}

/**
 * All artifact types as an array (single source of truth)
 */
export const ARTIFACT_TYPES: ArtifactType[] = [
  "code",
  "document",
  "svg",
  "html",
  "react",
  "mermaid",
  "chart",
  "math",
  "jupyter",
]

/**
 * Types whose content is something the user can execute or run a live preview
 * of, as opposed to read.
 *
 * Drives both the Context Workbench `run` capability and the "Runnable" badge.
 * Kept in one place because it was previously inlined at the capability site
 * while the badge read a per-artifact `metadata.runnable` override that nothing
 * ever wrote — so the badge never appeared and the two could not disagree only
 * because one of them never fired.
 */
export const RUNNABLE_ARTIFACT_TYPES: readonly ArtifactType[] = ["code", "html", "react", "jupyter"]

export function isRunnableArtifactType(type: ArtifactType): boolean {
  return RUNNABLE_ARTIFACT_TYPES.includes(type)
}

/**
 * i18n keys for artifact type labels
 */
export const ARTIFACT_TYPE_KEYS: Record<ArtifactType, string> = {
  code: "code",
  document: "document",
  svg: "svg",
  html: "html",
  react: "react",
  mermaid: "mermaid",
  chart: "chart",
  math: "math",
  jupyter: "jupyter",
}

/**
 * Language to ArtifactLanguage mapping
 */
export const LANGUAGE_MAP: Record<string, ArtifactLanguage> = {
  js: "javascript",
  javascript: "javascript",
  ts: "typescript",
  typescript: "typescript",
  py: "python",
  python: "python",
  html: "html",
  css: "css",
  json: "json",
  md: "markdown",
  markdown: "markdown",
  jsx: "jsx",
  tsx: "tsx",
  sql: "sql",
  sh: "bash",
  bash: "bash",
  shell: "bash",
  yml: "yaml",
  yaml: "yaml",
  xml: "xml",
  svg: "svg",
  mermaid: "mermaid",
  latex: "latex",
  tex: "latex",
  ipynb: "json",
}

/**
 * Map language string to ArtifactLanguage
 */
export function mapToArtifactLanguage(language?: string): ArtifactLanguage | undefined {
  if (!language) return undefined
  return LANGUAGE_MAP[language.toLowerCase()]
}

/**
 * Language to Shiki language mapping for syntax highlighting
 */
export const SHIKI_LANGUAGE_MAP: Record<string, string> = {
  javascript: "javascript",
  typescript: "typescript",
  python: "python",
  html: "html",
  css: "css",
  json: "json",
  markdown: "markdown",
  jsx: "jsx",
  tsx: "tsx",
  sql: "sql",
  bash: "bash",
  yaml: "yaml",
  xml: "xml",
  svg: "xml",
  mermaid: "markdown",
  latex: "latex",
}

/**
 * Get Shiki language for syntax highlighting
 */
export function getShikiLanguage(language?: string): string {
  return SHIKI_LANGUAGE_MAP[language || ""] || "text"
}

/**
 * Language to Monaco editor language mapping
 */
export const MONACO_LANGUAGE_MAP: Record<string, string> = {
  javascript: "javascript",
  typescript: "typescript",
  python: "python",
  html: "html",
  css: "css",
  json: "json",
  markdown: "markdown",
  jsx: "javascript",
  tsx: "typescript",
  sql: "sql",
  bash: "shell",
  yaml: "yaml",
  xml: "xml",
  svg: "xml",
  mermaid: "markdown",
  latex: "latex",
}

/**
 * Get Monaco editor language
 */
export function getMonacoLanguage(language?: string): string {
  return MONACO_LANGUAGE_MAP[language || ""] || "plaintext"
}

/**
 * Types that support live preview
 */
export const PREVIEWABLE_TYPES: ArtifactType[] = [
  "html",
  "react",
  "svg",
  "mermaid",
  "chart",
  "math",
  "document",
  "jupyter",
]

/**
 * Types that support designer/visual editing
 */
export const DESIGNABLE_TYPES: ArtifactType[] = ["html", "react", "svg"]

/**
 * Types that should always auto-create regardless of line count
 */
export const ALWAYS_CREATE_TYPES: ArtifactType[] = [
  "html",
  "react",
  "svg",
  "mermaid",
  "chart",
  "jupyter",
]

/**
 * Check if artifact type supports preview
 */
export function canPreview(type: ArtifactType): boolean {
  return PREVIEWABLE_TYPES.includes(type)
}

/**
 * Check if artifact type supports designer
 */
export function canDesign(type: ArtifactType): boolean {
  return DESIGNABLE_TYPES.includes(type)
}

/**
 * Detection patterns for various artifact types
 */
export const DETECTION_PATTERNS = {
  html: [/<!DOCTYPE\s+html/i, /<html[\s>]/i, /<head[\s>]/i, /<body[\s>]/i],
  react: [
    /import\s+(?:React|{[^}]*})\s+from\s+['"]react['"]/,
    /export\s+(?:default\s+)?function\s+\w+\s*\([^)]*\)\s*{[\s\S]*?return\s*[\s(<]/,
    /export\s+(?:default\s+)?const\s+\w+\s*=\s*\([^)]*\)\s*=>\s*(?:\(|{|<)/,
    /const\s+\w+\s*=\s*\(\)\s*=>\s*(?:\(|{|<)[\s\S]*?<\w+/,
    /function\s+\w+\s*\([^)]*\)\s*{\s*return\s+<\w+/,
    /<[A-Z]\w*[\s/>]/,
  ],
  svg: [/<svg[\s>]/i, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/],
  mermaid: [
    /^(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram|erDiagram|journey|gantt|pie|gitGraph)/m,
  ],
  chart: [
    /\[\s*{\s*"name"\s*:\s*"[^"]+"\s*,\s*"value"\s*:/,
    /{\s*"type"\s*:\s*"(line|bar|pie|doughnut|area|scatter|radar)"/,
    /{\s*"data"\s*:\s*\[/,
  ],
  math: [
    /\$\$[\s\S]+?\$\$/,
    /\\begin\{(equation|align|matrix|bmatrix|pmatrix)/,
    /\\frac\{/,
    /\\sum_/,
    /\\int_/,
  ],
  jupyter: [/"cells"\s*:\s*\[/, /"cell_type"\s*:\s*"(code|markdown)"/, /"nbformat"\s*:/],
}

/**
 * Check if content matches patterns for a specific type
 */
export function matchesTypePatterns(
  content: string,
  type: keyof typeof DETECTION_PATTERNS
): boolean {
  const patterns = DETECTION_PATTERNS[type]
  return patterns?.some((p) => p.test(content)) ?? false
}

/**
 * Mermaid diagram type names (English fallback used by non-React callers)
 */
export const MERMAID_TYPE_NAMES: Record<string, string> = {
  graph: "Flowchart",
  flowchart: "Flowchart",
  sequenceDiagram: "Sequence Diagram",
  classDiagram: "Class Diagram",
  stateDiagram: "State Diagram",
  erDiagram: "ER Diagram",
  gantt: "Gantt Chart",
  pie: "Pie Chart",
  mindmap: "Mind Map",
  gitGraph: "Git Graph",
  journey: "User Journey",
}

/**
 * i18n keys for mermaid diagram types (under `artifacts.mermaidTypes.*`).
 * Maps the regex-matched mermaid keyword to the i18n leaf key.
 */
export const MERMAID_TYPE_I18N_KEYS: Record<string, string> = {
  graph: "flowchart",
  flowchart: "flowchart",
  sequenceDiagram: "sequenceDiagram",
  classDiagram: "classDiagram",
  stateDiagram: "stateDiagram",
  erDiagram: "erDiagram",
  gantt: "gantt",
  pie: "pie",
  mindmap: "mindmap",
  gitGraph: "gitGraph",
  journey: "journey",
}

/**
 * Language display names
 */
export const LANGUAGE_DISPLAY_NAMES: Record<string, string> = {
  javascript: "JavaScript",
  typescript: "TypeScript",
  python: "Python",
  html: "HTML",
  css: "CSS",
  json: "JSON",
  jsx: "React (JSX)",
  tsx: "React (TSX)",
  sql: "SQL",
  bash: "Shell",
  yaml: "YAML",
  xml: "XML",
  markdown: "Markdown",
  latex: "LaTeX",
  mermaid: "Mermaid",
  svg: "SVG",
}

/**
 * Get display name for a language
 */
export function getLanguageDisplayName(language?: string): string {
  if (!language) return "Code"
  return (
    LANGUAGE_DISPLAY_NAMES[language.toLowerCase()] ||
    language.charAt(0).toUpperCase() + language.slice(1)
  )
}

/**
 * i18n keys for artifact type labels (used in 'artifacts' namespace)
 * Maps to keys like artifacts.typeCode, artifacts.typeDocument, etc.
 */
export const ARTIFACT_I18N_TYPE_KEYS: Record<ArtifactType, string> = {
  code: "typeCode",
  document: "typeDocument",
  svg: "typeSvg",
  html: "typeHtml",
  react: "typeReact",
  mermaid: "typeMermaid",
  chart: "typeChart",
  math: "typeMath",
  jupyter: "typeJupyter",
}

/**
 * Chart color palette for recharts-based chart rendering
 */
export const CHART_COLORS = [
  "#8884d8",
  "#82ca9d",
  "#ffc658",
  "#ff7300",
  "#0088fe",
  "#00C49F",
  "#FFBB28",
  "#FF8042",
]

/**
 * How much content an artifact card in the chat transcript will render
 * unprompted. Mirrors `MERMAID_AUTO_RENDER_MAX_CHARS` and exists for the same
 * reason: a transcript full of open artifact cards mounts one live iframe each
 * at first paint, and a large document is the expensive one.
 */
export const ARTIFACT_AUTO_PREVIEW_MAX_CHARS = 24_000
