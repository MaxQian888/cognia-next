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

import { memo, useCallback, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { GitBranchIcon } from "lucide-react"
import type { UIMessage } from "ai"
import { isSubagentPart } from "@/lib/claude/parts-extensions"
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
  // Key the tree rebuild on a CONTENT signature of just the subagent parts, not
  // the `parts` array reference. The adapter replaces `message.parts` on every
  // streaming token of the spawning turn, so a ref-keyed memo would rebuild the
  // whole tree (fresh node objects → memoized `SubagentTreeRow` can't hold) on
  // every token even when no subagent changed. Live data (toolUses, logs) is
  // read per-card from the store, so the structural snapshot only needs to
  // rebuild when subagent identity / structure / status actually moves.
  const sig = useMemo(() => {
    const subs = (Array.isArray(parts) ? (parts as readonly unknown[]) : []).filter(isSubagentPart)
    return subs
      .map(
        (p) =>
          `${p.subagentId}:${p.parentSubagentId ?? ""}:${p.status}:${p.startedAt}:${p.completedAt ?? ""}:${p.depth ?? ""}`
      )
      .join("|")
  }, [parts])
  // `sig` is the content digest of `parts`; rebuilding the tree on `sig` (not the
  // `parts` ref, which churns every token) is the whole point of B1.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const tree = useMemo(() => buildSubagentTree(parts as readonly unknown[]), [sig])
  const ids = useMemo(() => collectIds(tree), [tree])
  const [overrides, setOverrides] = useState<Map<string, boolean>>(() => new Map())

  // Stable identities so a streaming re-render of the parent message (which
  // leaves `overrides`/`mode` untouched, and — via the `sig`-keyed memo above —
  // leaves `tree`/node objects referentially stable) doesn't hand the recursive,
  // memoized `SubagentTreeRow` children fresh callbacks and force the whole tree
  // to re-render. Identities only change when overrides/mode actually move.
  const isOpen = useCallback(
    (id: string) => overrides.get(id) ?? mode === "detailed",
    [overrides, mode]
  )
  const allOpen = useMemo(
    () => ids.length > 0 && ids.every((id) => overrides.get(id) ?? mode === "detailed"),
    [ids, overrides, mode]
  )
  const toggle = useCallback(
    (id: string) =>
      setOverrides((prev) => {
        const next = new Map(prev)
        next.set(id, !(prev.get(id) ?? mode === "detailed"))
        return next
      }),
    [mode]
  )
  const toggleAll = useCallback(
    () =>
      setOverrides(() => {
        const next = new Map<string, boolean>()
        for (const id of ids) next.set(id, !allOpen)
        return next
      }),
    [ids, allOpen]
  )

  if (tree.length === 0) return null

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
      {/* role="tree" wraps only the rows (not the header control) so every direct
          child is a treeitem — exposes the parent→child nesting to assistive tech
          that the indentation only conveys visually. */}
      <div role="tree" aria-label={t("subagents.summary", { count: ids.length })}>
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
    </div>
  )
}

const SubagentTreeRow = memo(function SubagentTreeRow({
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
  const hasChildren = node.children.length > 0
  return (
    <div
      data-testid={`subagent-tree-node-${id}`}
      role="treeitem"
      aria-level={node.depth}
      // Disclosure tree (not a selection widget); `treeitem` still requires
      // `aria-selected`, so advertise the items as never-selected.
      aria-selected={false}
      aria-expanded={hasChildren ? isOpen(id) : undefined}
    >
      <MotionReveal index={index}>
        <SubagentPart part={node.part} mode={mode} open={isOpen(id)} onToggle={() => toggle(id)} />
      </MotionReveal>
      {hasChildren ? (
        <div role="group" className="ml-4 border-l border-border/50 pl-2">
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
})
