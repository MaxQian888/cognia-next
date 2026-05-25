"use client"

/**
 * Saved-views ("viewport bookmarks") content for the workflow editor canvas
 * toolbar. Lists named viewport bookmarks for the current workflow and lets the
 * user save the current viewport under a new name.
 *
 * Rendered inside the canvas toolbar's "View" popover (see `canvas-toolbar.tsx`)
 * as plain content — rows are buttons, not dropdown items — so it composes
 * cleanly without nesting a menu inside a popover. The save dialog portals
 * above everything.
 *
 * Persistence: `lib/workflow/editor/viewport-bookmarks-db.ts` (Dexie). Driven by
 * `useLiveQuery` so new bookmarks land instantly.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { toast } from "sonner"
import { PlusIcon, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"
import {
  deleteBookmark,
  listBookmarks,
  saveBookmark,
} from "@/lib/workflow/editor/viewport-bookmarks-db"
import type { Viewport } from "@xyflow/react"

export interface ViewportBookmarksContentProps {
  workflowId: string
  currentViewport: Viewport
  onRestore: (viewport: Viewport) => void
  className?: string
}

export function ViewportBookmarksContent({
  workflowId,
  currentViewport,
  onRestore,
  className,
}: ViewportBookmarksContentProps) {
  const t = useTranslations("workflows.editor.bookmarks")
  const bookmarks = useLiveQuery(() => listBookmarks(workflowId), [workflowId], []) ?? []
  const [dialogOpen, setDialogOpen] = useState(false)
  const [draft, setDraft] = useState("")

  const openDialog = () => {
    setDraft(t("viewAt", { zoom: Math.round(currentViewport.zoom * 100) }))
    setDialogOpen(true)
  }

  const handleSave = async () => {
    await saveBookmark(workflowId, draft, currentViewport)
    setDialogOpen(false)
    toast.success(t("savedToast"))
  }

  return (
    <div className={cn("space-y-1", className)} data-testid="viewport-bookmarks-content">
      <div className="text-sm font-medium">{t("label")}</div>
      <button
        type="button"
        onClick={openDialog}
        className="flex w-full items-center gap-2 rounded-sm px-1.5 py-1 text-sm hover:bg-accent hover:text-accent-foreground"
        data-testid="viewport-bookmarks-save"
      >
        <PlusIcon className="size-4" aria-hidden />
        {t("saveCurrent")}
      </button>
      <Separator />
      {bookmarks.length === 0 ? (
        <p className="px-1.5 py-1 text-xs text-muted-foreground">{t("empty")}</p>
      ) : (
        <div className="max-h-56 overflow-y-auto">
          {bookmarks.map((b) => (
            <div key={b.id} className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => onRestore(b.viewport)}
                className="flex flex-1 items-center gap-2 rounded-sm px-1.5 py-1 text-sm hover:bg-accent hover:text-accent-foreground"
                data-testid={`viewport-bookmark-row-${b.id}`}
              >
                <span className="flex-1 truncate text-left">{b.name}</span>
                <span className="text-xs text-muted-foreground">
                  ×{Math.round(b.viewport.zoom * 100)}%
                </span>
              </button>
              <button
                type="button"
                aria-label={t("delete")}
                className="inline-flex size-6 items-center justify-center rounded-sm text-muted-foreground hover:bg-destructive/15 hover:text-destructive"
                onClick={() => void deleteBookmark(b.id)}
                data-testid={`viewport-bookmark-delete-${b.id}`}
              >
                <Trash2 className="size-3" aria-hidden />
              </button>
            </div>
          ))}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("dialogTitle")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="viewport-bookmark-name">{t("dialogNameLabel")}</Label>
            <Input
              id="viewport-bookmark-name"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={t("dialogNamePlaceholder")}
              autoFocus
              data-testid="viewport-bookmark-name-input"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault()
                  void handleSave()
                }
              }}
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setDialogOpen(false)}
              data-testid="viewport-bookmark-cancel"
            >
              {t("cancel")}
            </Button>
            <Button
              type="button"
              onClick={() => void handleSave()}
              data-testid="viewport-bookmark-confirm"
            >
              {t("save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
