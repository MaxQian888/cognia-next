"use client"

/**
 * Bulk node inspector — shown in the Inspector tab when more than one node
 * is selected on the canvas. Edits the cross-kind-safe fields (`disabled`,
 * `notes`) across the whole selection at once and offers a bulk delete.
 *
 * `params` is kind-specific and intentionally NOT bulk-editable: editing a
 * single node still uses the per-kind form in `InspectorPanel`. This panel
 * routes its writes through `updateNodeDataBatch` so the whole selection is
 * one undo entry.
 */

import { memo, useCallback, useMemo, useState } from "react"
import { useShallow } from "zustand/react/shallow"
import { Trash2Icon } from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { getNodeIndex } from "@/lib/workflow/editor/node-index"
import { supportsErrorHandling } from "@/lib/workflow/editor/node-handles"
import type { EditorState, EditorStore } from "@/lib/workflow/editor/store"
import { Field } from "./inspector/forms/shared"

type BulkOnError = "fail" | "continue" | "errorBranch"

function BulkNodeInspectorInner({
  useStore,
  className,
  embedded = false,
}: {
  useStore: EditorStore
  className?: string
  embedded?: boolean
}) {
  const t = useTranslations("workflows.inspector.bulk")

  const selectedNodeIds = useStore(useShallow((s: EditorState) => s.selectedNodeIds))

  // Tri-state of the `disabled` flag across the selection. `allDisabled`
  // drives the Switch; `mixed` surfaces the "some on, some off" hint.
  const { allDisabled, mixed } = useStore(
    useShallow((s: EditorState) => {
      const byId = getNodeIndex(s.nodes).byId
      let on = 0
      let total = 0
      for (const id of s.selectedNodeIds) {
        const node = byId.get(id)
        if (!node) continue
        total += 1
        if (node.data.disabled) on += 1
      }
      return { allDisabled: total > 0 && on === total, mixed: on > 0 && on < total }
    })
  )

  const { updateNodeDataBatch, removeNodes, clearSelection, setBulkOnError } = useStore(
    useShallow((s: EditorState) => ({
      updateNodeDataBatch: s.updateNodeDataBatch,
      removeNodes: s.removeNodes,
      clearSelection: s.clearSelection,
      setBulkOnError: s.setBulkOnError,
    }))
  )

  // Bulk error-handling onError — only when EVERY selected node supports it.
  // `commonOnError` is the shared value, or "" when the selection is mixed.
  const { allSupportError, commonOnError } = useStore(
    useShallow((s: EditorState) => {
      const byId = getNodeIndex(s.nodes).byId
      let all = s.selectedNodeIds.length > 0
      let common: string | null = null
      let seen = false
      for (const id of s.selectedNodeIds) {
        const node = byId.get(id)
        if (!node) continue
        if (!supportsErrorHandling(node.data.kind as string)) all = false
        const v = (node.data.errorHandling?.onError ?? "fail") as string
        if (!seen) {
          common = v
          seen = true
        } else if (common !== v) {
          common = null
        }
      }
      return { allSupportError: all, commonOnError: common ?? "" }
    })
  )
  const tErr = useTranslations("workflows.editor.errorHandling")

  const [notesDraft, setNotesDraft] = useState("")

  const count = selectedNodeIds.length

  const toggleDisabled = useCallback(
    (v: boolean) => updateNodeDataBatch(selectedNodeIds, { disabled: v }),
    [updateNodeDataBatch, selectedNodeIds]
  )
  const applyNotes = useCallback(
    () => updateNodeDataBatch(selectedNodeIds, { notes: notesDraft.trim() || undefined }),
    [updateNodeDataBatch, selectedNodeIds, notesDraft]
  )
  const clearNotes = useCallback(
    () => updateNodeDataBatch(selectedNodeIds, { notes: undefined }),
    [updateNodeDataBatch, selectedNodeIds]
  )
  const deleteAll = useCallback(() => {
    removeNodes(selectedNodeIds)
  }, [removeNodes, selectedNodeIds])

  const title = useMemo(() => t("title", { count }), [t, count])

  return (
    <aside
      className={cn("flex h-full w-full flex-col", !embedded && "border-l bg-card/50", className)}
      data-testid="workflow-bulk-inspector"
    >
      <header className="flex items-center gap-2 border-b px-4 py-3">
        <Badge variant="secondary" className="font-normal">
          {title}
        </Badge>
      </header>
      <ScrollArea className="flex-1">
        <div className="space-y-4 px-4 py-4">
          <div className="flex items-center justify-between gap-2 rounded-md border bg-muted/30 px-3 py-2">
            <div>
              <p className="text-sm font-medium">{t("disabled")}</p>
              <p className="text-[11px] text-muted-foreground">
                {mixed ? t("disabledMixed") : t("disabledHint")}
              </p>
            </div>
            <Switch
              checked={allDisabled}
              onCheckedChange={toggleDisabled}
              aria-label={t("disabled")}
              data-testid="bulk-disabled-switch"
            />
          </div>

          <Separator />

          <Field label={t("notes")} htmlFor="bulk-notes" hint={t("notesHint")}>
            <Textarea
              id="bulk-notes"
              value={notesDraft}
              onChange={(e) => setNotesDraft(e.target.value)}
              rows={2}
              placeholder={t("notesPlaceholder")}
            />
          </Field>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={applyNotes} data-testid="bulk-notes-apply">
              {t("notesApply")}
            </Button>
            <Button variant="ghost" size="sm" onClick={clearNotes} data-testid="bulk-notes-clear">
              {t("notesClear")}
            </Button>
          </div>

          {allSupportError ? (
            <>
              <Separator />
              <Field label={tErr("onError.label")} hint={tErr("onError.hint")}>
                <Select
                  value={commonOnError}
                  onValueChange={(v) => setBulkOnError(selectedNodeIds, v as BulkOnError)}
                >
                  <SelectTrigger data-testid="bulk-onerror-select">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="fail">{tErr("onError.fail")}</SelectItem>
                    <SelectItem value="continue">{tErr("onError.continue")}</SelectItem>
                    <SelectItem value="errorBranch">{tErr("onError.errorBranch")}</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            </>
          ) : null}
        </div>
      </ScrollArea>
      <footer className="border-t px-4 py-3">
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              variant="outline"
              className="w-full text-destructive hover:bg-destructive/10"
              data-testid="bulk-delete-all"
            >
              <Trash2Icon className="size-4 mr-1.5" />
              {t("deleteAll", { count })}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("deleteAll", { count })}</AlertDialogTitle>
              <AlertDialogDescription>{t("deleteAllConfirm", { count })}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
              <AlertDialogAction
                onClick={deleteAll}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                data-testid="bulk-delete-all-confirm"
              >
                {t("deleteAll", { count })}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        <Button
          variant="ghost"
          size="sm"
          className="mt-2 w-full"
          onClick={() => clearSelection()}
          data-testid="bulk-clear-selection"
        >
          {t("clearSelection")}
        </Button>
      </footer>
    </aside>
  )
}

/**
 * Memoized: the inner component subscribes via narrow `useShallow` slices so
 * unrelated store mutations (drag positions, run-status flips, viewport)
 * don't re-render it.
 */
export const BulkNodeInspector = memo(BulkNodeInspectorInner)
