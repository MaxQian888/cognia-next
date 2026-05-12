import { visit } from "unist-util-visit"

type CodeNode = {
  type: "code"
  lang?: string | null
  value: string
}

/**
 * Converts ```mermaid fenced code blocks into <Mermaid chart="..." /> JSX so
 * the client-side Mermaid component can render them. Without this, the blocks
 * render as plain `<pre><code>` and never reach Mermaid.
 */
export function remarkMermaid() {
  return (tree: unknown) => {
    visit(
      tree as never,
      "code",
      (node: CodeNode, index: number | undefined, parent: { children: unknown[] } | undefined) => {
        if (node.lang !== "mermaid" || !parent || index === undefined) return

        parent.children[index] = {
          type: "mdxJsxFlowElement",
          name: "Mermaid",
          attributes: [
            {
              type: "mdxJsxAttribute",
              name: "chart",
              value: node.value,
            },
          ],
          children: [],
        }
      }
    )
  }
}
