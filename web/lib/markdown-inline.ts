/**
 * The subset of Markdown a changeset summary uses, parsed to a small tree.
 *
 * Changeset bodies are written by hand at commit time in the flavour GitHub
 * renders: paragraphs, `- ` bullets, `**strong**`, `_emphasis_` or
 * `*emphasis*`, and `` `code` ``. The changelog page used to print them raw,
 * so every entry carried literal asterisks and underscores. A full Markdown
 * pipeline would be a second parser for a fixed, known input, and would also
 * have to be told what to refuse. This one refuses everything it does not
 * know by rendering it as text, which is what a static brochure wants.
 *
 * Pure and dependency-free so it can be unit-tested without a DOM, and so the
 * renderer that turns the tree into elements stays trivial.
 */

export type InlineNode =
  | { kind: "text"; text: string }
  | { kind: "strong"; children: InlineNode[] }
  | { kind: "em"; children: InlineNode[] }
  | { kind: "code"; text: string }

export type BlockNode =
  { kind: "paragraph"; children: InlineNode[] } | { kind: "list"; items: InlineNode[][] }

/** `**strong**`, `_em_`, `*em*` and `` `code` ``, left to right, unnested code. */
export function parseInline(source: string): InlineNode[] {
  const nodes: InlineNode[] = []
  let text = ""
  const flush = () => {
    if (text) nodes.push({ kind: "text", text })
    text = ""
  }

  let i = 0
  while (i < source.length) {
    const rest = source.slice(i)

    const code = /^`([^`\n]+)`/.exec(rest)
    if (code) {
      flush()
      nodes.push({ kind: "code", text: code[1] })
      i += code[0].length
      continue
    }

    const strong = /^\*\*(.+?)\*\*/.exec(rest)
    if (strong) {
      flush()
      nodes.push({ kind: "strong", children: parseInline(strong[1]) })
      i += strong[0].length
      continue
    }

    // Emphasis needs a word boundary on the outside, or `snake_case_names`
    // and `a * b` would turn into italics.
    const before = i === 0 ? " " : source[i - 1]
    const em = /^([_*])(?!\s)(.+?)(?<!\s)\1(?![\w*])/.exec(rest)
    if (em && !/\w/.test(before)) {
      flush()
      nodes.push({ kind: "em", children: parseInline(em[2]) })
      i += em[0].length
      continue
    }

    text += source[i]
    i += 1
  }
  flush()
  return nodes
}

/** Paragraphs and `- ` bullet lists, separated by blank lines or list edges. */
export function parseBlocks(source: string): BlockNode[] {
  const blocks: BlockNode[] = []
  let paragraph: string[] = []
  let list: string[] = []

  const flushParagraph = () => {
    if (paragraph.length) {
      blocks.push({ kind: "paragraph", children: parseInline(paragraph.join(" ")) })
    }
    paragraph = []
  }
  const flushList = () => {
    if (list.length) {
      blocks.push({ kind: "list", items: list.map((item) => parseInline(item)) })
    }
    list = []
  }

  for (const raw of source.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trim()
    if (!line) {
      flushParagraph()
      flushList()
      continue
    }
    const bullet = /^[-*]\s+(.*)$/.exec(line)
    if (bullet) {
      flushParagraph()
      list.push(bullet[1])
      continue
    }
    if (list.length) {
      // A wrapped continuation of the previous bullet.
      list[list.length - 1] += ` ${line}`
      continue
    }
    paragraph.push(line)
  }
  flushParagraph()
  flushList()
  return blocks
}

/** The tree flattened back to plain words, for previews and search. */
export function plainText(nodes: InlineNode[]): string {
  return nodes
    .map((node) => {
      switch (node.kind) {
        case "text":
        case "code":
          return node.text
        case "strong":
        case "em":
          return plainText(node.children)
      }
    })
    .join("")
}

/**
 * Whether an entry is long enough to fold. One short paragraph reads in full.
 * Anything with several blocks, or more than a few lines of prose, opens
 * folded to its first block so a month of entries stays scannable.
 */
export const FOLD_CHARACTERS = 320

export function shouldFold(blocks: BlockNode[]): boolean {
  if (blocks.length > 1) return true
  const [only] = blocks
  if (!only) return false
  const length = only.kind === "paragraph" ? plainText(only.children).length : Infinity
  return length > FOLD_CHARACTERS
}
