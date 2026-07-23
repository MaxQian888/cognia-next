/**
 * Markdown Parser - Extract content and structure from Markdown files
 * Enhanced with task lists, math blocks, footnotes, and admonitions
 */

import { getDocumentLogger } from "../runtime-adapters"

const log = getDocumentLogger()

export interface MarkdownSection {
  level: number
  title: string
  content: string
  startLine: number
  endLine: number
}

export interface MarkdownParseResult {
  title?: string
  content: string
  sections: MarkdownSection[]
  frontmatter?: Record<string, unknown>
  links: { text: string; url: string }[]
  codeBlocks: { language: string; code: string }[]
  images: { alt: string; url: string }[]
  taskLists: TaskItem[]
  mathBlocks: MathBlock[]
  footnotes: Footnote[]
  admonitions: Admonition[]
}

export interface TaskItem {
  text: string
  checked: boolean
  line: number
}

export interface MathBlock {
  content: string
  displayMode: boolean
  line: number
}

export interface Footnote {
  id: string
  content: string
}

export type AdmonitionType =
  "note" | "tip" | "warning" | "caution" | "important" | "info" | "danger" | "abstract"

export interface Admonition {
  type: AdmonitionType
  title?: string
  content: string
}

type YamlParser = ((source: string) => unknown) | null | undefined
let cachedYamlParser: YamlParser

function tryParseYaml(frontmatterStr: string): Record<string, unknown> | null {
  if (cachedYamlParser === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const yamlModule = require("yaml")
      cachedYamlParser = (yamlModule.parse ?? yamlModule.default?.parse) as
        ((source: string) => unknown) | null
    } catch (error) {
      log.warn("Failed to load YAML parser, falling back to lightweight parser", { error })
      cachedYamlParser = null
    }
  }

  if (typeof cachedYamlParser === "function") {
    try {
      const parsed = cachedYamlParser(frontmatterStr)
      if (parsed && typeof parsed === "object") {
        return parsed as Record<string, unknown>
      }
    } catch (error) {
      log.warn("YAML parsing failed, falling back to lightweight parser", { error })
      // Fall through to the lightweight parser
    }
  }

  return null
}

/**
 * Parse frontmatter from markdown
 */
function parseFrontmatter(content: string): {
  frontmatter?: Record<string, unknown>
  body: string
} {
  const frontmatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n/
  const match = content.match(frontmatterRegex)

  if (!match) {
    return { body: content }
  }

  try {
    const frontmatterStr = match[1]
    const yamlResult = tryParseYaml(frontmatterStr)
    if (yamlResult) {
      return {
        frontmatter: yamlResult,
        body: content.slice(match[0].length),
      }
    }

    const frontmatter: Record<string, unknown> = {}
    const lines = frontmatterStr.split("\n")
    let currentKey: string | null = null

    const parseScalar = (raw: string): unknown => {
      const value = raw.trim()
      if (
        (value.startsWith("[") && value.endsWith("]")) ||
        (value.startsWith("{") && value.endsWith("}"))
      ) {
        try {
          return JSON.parse(value)
        } catch (error) {
          log.warn("JSON parsing failed for frontmatter value", { error })
          return value
        }
      }
      if (value === "true") return true
      if (value === "false") return false
      if (!Number.isNaN(Number(value)) && value !== "") return Number(value)
      return value
    }

    for (const rawLine of lines) {
      const line = rawLine.trimEnd()
      if (!line.trim()) continue

      const listItemMatch = line.match(/^[-]\s+(.*)$/)
      if (listItemMatch && currentKey) {
        const existing = frontmatter[currentKey]
        const parsedItem = parseScalar(listItemMatch[1])
        if (Array.isArray(existing)) {
          existing.push(parsedItem)
        } else if (existing === undefined) {
          frontmatter[currentKey] = [parsedItem]
        }
        continue
      }

      const keyMatch = line.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/)
      if (keyMatch) {
        const [, key, rawValue] = keyMatch
        currentKey = key
        const parsedValue = rawValue ? parseScalar(rawValue) : []
        frontmatter[key] = parsedValue
        continue
      }

      if (currentKey && rawLine.startsWith(" ")) {
        const existing = frontmatter[currentKey]
        if (typeof existing === "string") {
          frontmatter[currentKey] = `${existing}\n${line.trim()}`
        }
      }
    }

    return {
      frontmatter,
      body: content.slice(match[0].length),
    }
  } catch (error) {
    log.warn("Frontmatter extraction failed", { error })
    return { body: content }
  }
}

