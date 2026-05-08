"use client"

/**
 * Inspector panel — right-side rail that opens when one or more nodes are
 * selected on the canvas. Hosts the per-kind config form from the registry
 * plus shared fields (label, notes, disabled toggle, delete button).
 *
 * The panel is a side rail (always-visible when there's a selection), not a
 * Dialog/Sheet, because the user needs to click the canvas to confirm
 * downstream effects without the inspector dismissing.
 */

import { useCallback, useMemo } from "react"
import { useShallow } from "zustand/react/shallow"
import { Trash2Icon, XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import { workflowNodeCategory, type WorkflowNodeKind } from "@/types/workflow/visual"
import { nodeCatalogEntry } from "@/lib/workflow/nodes/catalog"
import type { EditorState, EditorStore } from "@/lib/workflow/editor/store"
import { Field } from "./inspector/forms/shared"
import { InspectorExpressionProvider } from "./inspector/forms/shared/inspector-context"
import { getNodeConfigComponent, hasDedicatedConfig } from "./inspector/node-config-registry"

// Module-scoped wrapper that resolves the per-kind config form via the
// registry. The registry returns stable references, so React preserves
// form state across renders despite the dynamic dispatch.
function NodeConfigForm({
  kind,
  params,
  onChange,
}: {
  kind: WorkflowNodeKind
  params: Record<string, unknown>
  onChange: (next: Record<string, unknown>) => void
}) {
  const Component = getNodeConfigComponent(kind)
  return (
    // eslint-disable-next-line react-hooks/static-components
    <Component params={params} onChange={onChange} />
  )
}

const CATEGORY_BADGE = {
  trigger: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  action: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  ai: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
  flow: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  data: "bg-rose-500/15 text-rose-700 dark:text-rose-300",
  io: "bg-cyan-500/15 text-cyan-700 dark:text-cyan-300",
  annotation: "bg-zinc-500/15 text-zinc-700 dark:text-zinc-300",
} as const

export function InspectorPanel({
  useStore,
  className,
}: {
  useStore: EditorStore
  className?: string
}) {
  const { node, updateNodeData, removeNodes, clearSelection } = useStore(
    useShallow((s: EditorState) => {
      const id = s.selectedNodeIds[0]
      const node = id ? s.nodes.find((n) => n.id === id) : null
      return {
        node,
        updateNodeData: s.updateNodeData,
        removeNodes: s.removeNodes,
        clearSelection: s.clearSelection,
      }
    })
  )

  const entry = useMemo(
    () => (node ? nodeCatalogEntry(node.data.kind as WorkflowNodeKind) : null),
    [node]
  )

  const handleParamsChange = useCallback(
    (next: Record<string, unknown>) => {
      if (!node) return
      updateNodeData(node.id, { params: next })
    },
    [node, updateNodeData]
  )

  if (!node || !entry) {
    return (
      <aside
        className={cn(
          "flex h-full w-full flex-col items-center justify-center border-l bg-card/50 p-6 text-center text-sm text-muted-foreground",
          className
        )}
        data-testid="workflow-inspector-empty"
      >
        <p>Select a node on the canvas to configure it.</p>
      </aside>
    )
  }

  const category = workflowNodeCategory(node.data.kind as WorkflowNodeKind)

  return (
    <aside
      className={cn("flex h-full w-full flex-col border-l bg-card/50", className)}
      aria-label="Node inspector"
      data-testid="workflow-inspector"
    >
      <header className="flex items-start gap-2 border-b px-4 py-3">
        <div className="flex-1 min-w-0">
          <Badge variant="outline" className={cn("font-normal", CATEGORY_BADGE[category])}>
            {entry.kind}
          </Badge>
          <h3 className="mt-1.5 text-sm font-semibold leading-tight">{entry.label}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">{entry.description}</p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          onClick={clearSelection}
          aria-label="Close inspector"
        >
          <XIcon className="size-4" />
        </Button>
      </header>
      <ScrollArea className="flex-1">
        <div className="space-y-4 px-4 py-4">
          <Field label="Label" htmlFor="ins-label">
            <Input
              id="ins-label"
              value={node.data.label}
              onChange={(e) => updateNodeData(node.id, { label: e.target.value })}
              maxLength={120}
            />
          </Field>
          <Field
            label="Notes"
            htmlFor="ins-notes"
            hint="Sticky-note text shown under the node body."
          >
            <Textarea
              id="ins-notes"
              value={node.data.notes ?? ""}
              onChange={(e) => updateNodeData(node.id, { notes: e.target.value || undefined })}
              rows={2}
            />
          </Field>
          <div className="flex items-center justify-between gap-2 rounded-md border bg-muted/30 px-3 py-2">
            <div>
              <p className="text-sm font-medium">Disabled</p>
              <p className="text-[11px] text-muted-foreground">
                Skipped during runs. Useful for staging without deleting.
              </p>
            </div>
            <Switch
              checked={node.data.disabled ?? false}
              onCheckedChange={(v) => updateNodeData(node.id, { disabled: v })}
              aria-label="Disable node"
            />
          </div>
          <Separator />
          <InspectorExpressionProvider store={useStore} currentNodeId={node.id}>
            <NodeConfigForm
              kind={node.data.kind as WorkflowNodeKind}
              params={(node.data.params as Record<string, unknown>) ?? {}}
              onChange={handleParamsChange}
            />
          </InspectorExpressionProvider>
          {!hasDedicatedConfig(node.data.kind as WorkflowNodeKind) ? (
            <p className="text-[11px] text-muted-foreground">
              No dedicated config form yet — edit the raw JSON above. A tailored form ships with the
              node executor in Phase 6.
            </p>
          ) : null}
        </div>
      </ScrollArea>
      <footer className="border-t px-4 py-3">
        <Button
          variant="outline"
          className="w-full text-destructive hover:bg-destructive/10"
          onClick={() => {
            removeNodes([node.id])
          }}
        >
          <Trash2Icon className="size-4 mr-1.5" />
          Delete node
        </Button>
      </footer>
    </aside>
  )
}
