// Minimal markdown → document-block parser shared by the docx and pdf writers.
// Pure and dependency-free so it is fully unit-testable; the heavy `docx` /
// `jspdf` libraries are lazy-loaded only in the format writers. Scope is the
// common subset a chat answer produces: headings, paragraphs, bullet lists, and
// fenced code. Inline emphasis is intentionally left as literal text (v1).

export type DocBlock =
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "listItem"; text: string }
  | { kind: "code"; text: string }

const HEADING_RE = /^(#{1,3})\s+(.*)$/
const LIST_RE = /^\s*[-*]\s+(.*)$/
const FENCE_RE = /^\s*```/

/** Parse a markdown string into an ordered list of renderable document blocks. */
export function parseMarkdownBlocks(markdown: string): DocBlock[] {
  const blocks: DocBlock[] = []
  const lines = markdown.replace(/\r\n/g, "\n").split("\n")

  let paragraph: string[] = []
  let codeLines: string[] | null = null

  const flushParagraph = () => {
    if (paragraph.length) {
      blocks.push({ kind: "paragraph", text: paragraph.join(" ").trim() })
      paragraph = []
    }
  }

  for (const line of lines) {
    // Inside a fenced code block: accumulate verbatim until the closing fence.
    if (codeLines !== null) {
      if (FENCE_RE.test(line)) {
        blocks.push({ kind: "code", text: codeLines.join("\n") })
        codeLines = null
      } else {
        codeLines.push(line)
      }
      continue
    }

    if (FENCE_RE.test(line)) {
      flushParagraph()
      codeLines = []
      continue
    }

    const heading = HEADING_RE.exec(line)
    if (heading) {
      flushParagraph()
      blocks.push({
        kind: "heading",
        level: heading[1].length as 1 | 2 | 3,
        text: heading[2].trim(),
      })
      continue
    }

    const list = LIST_RE.exec(line)
    if (list) {
      flushParagraph()
      blocks.push({ kind: "listItem", text: list[1].trim() })
      continue
    }

    if (line.trim() === "") {
      flushParagraph()
      continue
    }

    paragraph.push(line.trim())
  }

  // Close trailing state (unterminated code fence becomes a code block).
  if (codeLines !== null) blocks.push({ kind: "code", text: codeLines.join("\n") })
  flushParagraph()

  return blocks
}