/**
 * Extract sections from markdown
 */
function extractSections(content: string): MarkdownSection[] {
  const lines = content.split("\n")
  const sections: MarkdownSection[] = []
  let currentSection: MarkdownSection | null = null
  let contentLines: string[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/)

    if (headingMatch) {
      // Save previous section
      if (currentSection) {
        currentSection.content = contentLines.join("\n").trim()
        currentSection.endLine = i - 1
        sections.push(currentSection)
      }

      // Start new section
      currentSection = {
        level: headingMatch[1].length,
        title: headingMatch[2].trim(),
        content: "",
        startLine: i,
        endLine: i,
      }
      contentLines = []
    } else if (currentSection) {
      contentLines.push(line)
    }
  }

  // Save last section
  if (currentSection) {
    currentSection.content = contentLines.join("\n").trim()
    currentSection.endLine = lines.length - 1
    sections.push(currentSection)
  }

  return sections
}

/**
 * Extract links from markdown
 */
function extractLinks(content: string): { text: string; url: string }[] {
  const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g
  const links: { text: string; url: string }[] = []
  let match

  while ((match = linkRegex.exec(content)) !== null) {
    links.push({
      text: match[1],
      url: match[2],
    })
  }

  return links
}

/**
 * Extract code blocks from markdown
 */
function extractCodeBlocks(content: string): { language: string; code: string }[] {
  const codeBlockRegex = /```(\w*)\n([\s\S]*?)```/g
  const codeBlocks: { language: string; code: string }[] = []
  let match

  while ((match = codeBlockRegex.exec(content)) !== null) {
    codeBlocks.push({
      language: match[1] || "text",
      code: match[2].trim(),
    })
  }

  return codeBlocks
}

/**
 * Extract images from markdown
 */
function extractImages(content: string): { alt: string; url: string }[] {
  const imageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g
  const images: { alt: string; url: string }[] = []
  let match

  while ((match = imageRegex.exec(content)) !== null) {
    images.push({
      alt: match[1],
      url: match[2],
    })
  }

  return images
}

/**
 * Get title from markdown (first h1 or frontmatter title)
 */
function extractTitle(content: string, frontmatter?: Record<string, unknown>): string | undefined {
  if (frontmatter?.title && typeof frontmatter.title === "string") {
    return frontmatter.title
  }

  const h1Match = content.match(/^#\s+(.+)$/m)
  return h1Match ? h1Match[1].trim() : undefined
}

/**
 * Parse markdown content
 */
export function parseMarkdown(content: string): MarkdownParseResult {
  const { frontmatter, body } = parseFrontmatter(content)
  const sections = extractSections(body)
  const links = extractLinks(body)
  const codeBlocks = extractCodeBlocks(body)
  const images = extractImages(body)
  const title = extractTitle(body, frontmatter)
  const taskLists = extractTaskLists(body)
  const mathBlocks = extractMathBlocks(body)
  const footnotes = extractFootnotes(body)
  const admonitions = extractAdmonitions(body)

  return {
    title,
    content: body,
    sections,
    frontmatter,
    links,
    codeBlocks,
    images,
    taskLists,
    mathBlocks,
    footnotes,
    admonitions,
  }
}

/**
 * Extract task list items (- [ ] and - [x]) from markdown
 */
export function extractTaskLists(content: string): TaskItem[] {
  const taskItems: TaskItem[] = []
  const lines = content.split("\n")

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^\s*[-*+]\s+\[([ xX])\]\s+(.+)$/)
    if (match) {
      taskItems.push({
        text: match[2].trim(),
        checked: match[1].toLowerCase() === "x",
        line: i + 1,
      })
    }
  }

  return taskItems
}

/**
 * Extract math/LaTeX blocks from markdown
 * Supports both inline ($...$) and display ($$...$$) math
 */
export function extractMathBlocks(content: string): MathBlock[] {
  const mathBlocks: MathBlock[] = []
  const lines = content.split("\n")

  // Extract display math blocks ($$...$$)
  const displayRegex = /\$\$([\s\S]*?)\$\$/g
  let match
  while ((match = displayRegex.exec(content)) !== null) {
    const lineNumber = content.substring(0, match.index).split("\n").length
    const mathContent = match[1].trim()
    if (mathContent) {
      mathBlocks.push({
        content: mathContent,
        displayMode: true,
        line: lineNumber,
      })
    }
  }

  // Extract inline math ($...$) — avoid matching $$
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // Skip lines that are part of display math or code blocks
    if (line.trim().startsWith("$$") || line.trim().startsWith("```")) continue

    const inlineRegex = /(?<!\$)\$(?!\$)([^$\n]+?)(?<!\$)\$(?!\$)/g
    let inlineMatch
    while ((inlineMatch = inlineRegex.exec(line)) !== null) {
      const mathContent = inlineMatch[1].trim()
      // Skip currency-like patterns (e.g., $10, $1.50)
      if (/^\d/.test(mathContent)) continue
      if (mathContent) {
        mathBlocks.push({
          content: mathContent,
          displayMode: false,
          line: i + 1,
        })
      }
    }
  }

  return mathBlocks
}

