"use client"

/**
 * SubagentTree — renders all `SubagentPart`s on one assistant message as a
 * nested parent→child→grandchild dispatch tree (depth-N nesting). Reuses the
 * existing `SubagentPart` card for each node and nests children in an indented,
 * border-railed container.
 *
 * Mode-aware (mirrors the tool-call activity group):
 *  - threads the active `AgentFlowMode` down to every node;
 *  - owns a tree-wide expand-all / collapse-all override (a sparse
 *    `Map<id, boolean>`; absent ⇒ the node follows the mode default — open in
 *    `detailed`, collapsed otherwise — so it stays reactive to mode changes
 *    without a state-syncing effect);
 *  - each node gets a one-shot `MotionReveal` entrance.
 *
 * The tree shape is derived purely via `buildSubagentTree` inside a `useMemo`
 * over the parts — never copied into local state in an effect.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { GitBranchIcon } from "lucide-react"
import type { UIMessage } from "ai"
import { buildSubagentTree, type SubagentTreeNode } from "@/lib/claude/subagent-tree"
import { Button } from "@/components/ui/button"
import { MotionReveal } from "@/components/chat/motion/motion-reveal"
import type { AgentFlowMode } from "@/types/appearance"
import { SubagentPart } from "./subagent-part"

interface Props {
  parts: UIMessage["parts"]
  /** Display mode; defaults to `standard`. */
  mode?: AgentFlowMode
}

function collectIds(nodes: SubagentTreeNode[], out: string[] = []): string[] {
  for (const node of nodes) {
    out.push(node.part.subagentId)
    collectIds(node.children, out)
  }
  return out
}

export function SubagentTree({ parts, mode = "standard" }: Props) {
  const t = useTranslations("chat.agentFlow")
  const tree = useMemo(() => buildSubagentTree(parts as readonly unknown[]), [parts])
  const ids = useMemo(() => collectIds(tree), [tree])
  const [overrides, setOverrides] = useState<Map<string, boolean>>(() => new Map())

  if (tree.length === 0) return null

  const isOpen = (id: string) => overrides.get(id) ?? mode === "detailed"
  const allOpen = ids.length > 0 && ids.every((id) => isOpen(id))
  const toggle = (id: string) =>
    setOverrides((prev) => {
      const next = new Map(prev)
      next.set(id, !isOpen(id))
      return next
    })
  const toggleAll = () =>
    setOverrides(() => {
      const next = new Map<string, boolean>()
      for (const id of ids) next.set(id, !allOpen)
      return next
    })

  return (
    <div className="not-prose" data-testid="subagent-tree" data-mode={mode}>
      {ids.length >= 2 ? (
        <div className="mb-1 flex items-center gap-2 px-0.5">
          <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="text-xs font-medium text-muted-foreground">
            {t("subagents.summary", { count: ids.length })}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="ml-auto h-6 px-2 text-[11px] text-muted-foreground"
            onClick={toggleAll}
            data-testid="subagent-tree-expand-all"
          >
            {allOpen ? t("group.collapseAll") : t("group.expandAll")}
          </Button>
        </div>
      ) : null}
      {tree.map((node, i) => (
        <SubagentTreeRow
          key={node.part.subagentId}
          node={node}
          mode={mode}
          isOpen={isOpen}
          toggle={toggle}
          index={i}
        />
      ))}
    </div>
  )
}

function SubagentTreeRow({
  node,
  mode,
  isOpen,
  toggle,
  index,
}: {
  node: SubagentTreeNode
  mode: AgentFlowMode
  isOpen: (id: string) => boolean
  toggle: (id: string) => void
  index: number
}) {
  const id = node.part.subagentId
  return (
    <div data-testid={`subagent-tree-node-${id}`}>
      <MotionReveal index={index}>
        <SubagentPart part={node.part} mode={mode} open={isOpen(id)} onToggle={() => toggle(id)} />
      </MotionReveal>
      {node.children.length > 0 ? (
        <div className="ml-4 border-l border-border/50 pl-2">
          {node.children.map((child, ci) => (
            <SubagentTreeRow
              key={child.part.subagentId}
              node={child}
              mode={mode}
              isOpen={isOpen}
              toggle={toggle}
              index={ci}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}
