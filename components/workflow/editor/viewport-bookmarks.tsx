"use client"

/**
 * Toolbar dropdown that lists named viewport bookmarks for the current
 * workflow and lets the user save the current viewport under a new name.
 *
 * Persistence: `lib/workflow/editor/viewport-bookmarks-db.ts` (Dexie). The
 * dropdown is driven by `useLiveQuery` so new bookmarks land instantly
 * everywhere they appear.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { toast } from "sonner"
import { BookmarkIcon, PlusIcon, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import {
  deleteBookmark,
  listBookmarks,
  saveBookmark,
} from "@/lib/workflow/editor/viewport-bookmarks-db"
import type { Viewport } from "@xyflow/react"

export interface ViewportBookmarksProps {
  workflowId: string
  currentViewport: Viewport
  onRestore: (viewport: Viewport) => void
  className?: string
}

export function ViewportBookmarks({
  workflowId,
  currentViewport,
  onRestore,
  className,
}: ViewportBookmarksProps) {
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
    <>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className={cn("h-8 gap-1.5", className)}
                aria-label={t("label")}
                data-testid="viewport-bookmarks-trigger"
              >
                <BookmarkIcon className="size-4" aria-hidden />
                <span className="hidden md:inline">{t("label")}</span>
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t("label")}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuItem onSelect={openDialog} data-testid="viewport-bookmarks-save">
            <PlusIcon className="size-4" aria-hidden />
            {t("saveCurrent")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {bookmarks.length === 0 ? (
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              {t("empty")}
            </DropdownMenuLabel>
          ) : (
            bookmarks.map((b) => (
              <DropdownMenuItem
                key={b.id}
                className="flex items-center gap-2"
                onSelect={() => onRestore(b.viewport)}
                data-testid={`viewport-bookmark-row-${b.id}`}
              >
                <span className="flex-1 truncate">{b.name}</span>
                <span className="text-xs text-muted-foreground">
                  ×{Math.round(b.viewport.zoom * 100)}%
                </span>
                <button
                  type="button"
                  aria-label={t("delete")}
                  className="ml-1 inline-flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:bg-destructive/15 hover:text-destructive"
                  onClick={(e) => {
                    e.stopPropagation()
                    void deleteBookmark(b.id)
                  }}
                  data-testid={`viewport-bookmark-delete-${b.id}`}
                >
                  <Trash2 className="size-3" aria-hidden />
                </button>
              </DropdownMenuItem>
            ))
          )}
        </DropdownMenuContent>
      </DropdownMenu>

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
    </>
  )
}
