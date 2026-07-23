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

  return (markdown) => {
    if (markdown === previousText) return previousBlocks

    let blocks: string[]
    const canReuse =
      previousText !== null &&
      previousBlocks.length > 0 &&
      markdown.startsWith(previousText) &&
      previousBlocks.join("") === previousText

    if (canReuse) {
      const stableBlocks = previousBlocks.slice(0, -1)
      let stableLength = 0
      for (const block of stableBlocks) stableLength += block.length
      blocks = [...stableBlocks, ...parseMarkdownIntoBlocks(markdown.slice(stableLength))]
      if (blocks.join("") !== markdown) {
        blocks = parseMarkdownIntoBlocks(markdown)
      }
    } else {
      blocks = parseMarkdownIntoBlocks(markdown)
    }

    previousText = markdown
    previousBlocks = blocks
    return blocks
  }
}
