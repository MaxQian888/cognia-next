"use client"

/**
 * SubagentTree — renders all `SubagentPart`s on one assistant message as a
 * nested parent→child→grandchild dispatch tree (depth-N nesting). Reuses the
 * existing `SubagentPart` card for each node (keeping its live store overlay +
 * Collapsible) and nests children in an indented, border-railed container.
 *
 * The tree shape is derived purely via `buildSubagentTree` inside a `useMemo`
 * over the parts — never copied into local state in an effect.
 */

import { useMemo } from "react"
import type { UIMessage } from "ai"
import { buildSubagentTree, type SubagentTreeNode } from "@/lib/claude/subagent-tree"
import { SubagentPart } from "./subagent-part"

interface Props {
  parts: UIMessage["parts"]
}

export function SubagentTree({ parts }: Props) {
  const tree = useMemo(() => buildSubagentTree(parts as readonly unknown[]), [parts])
  if (tree.length === 0) return null
  return (
    <div className="not-prose" data-testid="subagent-tree">
      {tree.map((node) => (
        <SubagentTreeRow key={node.part.subagentId} node={node} />
      ))}
    </div>
  )
}

function SubagentTreeRow({ node }: { node: SubagentTreeNode }) {
  return (
    <div data-testid={`subagent-tree-node-${node.part.subagentId}`}>
      <SubagentPart part={node.part} />
      {node.children.length > 0 ? (
        <div className="ml-4 border-l border-border/50 pl-2">
          {node.children.map((child) => (
            <SubagentTreeRow key={child.part.subagentId} node={child} />
          ))}
        </div>
      ) : null}
    </div>
  )
}
