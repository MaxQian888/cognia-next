"use client"

/**
 * The bottom sheet a long press on the canvas opens.
 *
 * It is the phone's answer to the desktop right-click menu, and it carries the
 * same actions through the same store calls. Before it, the only destructive
 * action reachable on a phone was Delete inside the node inspector, and there
 * was no copy, no paste and no run-from-here at all.
 */

import { useTranslations } from "next-intl"
import {
  Copy as CopyIcon,
  ClipboardPaste as PasteIcon,
  CopyPlus as DuplicateIcon,
  Play as RunFromIcon,
  SquarePlay as RunOneIcon,
  Settings2 as ConfigureIcon,
  Trash2 as DeleteIcon,
  Crosshair as FitIcon,
  Search as SearchIcon,
  Plus as AddIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { useBackDismiss } from "@/hooks/ui/use-back-dismiss"
import type { CanvasPressTarget } from "./use-canvas-long-press"

export interface MobileCanvasActionSheetProps {
  target: CanvasPressTarget | null
  onOpenChange: (open: boolean) => void
  onAddNode: () => void
  onConfigure: (nodeId: string) => void
  onDuplicate: (nodeId: string) => void
  onCopy: (nodeId: string) => void
  onPaste: () => void
  onRunFrom: (nodeId: string) => void
  onRunOnly: (nodeId: string) => void
  onDeleteNode: (nodeId: string) => void
  onDeleteEdge: (edgeId: string) => void
  onFitView: () => void
  /** Open canvas-scoped node search. */
  onFindNode: () => void
  /** False while the clipboard holds nothing this editor can paste. */
  canPaste: boolean
}

interface Action {
  key: string
  icon: typeof CopyIcon
  label: string
  run: () => void
  destructive?: boolean
}

export function MobileCanvasActionSheet({
  target,
  onOpenChange,
  onAddNode,
  onConfigure,
  onDuplicate,
  onCopy,
  onPaste,
  onRunFrom,
  onRunOnly,
  onDeleteNode,
  onDeleteEdge,
  onFitView,
  onFindNode,
  canPaste,
}: MobileCanvasActionSheetProps) {
  const t = useTranslations("mobile.workflow.editor.actions")
  const open = target !== null
  useBackDismiss(open, () => onOpenChange(false))

  const close = () => onOpenChange(false)
  const run = (fn: () => void) => () => {
    fn()
    close()
  }

  const actions: Action[] = (() => {
    if (!target) return []
    if (target.kind === "node") {
      const id = target.id
      return [
        { key: "configure", icon: ConfigureIcon, label: t("configure"), run: run(() => onConfigure(id)) },
        { key: "runFrom", icon: RunFromIcon, label: t("runFrom"), run: run(() => onRunFrom(id)) },
        { key: "runOnly", icon: RunOneIcon, label: t("runOnly"), run: run(() => onRunOnly(id)) },
        { key: "duplicate", icon: DuplicateIcon, label: t("duplicate"), run: run(() => onDuplicate(id)) },
        { key: "copy", icon: CopyIcon, label: t("copy"), run: run(() => onCopy(id)) },
        { key: "delete", icon: DeleteIcon, label: t("delete"), run: run(() => onDeleteNode(id)), destructive: true },
      ]
    }
    if (target.kind === "edge") {
      const id = target.id
      return [
        {
          key: "deleteEdge",
          icon: DeleteIcon,
          label: t("deleteConnection"),
          run: run(() => onDeleteEdge(id)),
          destructive: true,
        },
      ]
    }
    return [
      { key: "addNode", icon: AddIcon, label: t("addNode"), run: run(onAddNode) },
      ...(canPaste ? [{ key: "paste", icon: PasteIcon, label: t("paste"), run: run(onPaste) }] : []),
      { key: "findNode", icon: SearchIcon, label: t("findNode"), run: run(onFindNode) },
      { key: "fitView", icon: FitIcon, label: t("fitView"), run: run(onFitView) },
    ]
  })()

  return (
    <Sheet open={open} onOpenChange={(next) => (next ? undefined : close())}>
      <SheetContent
        side="bottom"
        className="gap-0 pb-[calc(env(safe-area-inset-bottom,0px)+0.5rem)]"
        data-testid="mobile-canvas-actions"
        aria-describedby={undefined}
      >
        <SheetHeader className="pb-1">
          <SheetTitle className="text-sm">
            {target?.kind === "node"
              ? t("titleNode")
              : target?.kind === "edge"
                ? t("titleEdge")
                : t("titleCanvas")}
          </SheetTitle>
        </SheetHeader>
        <div className="flex flex-col">
          {actions.map((action) => (
            <Button
              key={action.key}
              type="button"
              variant="ghost"
              className={`min-h-12 justify-start px-4 text-sm ${action.destructive ? "text-destructive" : ""}`}
              onClick={action.run}
              data-testid={`mobile-canvas-action-${action.key}`}
            >
              <action.icon className="mr-3 size-4" aria-hidden="true" />
              {action.label}
            </Button>
          ))}
        </div>
      </SheetContent>
    </Sheet>
  )
}
