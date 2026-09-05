import type { BlockNode, InlineNode } from "@web/lib/markdown-inline"

interface ChangelogMarkdownProps {
  blocks: BlockNode[]
  className?: string
}

function Inline({ nodes }: { nodes: InlineNode[] }) {
  return (
    <>
      {nodes.map((node, index) => {
        switch (node.kind) {
          case "text":
            return <span key={index}>{node.text}</span>
          case "strong":
            return (
              <strong key={index} className="font-medium text-ink">
                <Inline nodes={node.children} />
              </strong>
            )
          case "em":
            return (
              <em key={index}>
                <Inline nodes={node.children} />
              </em>
            )
          case "code":
            return (
              <code
                key={index}
                className="rounded-[4px] border border-hairline bg-surface px-1 py-px font-mono text-[0.8em] text-ink"
              >
                {node.text}
              </code>
            )
        }
      })}
    </>
  )
}

/**
 * A changeset body as the reader was meant to see it. The tree comes from
 * `lib/markdown-inline.ts`, which knows only the constructs the entries use,
 * so nothing here can emit markup the author did not write.
 */
export function ChangelogMarkdown({ blocks, className }: ChangelogMarkdownProps) {
  return (
    <div className={`flex flex-col gap-3 leading-relaxed text-muted ${className ?? ""}`}>
      {blocks.map((block, index) =>
        block.kind === "paragraph" ? (
          <p key={index}>
            <Inline nodes={block.children} />
          </p>
        ) : (
          <ul key={index} className="flex flex-col gap-1.5 pl-1">
            {block.items.map((item, itemIndex) => (
              <li key={itemIndex} className="flex gap-3">
                <span
                  aria-hidden
                  className="mt-[0.7em] size-1 shrink-0 rounded-full bg-hairline-strong"
                />
                <span>
                  <Inline nodes={item} />
                </span>
              </li>
            ))}
          </ul>
        )
      )}
    </div>
  )
}
