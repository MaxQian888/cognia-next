"use client"

/**
 * Edge inspector — shown in the Inspector tab when a connection (edge) is
 * selected and no node is. Edits the edge's label and kind, reverses its
 * direction, or deletes it. Multi-edge selections collapse to a count + a
 * bulk delete.
 *
 * Field-naming note: the canvas edge renderer (`edges/smart-edge.tsx`) reads
 * `data.label` / `data.kind`, while the save converter
 * (`react-flow-converter.reactFlowToWorkflow`) reads the top-level `label`
 * and `data.workflowKind`. To make an edit both render live AND survive a
 * save, we write all of them: top-level `label`, `data.label`, `data.kind`
 * and `data.workflowKind`.
 */

import { memo, useCallback, useMemo } from "react"
import { useShallow } from "zustand/react/shallow"
import { ArrowLeftRightIcon, Trash2Icon, AlertTriangleIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { getNodeIndex } from "@/lib/workflow/editor/node-index"
import { getEdgeIndex } from "@/lib/workflow/editor/edge-index"
import type { WorkflowEdgeKind } from "@/types/workflow/visual"
import type { EditorState, EditorStore } from "@/lib/workflow/editor/store"
import { Field } from "./inspector/forms/shared"

const EDGE_KINDS: WorkflowEdgeKind[] = ["default", "conditional", "parallel", "loop", "error"]

function EdgeInspectorInner({
  useStore,
  className,
  embedded = false,
}: {
  useStore: EditorStore
  className?: string
  embedded?: boolean
}) {
  const t = useTranslations("workflows.edgeInspector")

  const selectedEdgeIds = useStore(useShallow((s: EditorState) => s.selectedEdgeIds))
  const selectedId = selectedEdgeIds[0] ?? null

  // Resolve the edge + endpoint labels in one shallow slice. Returns the same
  // refs whenever the selected edge / its endpoints don't change, so unrelated
  // mutations bail out of the shallow equality.
  const { edge, sourceLabel, targetLabel } = useStore(
    useShallow((s: EditorState) => {
      if (!selectedId) return { edge: null, sourceLabel: "", targetLabel: "" }
      const e = getEdgeIndex(s.edges).byId.get(selectedId) ?? null
      if (!e) return { edge: null, sourceLabel: "", targetLabel: "" }
      const byNode = getNodeIndex(s.nodes).byId
      return {
        edge: e,
        sourceLabel: byNode.get(e.source)?.data.label ?? e.source,
        targetLabel: byNode.get(e.target)?.data.label ?? e.target,
      }
    })
  )

  const { updateEdgeData, replaceEdge, removeEdges } = useStore(
    useShallow((s: EditorState) => ({
      updateEdgeData: s.updateEdgeData,
      replaceEdge: s.replaceEdge,
      removeEdges: s.removeEdges,
    }))
  )

  const currentLabel = useMemo(() => {
    const fromData = (edge?.data as { label?: unknown } | undefined)?.label
    if (typeof fromData === "string") return fromData
    return typeof edge?.label === "string" ? edge.label : ""
  }, [edge])

  const currentKind = useMemo<WorkflowEdgeKind>(() => {
    const data = edge?.data as { kind?: unknown; workflowKind?: unknown } | undefined
    const v = data?.kind ?? data?.workflowKind
    if (typeof v === "string" && (EDGE_KINDS as string[]).includes(v)) return v as WorkflowEdgeKind
    if (edge?.sourceHandle === "error") return "error"
    return "default"
  }, [edge])

  const setLabel = useCallback(
    (value: string) => {
      if (!edge) return
      const next = value.trim() ? value : undefined
      // Top-level for the save path; data.label for the live canvas chip.
      replaceEdge(edge.id, {
        label: next,
        data: { ...((edge.data as Record<string, unknown>) ?? {}), label: next },
      })
    },
    [edge, replaceEdge]
  )

  const setKind = useCallback(
    (value: WorkflowEdgeKind) => {
      if (!edge) return
      // data.kind for the live canvas chip; data.workflowKind for the save path.
      updateEdgeData(edge.id, { kind: value, workflowKind: value })
    },
    [edge, updateEdgeData]
  )

  const currentComment = useMemo(() => {
    const v = (edge?.data as { comment?: unknown } | undefined)?.comment
    return typeof v === "string" ? v : ""
  }, [edge])

  const setComment = useCallback(
    (value: string) => {
      if (!edge) return
      updateEdgeData(edge.id, { comment: value.trim() ? value : undefined })
    },
    [edge, updateEdgeData]
  )

  const reverse = useCallback(() => {
    if (!edge) return
    replaceEdge(edge.id, {
      source: edge.target,
      target: edge.source,
      sourceHandle: edge.targetHandle,
      targetHandle: edge.sourceHandle,
    })
  }, [edge, replaceEdge])

  const deleteEdge = useCallback(() => {
    if (!edge) return
    removeEdges([edge.id])
  }, [edge, removeEdges])

  // Multi-edge selection → count + bulk delete only.
  if (selectedEdgeIds.length > 1) {
    return (
      <aside
        className={cn("flex h-full w-full flex-col", !embedded && "border-l bg-card/50", className)}
        data-testid="workflow-edge-inspector"
      >
        <header className="flex items-center gap-2 border-b px-4 py-3">
          <Badge variant="secondary" className="font-normal">
            {t("multiSelected", { count: selectedEdgeIds.length })}
          </Badge>
        </header>
        <footer className="mt-auto border-t px-4 py-3">
          <Button
            variant="outline"
            className="w-full text-destructive hover:bg-destructive/10"
            onClick={() => removeEdges(selectedEdgeIds)}
            data-testid="edge-delete-all"
          >
            <Trash2Icon className="size-4 mr-1.5" />
            {t("deleteAll")}
          </Button>
        </footer>
      </aside>
    )
  }

  if (!edge) {
    return (
      <aside
        className={cn(
          "flex h-full w-full flex-col items-center justify-center p-6 text-center text-sm text-muted-foreground",
          !embedded && "border-l bg-card/50",
          className
        )}
        data-testid="workflow-edge-inspector-empty"
      >
        <p>{t("title")}</p>
      </aside>
    )
  }

  const isErrorHandle = edge.sourceHandle === "error"

  return (
    <aside
      className={cn("flex h-full w-full flex-col", !embedded && "border-l bg-card/50", className)}
      data-testid="workflow-edge-inspector"
    >
      <header className="flex items-center gap-2 border-b px-4 py-3">
        <Badge variant="outline" className="font-normal">
          {t("title")}
        </Badge>
      </header>
      <ScrollArea className="flex-1">
        <div className="space-y-4 px-4 py-4">
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            <span className="text-muted-foreground">{t("source")}</span>
            <span className="truncate font-medium" data-testid="edge-source">
              {sourceLabel}
            </span>
            <span className="text-muted-foreground">{t("target")}</span>
            <span className="truncate font-medium" data-testid="edge-target">
              {targetLabel}
            </span>
          </div>

          {isErrorHandle ? (
            <p className="flex items-start gap-1.5 rounded-md bg-rose-500/10 px-2.5 py-1.5 text-[11px] text-rose-700 dark:text-rose-300">
              <AlertTriangleIcon className="size-3.5 shrink-0 mt-px" aria-hidden="true" />
              {t("errorHandleHint")}
            </p>
          ) : null}

          <Separator />

          <Field label={t("label")} htmlFor="edge-label" hint={t("labelHint")}>
            <Input
              id="edge-label"
              value={currentLabel}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={t("labelPlaceholder")}
              maxLength={120}
            />
          </Field>

          <Field label={t("kind")} hint={t("kindHint")}>
            <Select value={currentKind} onValueChange={(v) => setKind(v as WorkflowEdgeKind)}>
              <SelectTrigger data-testid="edge-kind-select">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EDGE_KINDS.map((k) => (
                  <SelectItem key={k} value={k}>
                    {t(`kindOption.${k}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field label={t("comment")} htmlFor="edge-comment" hint={t("commentHint")}>
            <Textarea
              id="edge-comment"
              value={currentComment}
              onChange={(e) => setComment(e.target.value)}
              placeholder={t("commentPlaceholder")}
              rows={2}
              data-testid="edge-comment"
            />
          </Field>

          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={reverse}
            data-testid="edge-reverse"
          >
            <ArrowLeftRightIcon className="size-4 mr-1.5" />
            {t("reverse")}
          </Button>
        </div>
      </ScrollArea>
      <footer className="border-t px-4 py-3">
        <Button
          variant="outline"
          className="w-full text-destructive hover:bg-destructive/10"
          onClick={deleteEdge}
          data-testid="edge-delete"
        >
          <Trash2Icon className="size-4 mr-1.5" />
          {t("delete")}
        </Button>
      </footer>
    </aside>
  )
}

/**
 * Memoized: the inner component subscribes via narrow `useShallow` slices so
 * unrelated store mutations don't re-render it.
 */
export const EdgeInspector = memo(EdgeInspectorInner)
