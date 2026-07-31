"use client"

/**
 * Problems panel — the global, click-to-navigate diagnostics list (the gap
 * n8n surfaces only contextually and Dify shows as a pre-publish checklist).
 * Reads the editor store's `diagnostics` slice (recomputed debounced by the
 * store driver), groups by severity, and reveals the offending node/edge on
 * the canvas when a row is clicked — mirroring `runs-tab.tsx`'s reveal pattern.
 */

import { useMemo, useState } from "react"
import { useShallow } from "zustand/react/shallow"
import { useTranslations } from "next-intl"
import { AlertTriangleIcon, CheckCircle2Icon, InfoIcon, XCircleIcon } from "lucide-react"
import type { ReactFlowInstance } from "@xyflow/react"
import { ScrollArea } from "@/components/ui/scroll-area"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { cn } from "@/lib/utils"
import type { EditorState, EditorStore } from "@/lib/workflow/editor/store"
import type { Diagnostic, DiagnosticSeverity } from "@/lib/workflow/diagnostics/types"

type SeverityFilter = "all" | "error" | "warning"

interface ProblemsTabProps {
  useStore: EditorStore
  reactFlowInstance?: ReactFlowInstance | null
}

// Loose translator type so a dynamic message key + interpolation values are
// accepted (the strict next-intl signature rejects runtime-built keys).
type LooseT = (key: string, values?: Record<string, string | number>) => string

const SEVERITY_ICON: Record<DiagnosticSeverity, typeof XCircleIcon> = {
  error: XCircleIcon,
  warning: AlertTriangleIcon,
  info: InfoIcon,
}

const SEVERITY_CLASS: Record<DiagnosticSeverity, string> = {
  error: "text-destructive",
  warning: "text-amber-500",
  info: "text-muted-foreground",
}

export function ProblemsTab({ useStore, reactFlowInstance }: ProblemsTabProps) {
  const t = useTranslations("workflows.diagnostics") as unknown as LooseT
  // Root (un-namespaced) translator for `nodeParam` diagnostics, whose
  // `messageKey` is already a full path from the bundle root (e.g.
  // `workflows.validation.required`). Using the scoped `t` would wrongly
  // prepend `workflows.diagnostics.` and miss the message.
  const tRoot = useTranslations() as unknown as LooseT
  const [filter, setFilter] = useState<SeverityFilter>("all")

  const diagnostics = useStore((s: EditorState) => s.diagnostics.diagnostics)
  const labelById = useStore(
    useShallow((s: EditorState) =>
      Object.fromEntries(s.nodes.map((n) => [n.id, n.data.label as string]))
    )
  )

  const filtered = useMemo(() => {
    if (filter === "all") return diagnostics
    return diagnostics.filter((d) => d.severity === filter)
  }, [diagnostics, filter])

  // Reveal the offending node/edge — see runs-tab.tsx:revealOnCanvas.
  const reveal = (d: Diagnostic) => {
    const state = useStore.getState()
    if (d.nodeId) {
      const node = state.nodes.find((n) => n.id === d.nodeId)
      if (node && reactFlowInstance) {
        // Pane-aware centring — see spotlight-search.tsx:handleSelect. Using
        // `setCenter` (not window-width setViewport math) keeps the node in the
        // middle of the visible canvas, not pushed right by the open sidebar.
        const zoom = 1.2
        const w = node.width ?? node.measured?.width ?? 240
        const h = node.height ?? node.measured?.height ?? 80
        reactFlowInstance.setCenter(node.position.x + w / 2, node.position.y + h / 2, {
          zoom,
          duration: 240,
        })
      }
      state.setSelectedNodes([d.nodeId])
      state.pulseNode(d.nodeId, 3000)
    } else if (d.edgeId) {
      state.setSelectedEdges([d.edgeId])
    }
  }

  // Resolve a diagnostic's message. `nodeParam` reuses the validation
  // namespace via its full messageKey; everything else lives under the
  // diagnostics namespace keyed by `code`.
  const messageOf = (d: Diagnostic): string => {
    const key = d.code === "nodeParam" ? d.messageKey : d.code
    try {
      // For nodeParam the key is a full path from the bundle root → resolve
      // it with the root translator, not the diagnostics-scoped one.
      if (d.code === "nodeParam") {
        return tRoot(d.messageKey, d.messageParams)
      }
      return t(key, d.messageParams)
    } catch {
      return d.messageKey
    }
  }

  return (
    <div className="flex h-full flex-col" data-testid="problems-tab">
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <ToggleGroup
          type="single"
          size="sm"
          value={filter}
          onValueChange={(v) => v && setFilter(v as SeverityFilter)}
          aria-label={t("title")}
        >
          <ToggleGroupItem value="all" data-testid="problems-filter-all">
            {t("filterAll")}
          </ToggleGroupItem>
          <ToggleGroupItem value="error" data-testid="problems-filter-errors">
            {t("filterErrors")}
          </ToggleGroupItem>
          <ToggleGroupItem value="warning" data-testid="problems-filter-warnings">
            {t("filterWarnings")}
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      {filtered.length === 0 ? (
        <div
          className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground"
          data-testid="problems-empty"
        >
          <CheckCircle2Icon className="size-6 text-emerald-500" aria-hidden="true" />
          {t("empty")}
        </div>
      ) : (
        <ScrollArea className="flex-1">
          <ul className="divide-y">
            {filtered.map((d) => {
              const Icon = SEVERITY_ICON[d.severity]
              const label = d.nodeId ? labelById[d.nodeId] : undefined
              return (
                <li key={d.id}>
                  <button
                    type="button"
                    onClick={() => reveal(d)}
                    className="flex w-full items-start gap-2 px-3 py-2 text-left text-sm hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:outline-none"
                    data-testid="problems-row"
                    data-severity={d.severity}
                  >
                    <Icon
                      className={cn("mt-0.5 size-4 shrink-0", SEVERITY_CLASS[d.severity])}
                      aria-hidden="true"
                    />
                    <span className="flex min-w-0 flex-col">
                      <span className="break-words">{messageOf(d)}</span>
                      {label ? (
                        <span className="truncate text-xs text-muted-foreground">{label}</span>
                      ) : null}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </ScrollArea>
      )}
    </div>
  )
}
