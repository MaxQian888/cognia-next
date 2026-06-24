"use client"

/**
 * In-canvas Spotlight search overlay. Ctrl/Cmd+F opens it; type any
 * substring of a node label / kind / sticky-note text to filter, hit
 * Enter / click to pan the viewport to the chosen node and trigger a
 * brief pulse highlight (3 s, gated by the resolved performance tier).
 *
 * Distinct from the Cmd+K command palette: spotlight is canvas-scoped
 * (only nodes on the current workflow, no editor actions).
 */

import { useMemo } from "react"
import { useShallow } from "zustand/react/shallow"
import { useTranslations } from "next-intl"
import type { ReactFlowInstance } from "@xyflow/react"
import {
  CommandDialog,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import type { EditorState, EditorStore } from "@/lib/workflow/editor/store"
import { getNodeIcon } from "@/lib/workflow/editor/node-icons"
import type { WorkflowNodeKind } from "@/types/workflow/visual"

export interface SpotlightSearchProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  store: EditorStore
  reactFlowInstance: ReactFlowInstance | null
  /** When false, viewport jump and pulse skip animation entirely. */
  animationsEnabled: boolean
}

export function SpotlightSearch({
  open,
  onOpenChange,
  store,
  reactFlowInstance,
  animationsEnabled,
}: SpotlightSearchProps) {
  const t = useTranslations("workflows.editor.spotlight")
  const { nodes, setSelectedNodes, pulseNode } = store(
    useShallow((s: EditorState) => ({
      nodes: s.nodes,
      setSelectedNodes: s.setSelectedNodes,
      pulseNode: s.pulseNode,
    }))
  )

  // Pre-compute group rects so each result row can show its breadcrumb (the
  // most specific containing group, if any). Smallest containing group wins
  // — matches the breadcrumb's own group-resolution logic.
  /* eslint-disable react-hooks/preserve-manual-memoization -- React Flow may mutate the nodes array reference between paints; manual memo over filter+map is intentional. */
  const groupRects = useMemo(() => {
    return nodes
      .filter((n) => n.data.kind === "annotation.group")
      .map((n) => {
        const params =
          (n.data.params as { width?: number; height?: number; title?: string } | undefined) ?? {}
        return {
          id: n.id,
          title:
            typeof params.title === "string" && params.title.trim().length > 0 ? params.title : "",
          x: n.position.x,
          y: n.position.y,
          width: typeof params.width === "number" && params.width > 0 ? params.width : 240,
          height: typeof params.height === "number" && params.height > 0 ? params.height : 160,
        }
      })
  }, [nodes])
  /* eslint-enable react-hooks/preserve-manual-memoization */

  // Build the search rows. cmdk's substring filter applies over the `value`
  // attribute, so we flatten label / kind / sticky-note text / breadcrumb
  // into one string and let it do the matching.
  /* eslint-disable react-hooks/preserve-manual-memoization -- nodes/groupRects identities can change mid-frame from React Flow; manual memo intentional and re-runs cheaply. */
  const rows = useMemo(() => {
    return nodes.slice(0, 200).map((n) => {
      const data = n.data
      const noteText =
        typeof (data.params as { text?: unknown } | undefined)?.text === "string"
          ? (data.params as { text: string }).text
          : ""
      // Find the smallest containing group, if any.
      const w = n.width ?? 240
      const h = n.height ?? 80
      const cx = n.position.x + w / 2
      const cy = n.position.y + h / 2
      let containingGroup: { title: string } | null = null
      let smallestArea = Infinity
      for (const g of groupRects) {
        if (g.id === n.id) continue
        if (cx < g.x || cx > g.x + g.width || cy < g.y || cy > g.y + g.height) continue
        const area = g.width * g.height
        if (area < smallestArea) {
          smallestArea = area
          containingGroup = { title: g.title }
        }
      }
      const groupLabel = containingGroup?.title ?? ""
      const value = [n.id, data.label, data.kind, noteText, data.notes ?? "", groupLabel]
        .join(" ")
        .toLowerCase()
      return {
        id: n.id,
        label: data.label,
        kind: data.kind,
        value,
        position: n.position,
        width: w,
        height: h,
        groupLabel,
      }
    })
  }, [nodes, groupRects])
  /* eslint-enable react-hooks/preserve-manual-memoization */

  const handleSelect = (rowId: string) => {
    const row = rows.find((r) => r.id === rowId)
    if (!row) return
    if (reactFlowInstance) {
      // Centre the node at zoom 1.2. Use `setCenter`, which centres the given
      // flow-space point within the React Flow PANE (it measures the rendered
      // canvas container). Hand-rolling the offset from `window.innerWidth/2`
      // is wrong: the pane is narrower than the window (left palette + right
      // sidebar), so window-centre sits right of the pane centre and the node
      // lands on the right edge instead of centred.
      const zoom = 1.2
      const cxFlow = row.position.x + row.width / 2
      const cyFlow = row.position.y + row.height / 2
      reactFlowInstance.setCenter(cxFlow, cyFlow, {
        zoom,
        duration: animationsEnabled ? 240 : 0,
      })
    }
    setSelectedNodes([rowId])
    pulseNode(rowId, animationsEnabled ? 3000 : 0)
    onOpenChange(false)
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("openShortcut")}
      description={t("placeholder")}
    >
      <CommandInput placeholder={t("placeholder")} data-testid="spotlight-input" />
      <CommandList>
        <CommandEmpty>{t("empty")}</CommandEmpty>
        {rows.map((r) => {
          const Icon = getNodeIcon(r.kind as WorkflowNodeKind)
          return (
            <CommandItem
              key={r.id}
              value={r.value}
              onSelect={() => handleSelect(r.id)}
              data-testid={`spotlight-row-${r.id}`}
            >
              <Icon className="size-4 shrink-0 mr-2" aria-hidden="true" />
              <span className="flex-1 truncate">{r.label}</span>
              {r.groupLabel ? (
                <span
                  className="ml-2 text-xs text-muted-foreground truncate max-w-[120px]"
                  data-testid={`spotlight-breadcrumb-${r.id}`}
                >
                  {t("breadcrumbIn", { group: r.groupLabel })}
                </span>
              ) : null}
              <span className="ml-2 text-[10px] uppercase opacity-70">{r.kind}</span>
            </CommandItem>
          )
        })}
      </CommandList>
    </CommandDialog>
  )
}
