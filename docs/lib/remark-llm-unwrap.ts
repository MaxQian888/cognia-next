type MdastNode = {
  type: string
  name?: string | null
  data?: Record<string, unknown>
  children?: MdastNode[]
}

/**
 * MDX components whose attributes carry no information, so the Markdown twin
 * reads better with the wrapper gone and the children promoted.
 *
 * Everything else in `components/mdx-components.tsx` stays verbatim because
 * its props *are* the content: `<Mermaid chart>`, `<Status variant>`,
 * `<Term def>`, `<Tab value>`, `<Accordion title>`, `<Stat label value>`.
 *
 * `TLDR` alone covers 203 of the 246 English pages.
 */
const PRESENTATIONAL_COMPONENTS = new Set([
  "TLDR",
  "Steps",
  "Step",
  "Accordions",
  "Kbd",
  "InlineTOC",
])

function isJsxElement(node: MdastNode): boolean {
  return node.type === "mdxJsxFlowElement" || node.type === "mdxJsxTextElement"
}

/**
 * Walked by hand rather than with `unist-util-visit`: that package is ESM-only
 * and resolves under pnpm's `.pnpm/` layout, which next/jest always excludes
 * from transformation — importing it here would make this module untestable
 * from the repo's Jest runner (see the mock wall in jest.config.ts).
 */
function walk(node: MdastNode, visitor: (node: MdastNode) => void): void {
  visitor(node)
  for (const child of node.children ?? []) walk(child, visitor)
}

/**
 * Tags presentational MDX wrappers so fumadocs' stringifier emits their
 * children only, in the `/llms.txt` + `/md/**.md` output.
 *
 * `data._stringify` is the supported lever here. The obvious one —
 * `postprocess.includeProcessedMarkdown.filterElement` — is silently dropped:
 * `remarkLLMs` spreads caller options and *then* hardcodes its own
 * `filterElement` over them (fumadocs-core 16.8.5,
 * `dist/mdx-plugins/remark-llms.js`). `data._stringify` is read afterwards and
 * wins regardless.
 *
 * Rendering is unaffected — nothing outside that stringifier reads the field.
 */
export function remarkLlmUnwrap() {
  return (tree: unknown) => {
    walk(tree as MdastNode, (node) => {
      if (!isJsxElement(node)) return
      if (!node.name || !PRESENTATIONAL_COMPONENTS.has(node.name)) return

      node.data = { ...node.data, _stringify: "children-only" }
    })
  }
}
