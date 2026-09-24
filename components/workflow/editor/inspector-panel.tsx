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

import { memo, useCallback, useEffect, useMemo, useRef } from "react"
import { useShallow } from "zustand/react/shallow"
import { Trash2Icon, XIcon, AlertCircleIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import {
  workflowNodeCategory,
  type WorkflowNodeErrorHandling,
  type WorkflowNodeKind,
} from "@/types/workflow/visual"
import { nodeCatalogEntry } from "@/lib/workflow/nodes/catalog"
import { tNodeField } from "@/lib/workflow/i18n/node-translate"
import { getNodeIndex } from "@/lib/workflow/editor/node-index"
import { supportsErrorHandling } from "@/lib/workflow/editor/node-handles"
import type { EditorState, EditorStore } from "@/lib/workflow/editor/store"
import {
  findFieldControl,
  focusFieldControl,
  focusFieldWhenReady,
  listInvalidFieldContainers,
} from "@/lib/workflow/editor/field-focus"
import { Field, FieldErrorProvider } from "./inspector/forms/shared"
import { ErrorHandlingSection } from "./inspector/forms/shared/error-handling-section"
import { InspectorExpressionProvider } from "./inspector/forms/shared/inspector-context"
import { DataTabs } from "./inspector/data/data-tabs"
import { BulkNodeInspector } from "./bulk-node-inspector"
import { useMissingNodeCapabilities } from "./capability-badge"
import {
  getNodeConfigComponentForEntry,
  hasDedicatedConfigForEntry,
} from "./inspector/node-config-registry"

// Module-scoped wrapper that resolves the per-entry config form via the
// registry. Built-in nodes hit a dedicated component; plugin nodes with a
// `paramsSchema` go through SchemaForm; everything else falls back to
// the raw-JSON editor.
//
// Memoized so unrelated InspectorPanel re-renders (header text, error
// badge count flipping) don't reach the per-kind config component, which
// can host expensive controls (code editor, schema form, etc.).
const NodeConfigFormSection = memo(function NodeConfigFormSection({
  kind,
  paramsSchema,
  params,
  onChange,
  typeVersion,
}: {
  kind: WorkflowNodeKind
  paramsSchema?: Record<string, unknown>
  params: Record<string, unknown>
  onChange: (next: Record<string, unknown>) => void
  typeVersion?: number
}) {
  const Component = getNodeConfigComponentForEntry({ kind, paramsSchema })
  return (
    // eslint-disable-next-line react-hooks/static-components
    <Component params={params} onChange={onChange} typeVersion={typeVersion} />
  )
})

/**
 * Shared empty-params reference so nodes with no `data.params` set don't
 * hand a fresh `{}` to the memoized config form on every render.
 */
const EMPTY_PARAMS: Record<string, unknown> = Object.freeze({})

const CATEGORY_BADGE = {
  trigger: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  action: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  ai: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
  flow: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  data: "bg-rose-500/15 text-rose-700 dark:text-rose-300",
  io: "bg-cyan-500/15 text-cyan-700 dark:text-cyan-300",
  annotation: "bg-zinc-500/15 text-zinc-700 dark:text-zinc-300",
} as const

function InspectorPanelInner({
  useStore,
  className,
  embedded = false,
}: {
  useStore: EditorStore
  className?: string
  /**
   * Drop the side-rail chrome (`border-l bg-card/50`) and the header
   * close-X. Set when the panel is embedded in a host that owns its own
   * surface + dismiss — e.g. the mobile node-config bottom drawer.
   */
  embedded?: boolean
}) {
  const t = useTranslations("workflows.inspector")
  // Root translator resolves both built-in (`workflows.nodes.*`) and plugin
  // (`plugin.<id>.workflow.nodes.*`) node strings through `tNodeField`.
  const tRoot = useTranslations()

  // Selector split (perf A4-style): subscribe in three narrow slices so a
  // mutation that doesn't change *the selected node* never reaches the
  // inspector. Each `useStore` runs its selector on every set() but each
  // returns a primitive / shallow-equal object that React then bails on.
  //
  //   1. selectedId — primitive; unchanged for any non-selection mutation.
  //   2. node + validation — looked up via `getNodeIndex` (WeakMap-cached
  //      by nodes-array identity, O(1) byId). Returns the same node
  //      reference whenever the selected node's own data didn't change,
  //      so unrelated node drags don't bust the shallow equality.
  //   3. action handlers — stable function identities on the store; this
  //      shallow selector returns the same object after the first read.
  const selectedId = useStore((s: EditorState) => s.selectedNodeIds[0] ?? null)
  // When more than one node is selected, hand off to the bulk inspector
  // (cross-kind-safe field edits across the whole selection).
  const isMultiSelect = useStore((s: EditorState) => s.selectedNodeIds.length > 1)

  const { node, validation } = useStore(
    useShallow((s: EditorState) => ({
      node: selectedId ? (getNodeIndex(s.nodes).byId.get(selectedId) ?? null) : null,
      validation: selectedId ? (s.validationByStepId[selectedId] ?? null) : null,
    }))
  )

  const {
    updateNodeData,
    removeNodes,
    clearSelection,
    scheduleRevalidateNode,
    flushPendingRevalidation,
    clearRequestedFieldFocus,
  } = useStore(
    useShallow((s: EditorState) => ({
      updateNodeData: s.updateNodeData,
      removeNodes: s.removeNodes,
      clearSelection: s.clearSelection,
      scheduleRevalidateNode: s.scheduleRevalidateNode,
      flushPendingRevalidation: s.flushPendingRevalidation,
      clearRequestedFieldFocus: s.clearRequestedFieldFocus,
    }))
  )
  const fieldFocusRequest = useStore((s: EditorState) => s.requestedFieldFocus)

  const entry = useMemo(
    () => (node ? nodeCatalogEntry(node.data.kind as WorkflowNodeKind) : null),
    [node]
  )
  const capabilityInfo = useMissingNodeCapabilities(entry ?? {})

  // The zod re-validation is debounced by the store so keystroke storms
  // don't reparse the whole schema on every character. The queue lives in
  // the store, not here: this panel is hidden (effects torn down) whenever
  // another workbench panel is in front and unmounts with its host, and a
  // component-owned timer died with it — leaving the node's issue badge
  // stuck on a count the params no longer have. The store flushes the queue
  // on every selection change; unmount / hide flushes it here so the badge
  // is settled by the time anything else is on screen.
  useEffect(() => () => flushPendingRevalidation(), [flushPendingRevalidation])

  const handleParamsChange = useCallback(
    (next: Record<string, unknown>) => {
      if (!node) return
      updateNodeData(node.id, { params: next })
      scheduleRevalidateNode(node.id)
    },
    [node, updateNodeData, scheduleRevalidateNode]
  )

  // Stabilise the params reference so the memoized NodeConfigFormSection
  // can bail when `node.data.params` happens to be undefined on adjacent
  // renders (we hand it the shared frozen `EMPTY_PARAMS` instead of a
  // fresh `{}` literal).
  const configFormParams = useMemo(
    () => (node ? ((node.data.params as Record<string, unknown>) ?? EMPTY_PARAMS) : EMPTY_PARAMS),
    [node]
  )

  // Cycle focus through the invalid fields when the error badge is clicked.
  // `Field` stamps `data-invalid="true"` on each field with an error; the
  // lookup is scoped to THIS panel's form so the workbench's hidden
  // keep-alive copies can never be the target.
  const formScrollRef = useRef<HTMLDivElement | null>(null)
  const jumpIndexRef = useRef(0)
  const jumpToNextError = useCallback(() => {
    const root = formScrollRef.current
    if (!root) return
    const invalids = listInvalidFieldContainers(root)
    if (invalids.length === 0) {
      // Only object-level (`_root`) errors with no field target — scroll to top.
      root.scrollIntoView?.({ block: "start", behavior: "smooth" })
      return
    }
    const idx = jumpIndexRef.current % invalids.length
    jumpIndexRef.current = idx + 1
    const target = invalids[idx]
    const control = findFieldControl(target)
    if (control) focusFieldControl(target, control)
    else target.scrollIntoView?.({ block: "center", behavior: "smooth" })
  }, [])

  // Consume a jump-to-field request (Problems row click). Effects only run
  // while this panel is actually on screen — `<Activity mode="hidden">`
  // tears them down — so a request raised while another panel was in front
  // is picked up the moment the sidebar brings the Inspector forward. The
  // field may still be mounting (CodeMirror builds its view in an effect),
  // so the focus retries per frame until the control exists.
  const pendingFocusSeq =
    fieldFocusRequest && fieldFocusRequest.nodeId === selectedId && !isMultiSelect
      ? fieldFocusRequest.seq
      : null
  const staleFocusSeq =
    fieldFocusRequest && (fieldFocusRequest.nodeId !== selectedId || isMultiSelect)
      ? fieldFocusRequest.seq
      : null
  const pendingFocusField = pendingFocusSeq !== null ? (fieldFocusRequest?.field ?? null) : null
  useEffect(() => {
    // The user moved on (picked another node, multi-selected) before the
    // field could be shown — the request no longer describes this panel.
    if (staleFocusSeq !== null) clearRequestedFieldFocus(staleFocusSeq)
  }, [staleFocusSeq, clearRequestedFieldFocus])
  useEffect(() => {
    if (pendingFocusSeq === null) return
    return focusFieldWhenReady({
      getRoot: () => formScrollRef.current,
      field: pendingFocusField,
      onSettled: (outcome) => {
        // A cancelled attempt (panel hidden or unmounted mid-wait) keeps the
        // request so the next time the panel is on screen it tries again.
        if (outcome !== "cancelled") clearRequestedFieldFocus(pendingFocusSeq)
      },
    })
  }, [pendingFocusSeq, pendingFocusField, clearRequestedFieldFocus])

  if (isMultiSelect) {
    return <BulkNodeInspector useStore={useStore} className={className} embedded={embedded} />
  }

  if (!node || !entry) {
    return (
      <aside
        className={cn(
          "flex h-full w-full flex-col items-center justify-center p-6 text-center text-sm text-muted-foreground",
          !embedded && "border-l bg-card/50",
          className
        )}
        data-testid="workflow-inspector-empty"
      >
        <p>{t("empty")}</p>
      </aside>
    )
  }

  const category = workflowNodeCategory(node.data.kind as WorkflowNodeKind)
  const errorCount = validation?.hasErrors ? Object.keys(validation.fields).length : 0

  return (
    <aside
      className={cn("flex h-full w-full flex-col", !embedded && "border-l bg-card/50", className)}
      aria-label={t("closeAria")}
      data-testid="workflow-inspector"
    >
      <header className="flex items-start gap-2 border-b px-4 py-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <Badge variant="outline" className={cn("font-normal", CATEGORY_BADGE[category])}>
              {t(`categoryBadge.${category}`)}
            </Badge>
            {capabilityInfo ? (
              <Badge
                variant="outline"
                title={capabilityInfo.tooltip}
                className="gap-1 font-normal border-wf-status-running/40 text-wf-status-running"
                data-testid="inspector-capability-badge"
              >
                {capabilityInfo.badgeLabel}
              </Badge>
            ) : null}
            {errorCount > 0 ? (
              <button
                type="button"
                onClick={jumpToNextError}
                aria-label={t("jumpToError")}
                data-testid="inspector-error-badge"
                className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Badge variant="destructive" className="gap-1 font-normal pointer-events-none">
                  <AlertCircleIcon className="size-3" aria-hidden="true" />
                  {t("errorBadge", { count: errorCount })}
                </Badge>
              </button>
            ) : null}
          </div>
          <h3 className="mt-1.5 text-sm font-semibold leading-tight">
            {tNodeField(tRoot, {
              kind: node.data.kind,
              pluginId: entry.pluginId,
              field: "label",
              fallback: entry.label,
            })}
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {tNodeField(tRoot, {
              kind: node.data.kind,
              pluginId: entry.pluginId,
              field: "description",
              fallback: entry.description,
            })}
          </p>
        </div>
        {embedded ? null : (
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={clearSelection}
            aria-label={t("closeAria")}
          >
            <XIcon className="size-4" />
          </Button>
        )}
      </header>
      <ScrollArea className="flex-1">
        <div className="px-4 py-4">
          <DataTabs useStore={useStore} nodeId={node.id}>
            <div className="space-y-4" ref={formScrollRef}>
              <Field label={t("label")} htmlFor="ins-label" required>
                <Input
                  id="ins-label"
                  value={node.data.label}
                  onChange={(e) => updateNodeData(node.id, { label: e.target.value })}
                  maxLength={120}
                />
              </Field>
              <Field label={t("notes")} htmlFor="ins-notes" hint={t("notesHint")}>
                <Textarea
                  id="ins-notes"
                  value={node.data.notes ?? ""}
                  onChange={(e) => updateNodeData(node.id, { notes: e.target.value || undefined })}
                  rows={2}
                />
              </Field>
              <div className="flex items-center justify-between gap-2 rounded-md border bg-muted/30 px-3 py-2">
                <div>
                  <p className="text-sm font-medium">{t("disabled")}</p>
                  <p className="text-[11px] text-muted-foreground">{t("disabledHint")}</p>
                </div>
                <Switch
                  checked={node.data.disabled ?? false}
                  onCheckedChange={(v) => updateNodeData(node.id, { disabled: v })}
                  aria-label={t("disabled")}
                />
              </div>
              {supportsErrorHandling(node.data.kind as string) ? (
                <ErrorHandlingSection
                  // Remount when switching nodes so the section's local draft
                  // state (collapsed flag, JSON text) never leaks across nodes.
                  key={node.id}
                  errorHandling={node.data.errorHandling as WorkflowNodeErrorHandling | undefined}
                  onChange={(next) => updateNodeData(node.id, { errorHandling: next })}
                />
              ) : null}
              <Separator />
              <FieldErrorProvider errors={validation?.fields ?? null}>
                <InspectorExpressionProvider store={useStore} currentNodeId={node.id}>
                  <NodeConfigFormSection
                    kind={node.data.kind as WorkflowNodeKind}
                    paramsSchema={entry.paramsSchema}
                    params={configFormParams}
                    onChange={handleParamsChange}
                    typeVersion={node.data.typeVersion as number | undefined}
                  />
                </InspectorExpressionProvider>
              </FieldErrorProvider>
              {!hasDedicatedConfigForEntry({
                kind: node.data.kind as WorkflowNodeKind,
                paramsSchema: entry.paramsSchema,
              }) ? (
                <p className="text-[11px] text-muted-foreground">{t("noConfigYet")}</p>
              ) : null}
            </div>
          </DataTabs>
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
          {t("deleteNode")}
        </Button>
      </footer>
    </aside>
  )
}

/**
 * Memoized export. The inner component already uses three narrow
 * `useShallow` selectors so that unrelated store mutations (drag
 * positions, run-status flips on other nodes, viewport changes) don't
 * cause a re-render. `React.memo` is the second line of defence for the
 * case where the parent (RightSidebar) re-renders with the same
 * `useStore` / `className` props.
 */
export const InspectorPanel = memo(InspectorPanelInner)
