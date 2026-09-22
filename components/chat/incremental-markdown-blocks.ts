export type MarkdownBlockParser = (markdown: string) => string[]

/**
 * Wrap a full Markdown block parser with append-only streaming reuse.
 *
 * Streamdown's blocks preserve the source text when concatenated. That lets
 * us keep every stable block and reparse only the final, potentially
 * incomplete block plus newly appended text. Replacements and parsers that do
 * not preserve source text automatically fall back to a full parse.
 */
export function createIncrementalMarkdownBlockParser(
  parseMarkdownIntoBlocks: MarkdownBlockParser
): MarkdownBlockParser {
  let previousText: string | null = null
  let previousBlocks: string[] = []
  let preservesSource = false
  let stableLength = 0

  return (markdown) => {
    if (markdown === previousText) return previousBlocks

    let blocks: string[]
    const canReuse =
      previousText !== null &&
      previousBlocks.length > 0 &&
      markdown.startsWith(previousText) &&
      preservesSource

    if (canReuse) {
      const stableBlocks = previousBlocks.slice(0, -1)
      const tail = markdown.slice(stableLength)
      const tailBlocks = parseMarkdownIntoBlocks(tail)
      preservesSource = tailBlocks.join("") === tail
      blocks = [...stableBlocks, ...tailBlocks]
      if (!preservesSource) {
        blocks = parseMarkdownIntoBlocks(markdown)
        preservesSource = blocks.join("") === markdown
      }
    } else {
      blocks = parseMarkdownIntoBlocks(markdown)
      preservesSource = blocks.join("") === markdown
    }

    previousText = markdown
    previousBlocks = blocks
    stableLength = markdown.length - (blocks.at(-1)?.length ?? 0)
    return blocks
  }
}
