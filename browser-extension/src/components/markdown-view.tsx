import { Fragment, useMemo, type ReactNode } from "react"

import type { BrowserApi } from "@ext/src/lib/browser-api"
import { parseMarkdown, type Block, type Inline } from "@ext/src/lib/panel/markdown"

/**
 * A task's answer, rendered from Markdown as React elements (ADR-0228 §4).
 *
 * Only elements this component creates reach the DOM — the parser has no HTML
 * pass-through and nothing here sets `innerHTML` — so an answer can quote
 * markup and it renders as the characters it is. Links open through the
 * extension in a new tab rather than navigating the panel.
 */
export function MarkdownView({
  api,
  source,
  testId,
}: {
  api: BrowserApi
  source: string
  testId?: string
}) {
  const blocks = useMemo(() => parseMarkdown(source), [source])
  return (
    <div className="space-y-2 text-xs leading-relaxed break-words" data-testid={testId}>
      {blocks.map((block, index) => (
        <BlockView key={index} api={api} block={block} />
      ))}
    </div>
  )
}

function BlockView({ api, block }: { api: BrowserApi; block: Block }): ReactNode {
  switch (block.type) {
    case "heading": {
      const size = block.level <= 2 ? "text-sm font-semibold" : "text-xs font-semibold"
      const children = <InlineView api={api} nodes={block.children} />
      switch (block.level) {
        case 1:
          return <h3 className={size}>{children}</h3>
        case 2:
          return <h4 className={size}>{children}</h4>
        case 3:
          return <h5 className={size}>{children}</h5>
        default:
          return <h6 className={size}>{children}</h6>
      }
    }
    case "paragraph":
      return (
        <p>
          <InlineView api={api} nodes={block.children} />
        </p>
      )
    case "code":
      return (
        <pre className="overflow-x-auto rounded-control bg-muted p-2 font-mono text-[11px]">
          <code data-lang={block.lang || undefined}>{block.text}</code>
        </pre>
      )
    case "quote":
      return (
        <blockquote className="space-y-2 border-l-2 border-border pl-2 text-muted-foreground">
          {block.children.map((child, index) => (
            <BlockView key={index} api={api} block={child} />
          ))}
        </blockquote>
      )
    case "list": {
      const items = block.items.map((item, index) => (
        <li key={index} className="space-y-1">
          {item.map((child, childIndex) => (
            <BlockView key={childIndex} api={api} block={child} />
          ))}
        </li>
      ))
      return block.ordered ? (
        <ol className="list-decimal space-y-1 pl-4" start={block.start}>
          {items}
        </ol>
      ) : (
        <ul className="list-disc space-y-1 pl-4">{items}</ul>
      )
    }
    case "table":
      return (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[11px]">
            <thead>
              <tr>
                {block.header.map((cell, index) => (
                  <th
                    key={index}
                    className="border border-border px-1.5 py-1 text-left font-semibold"
                    style={block.align[index] ? { textAlign: block.align[index]! } : undefined}
                  >
                    <InlineView api={api} nodes={cell} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, index) => (
                    <td
                      key={index}
                      className="border border-border px-1.5 py-1"
                      style={block.align[index] ? { textAlign: block.align[index]! } : undefined}
                    >
                      <InlineView api={api} nodes={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    case "rule":
      return <hr className="border-border" />
  }
}

function InlineView({ api, nodes }: { api: BrowserApi; nodes: Inline[] }): ReactNode {
  return nodes.map((node, index) => {
    switch (node.type) {
      case "text":
        return <Fragment key={index}>{node.text}</Fragment>
      case "code":
        return (
          <code key={index} className="rounded bg-muted px-1 font-mono text-[11px]">
            {node.text}
          </code>
        )
      case "strong":
        return (
          <strong key={index}>
            <InlineView api={api} nodes={node.children} />
          </strong>
        )
      case "em":
        return (
          <em key={index}>
            <InlineView api={api} nodes={node.children} />
          </em>
        )
      case "del":
        return (
          <del key={index}>
            <InlineView api={api} nodes={node.children} />
          </del>
        )
      case "link":
        return (
          <a
            key={index}
            href={node.href}
            className="text-primary underline underline-offset-2"
            rel="noreferrer noopener"
            onClick={(event) => {
              event.preventDefault()
              void api.openUrl(node.href)
            }}
          >
            <InlineView api={api} nodes={node.children} />
          </a>
        )
      case "break":
        return <br key={index} />
    }
  })
}