/**
 * Extract footnotes from markdown ([^id]: content)
 */
export function extractFootnotes(content: string): Footnote[] {
  const footnotes: Footnote[] = []
  const footnoteRegex = /^\[\^([^\]]+)\]:\s*(.+)$/gm
  let match

  while ((match = footnoteRegex.exec(content)) !== null) {
    footnotes.push({
      id: match[1],
      content: match[2].trim(),
    })
  }

  return footnotes
}

/**
 * Extract admonitions/callouts from markdown
 * Supports GitHub-style: > [!NOTE], > [!TIP], > [!WARNING], etc.
 * Also supports common variants: > **Note:**, > **Warning:**, etc.
 */
export function extractAdmonitions(content: string): Admonition[] {
  const admonitions: Admonition[] = []
  const lines = content.split("\n")
  const validTypes: AdmonitionType[] = [
    "note",
    "tip",
    "warning",
    "caution",
    "important",
    "info",
    "danger",
    "abstract",
  ]

  let i = 0
  while (i < lines.length) {
    const line = lines[i]

    // GitHub-style: > [!NOTE] or > [!TIP] Title
    const ghMatch = line.match(/^>\s*\[!([A-Z]+)\]\s*(.*)$/i)
    if (ghMatch) {
      const typeStr = ghMatch[1].toLowerCase()
      if (validTypes.includes(typeStr as AdmonitionType)) {
        const title = ghMatch[2].trim() || undefined
        const contentLines: string[] = []

        // Collect continuation lines
        let j = i + 1
        while (j < lines.length && lines[j].match(/^>\s?/)) {
          contentLines.push(lines[j].replace(/^>\s?/, ""))
          j++
        }

        admonitions.push({
          type: typeStr as AdmonitionType,
          title,
          content: contentLines.join("\n").trim(),
        })

        i = j
        continue
      }
    }

    // Common variant: > **Note:** or > **Warning:**
    const boldMatch = line.match(/^>\s*\*\*([A-Za-z]+):?\*\*\s*(.*)$/i)
    if (boldMatch) {
      const typeStr = boldMatch[1].toLowerCase()
      if (validTypes.includes(typeStr as AdmonitionType)) {
        const firstLine = boldMatch[2].trim()
        const contentLines: string[] = []
        if (firstLine) contentLines.push(firstLine)

        let j = i + 1
        while (j < lines.length && lines[j].match(/^>\s?/)) {
          contentLines.push(lines[j].replace(/^>\s?/, ""))
          j++
        }

        admonitions.push({
          type: typeStr as AdmonitionType,
          content: contentLines.join("\n").trim(),
        })

        i = j
        continue
      }
    }

    i++
  }

  return admonitions
}

/**
 * Convert markdown to plain text (remove formatting)
 */
export function markdownToPlainText(content: string): string {
  return (
    content
      // Remove code blocks
      .replace(/```[\s\S]*?```/g, "")
      // Remove inline code
      .replace(/`[^`]+`/g, "")
      // Remove images
      .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
      // Convert links to just text
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      // Remove headers markers
      .replace(/^#{1,6}\s+/gm, "")
      // Remove bold/italic
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/\*([^*]+)\*/g, "$1")
      .replace(/__([^_]+)__/g, "$1")
      .replace(/_([^_]+)_/g, "$1")
      // Remove blockquotes
      .replace(/^>\s+/gm, "")
      // Remove horizontal rules
      .replace(/^[-*_]{3,}$/gm, "")
      // Remove list markers
      .replace(/^[\s]*[-*+]\s+/gm, "")
      .replace(/^[\s]*\d+\.\s+/gm, "")
      // Clean up whitespace
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  )
}

/**
 * Extract text content suitable for embedding
 */
export function extractEmbeddableContent(content: string): string {
  const { body } = parseFrontmatter(content)
  return markdownToPlainText(body)
}
