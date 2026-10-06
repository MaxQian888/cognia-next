/** Canonical navigation ranges reuse parser output rather than embedding projections. */
import type {
  DocumentPageRange,
  DocumentSection,
  DocumentStructure,
  MarkdownParseResult,
  PDFParseResult,
  PDFOutlineItem,
} from "./types"
import { parseMarkdown } from "./parsers/markdown-parser"

/** Deterministic version identity, compatible with project knowledge change detection. */
export function documentContentHash(text: string): string {
  let hash = 5381
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0
  return `${(hash >>> 0).toString(36)}_${text.length.toString(36)}`
}

export function buildDocumentStructure(input: {
  content: string
  title?: string
  markdown?: MarkdownParseResult
  pdf?: PDFParseResult
  pages?: DocumentPageRange[]
}): DocumentStructure {
  const { content } = input
  const lineOffsets = [0]
  for (let i = 0; i < content.length; i++) if (content[i] === "\n") lineOffsets.push(i + 1)
  const lineAt = (offset: number) => {
    let low = 0
    let high = lineOffsets.length
    while (low < high) {
      const mid = (low + high) >>> 1
      if (lineOffsets[mid] <= offset) low = mid + 1
      else high = mid
    }
    return Math.max(1, low)
  }
  const pages: DocumentPageRange[] = input.pages ? input.pages.map((page) => ({ ...page })) : []
  if (input.pdf && !input.pages) {
    let cursor = 0
    for (const page of input.pdf.pages) {
      const start = content.indexOf(page.text, cursor)
      if (start < 0) continue
      const end = start + page.text.length
      pages.push({
        pageNumber: page.pageNumber,
        charStart: start,
        charEnd: end,
        lineStart: lineAt(start),
        lineEnd: lineAt(Math.max(start, end - 1)),
        provenance: "text-layer",
      })
      cursor = end + 2
    }
  }
  const nodes: DocumentSection[] = [
    {
      id: "root",
      title: input.title ?? "",
      level: 0,
      charStart: 0,
      charEnd: content.length,
      lineStart: 1,
      lineEnd: lineOffsets.length,
      ...(pages.length
        ? { pageStart: pages[0].pageNumber, pageEnd: pages[pages.length - 1].pageNumber }
        : {}),
    },
  ]
  const stack = [nodes[0]]
  const occurrences = new Map<string, number>()
  const add = (title: string, level: number, start: number, pageStart?: number) => {
    while (stack.length > 1 && stack[stack.length - 1].level >= level) stack.pop()
    const parent = stack[stack.length - 1]
    const key = `${parent.id}/${title}`
    const occurrence = (occurrences.get(key) ?? 0) + 1
    occurrences.set(key, occurrence)
    const node: DocumentSection = {
      id: `section-${documentContentHash(key)}-${occurrence}`,
      parentId: parent.id,
      title,
      level,
      charStart: start,
      charEnd: content.length,
      lineStart: lineAt(start),
      lineEnd: lineOffsets.length,
      ...(pageStart !== undefined ? { pageStart } : {}),
    }
    nodes.push(node)
    stack.push(node)
  }
  if (input.markdown) {
    for (const section of input.markdown.sections) {
      add(section.title, section.level, lineOffsets[section.startLine] ?? content.length)
    }
  } else if (input.pdf?.outline?.length) {
    const visit = (items: PDFOutlineItem[], level: number, inheritedPage?: number) => {
      for (const item of items) {
        const page = item.pageNumber ?? inheritedPage
        const range = pages.find((candidate) => candidate.pageNumber === page)
        // Unresolved bookmarks cannot assert an exact original location.
        if (range) add(item.title, level, range.charStart, range.pageNumber)
        visit(item.children, level + 1, page)
      }
    }
    visit(input.pdf.outline, 1)
  }
  if (nodes.length === 1 && pages.length) {
    for (const page of pages) add(String(page.pageNumber), 1, page.charStart, page.pageNumber)
  }
  for (let i = 1; i < nodes.length; i++) {
    const node = nodes[i]
    const next = nodes.slice(i + 1).find((candidate) => candidate.level <= node.level)
    node.charEnd = next?.charStart ?? content.length
    // Multiple bookmarks can name different parts of one page. Without an
    // exact text anchor their safe readable range is that whole page.
    if (node.pageStart !== undefined && node.charEnd <= node.charStart) {
      node.charEnd =
        pages.find((page) => page.pageNumber === node.pageStart)?.charEnd ?? node.charStart
    }
    node.lineEnd = lineAt(Math.max(node.charStart, node.charEnd - 1))
    if (node.pageStart !== undefined) {
      const overlapping = pages.filter(
        (page) => page.charStart < node.charEnd && page.charEnd > node.charStart
      )
      node.pageEnd = overlapping.at(-1)?.pageNumber ?? node.pageStart
    }
  }
  return {
    version: 1,
    contentHash: documentContentHash(content),
    textLength: content.length,
    nodes,
    pages,
  }
}

/** Text sources can be backfilled without re-parsing binaries or calling a model. */
export function buildTextDocumentStructure(content: string, title?: string): DocumentStructure {
  return buildDocumentStructure({ content, title, markdown: parseMarkdown(content) })
}
