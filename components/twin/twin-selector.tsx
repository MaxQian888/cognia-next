"use client"

/**
 * Workbench twin selector — dropdown of every (non-archived) twin plus the
 * "create new" / "rename" / "clone" / "archive" / "delete" actions for the
 * currently-selected one.
 *
 * Selection drives the URL — picking a twin pushes `?twinId=<id>` so deep
 * links survive page reloads and share copies. `TwinPanel` owns the URL
 * sync; this component just calls `onSelect(id)`.
 *
 * Modal flows (create / rename / clone / delete) are local-state dialogs
 * built on shadcn `Dialog` + `AlertDialog`. They call into `lib/db/twins.ts`
 * directly — Dexie `useLiveQuery` in the parent picks up the changes.
 */

import { memo, useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import {
  ChevronDown,
  Copy as CopyIcon,
  Pencil,
  Plus,
  Trash2,
  Archive as ArchiveIcon,
  ArchiveRestore,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { buttonVariants } from "@/components/ui/button"
import type { Twin } from "@/types/twin"
import {
  archiveTwin,
  cloneTwin,
  createTwin,
  deleteTwin,
  renameTwin,
  type DeleteTwinResult,
} from "@/lib/db/twins"

export interface TwinSelectorProps {
  twins: Twin[]
  activeTwinId: string | null
  onSelect: (twinId: string) => void
  /** Called after a destructive cascade with the row counts, so parent can show a toast. */
  onAfterDelete?: (id: string, result: DeleteTwinResult) => void
  /** Called after a create / clone so parent can switch to the new id. */
  onAfterCreate?: (twin: Twin) => void
  /** Optional: show archived rows under a divider. Default false. */
  includeArchived?: boolean
}

type ModalMode = "idle" | "create" | "rename" | "clone" | "delete"

interface ModalState {
  mode: ModalMode
  /** Pre-filled name field for create/rename/clone. */
  draftName: string
  /** The target twin for rename/clone/delete; null for create. */
  target: Twin | null
  busy: boolean
  error: string | null
}

const IDLE: ModalState = { mode: "idle", draftName: "", target: null, busy: false, error: null }

export const TwinSelector = memo(function TwinSelector({
  twins,
  activeTwinId,
  onSelect,
  onAfterDelete,
  onAfterCreate,
  includeArchived = false,
}: TwinSelectorProps) {
  const t = useTranslations("twin.selector")
  const [modal, setModal] = useState<ModalState>(IDLE)

  const activeTwin = twins.find((tw) => tw.id === activeTwinId) ?? null

  // Reset busy/error when the modal opens
  useEffect(() => {
    if (modal.mode === "idle") return
    setModal((prev) => ({ ...prev, busy: false, error: null }))
  }, [modal.mode])

  const openCreate = useCallback(() => {
    setModal({ mode: "create", draftName: "", target: null, busy: false, error: null })
  }, [])

  const openRename = useCallback((twin: Twin) => {
    setModal({ mode: "rename", draftName: twin.name, target: twin, busy: false, error: null })
  }, [])

  const openClone = useCallback((twin: Twin) => {
    setModal({
      mode: "clone",
      draftName: `${twin.name} (copy)`,
      target: twin,
      busy: false,
      error: null,
    })
  }, [])

  const openDelete = useCallback((twin: Twin) => {
    setModal({ mode: "delete", draftName: twin.name, target: twin, busy: false, error: null })
  }, [])

  const close = useCallback(() => setModal(IDLE), [])

  const handleCreate = useCallback(async () => {
    const name = modal.draftName.trim()
    if (!name) {
      setModal((prev) => ({ ...prev, error: t("nameRequired") }))
      return
    }
    setModal((prev) => ({ ...prev, busy: true, error: null }))
    try {
      const twin = await createTwin({ name })
      onAfterCreate?.(twin)
      onSelect(twin.id)
      close()
    } catch (err) {
      setModal((prev) => ({ ...prev, busy: false, error: String(err) }))
    }
  }, [modal.draftName, onAfterCreate, onSelect, close, t])

  const handleRename = useCallback(async () => {
    if (!modal.target) return
    const name = modal.draftName.trim()
    if (!name) {
      setModal((prev) => ({ ...prev, error: t("nameRequired") }))
      return
    }
    setModal((prev) => ({ ...prev, busy: true, error: null }))
    try {
      await renameTwin(modal.target.id, name)
      close()
    } catch (err) {
      setModal((prev) => ({ ...prev, busy: false, error: String(err) }))
    }
  }, [modal.target, modal.draftName, close, t])

  const handleClone = useCallback(async () => {
    if (!modal.target) return
    setModal((prev) => ({ ...prev, busy: true, error: null }))
    try {
      const cloned = await cloneTwin(modal.target.id, modal.draftName)
      onAfterCreate?.(cloned)
      onSelect(cloned.id)
      close()
    } catch (err) {
      setModal((prev) => ({ ...prev, busy: false, error: String(err) }))
    }
  }, [modal.target, modal.draftName, onAfterCreate, onSelect, close])

  const handleArchiveToggle = useCallback(async (twin: Twin) => {
    await archiveTwin(twin.id, !twin.archived)
  }, [])

  const handleDelete = useCallback(async () => {
    if (!modal.target) return
    setModal((prev) => ({ ...prev, busy: true, error: null }))
    try {
      const result = await deleteTwin(modal.target.id)
      onAfterDelete?.(modal.target.id, result)
      // If we deleted the active one, fall back to the next visible twin.
      if (modal.target.id === activeTwinId) {
        const next = twins.find((tw) => tw.id !== modal.target!.id && !tw.archived)
        if (next) onSelect(next.id)
      }
      close()
    } catch (err) {
      setModal((prev) => ({ ...prev, busy: false, error: String(err) }))
    }
  }, [modal.target, activeTwinId, twins, onAfterDelete, onSelect, close])

  const visibleTwins = includeArchived ? twins : twins.filter((tw) => !tw.archived)
  const archivedTwins = includeArchived ? [] : twins.filter((tw) => tw.archived)

  return (
    <div className="flex items-center gap-2" data-testid="twin-selector">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="gap-2"
            aria-label={activeTwin ? t("activeTwinAria", { name: activeTwin.name }) : t("noActive")}
          >
            {activeTwin?.color ? (
              <span
                aria-hidden
                className="inline-block size-3 rounded-full"
                style={{ background: activeTwin.color }}
              />
            ) : null}
            <span className="max-w-[14ch] truncate">{activeTwin?.name ?? t("noActive")}</span>
            <ChevronDown className="size-3.5 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-[14rem]">
          <DropdownMenuLabel>{t("switchTo")}</DropdownMenuLabel>
          {visibleTwins.length === 0 ? (
            <DropdownMenuItem disabled>{t("noTwinsHint")}</DropdownMenuItem>
          ) : (
            visibleTwins.map((twin) => (
              <DropdownMenuItem
                key={twin.id}
                onSelect={() => onSelect(twin.id)}
                className="flex items-center gap-2"
                data-testid={`twin-selector-item-${twin.id}`}
              >
                {twin.color ? (
                  <span
                    aria-hidden
                    className="inline-block size-3 rounded-full"
                    style={{ background: twin.color }}
                  />
                ) : (
                  <span aria-hidden className="bg-muted inline-block size-3 rounded-full" />
                )}
                <span className="truncate">{twin.name}</span>
                {twin.id === activeTwinId ? (
                  <span className="text-muted-foreground ml-auto text-xs">✓</span>
                ) : null}
              </DropdownMenuItem>
            ))
          )}
          {archivedTwins.length > 0 ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-muted-foreground text-xs">
                {t("archivedHeader")}
              </DropdownMenuLabel>
              {archivedTwins.map((twin) => (
                <DropdownMenuItem
                  key={twin.id}
                  onSelect={() => handleArchiveToggle(twin)}
                  className="flex items-center gap-2"
                >
                  <ArchiveRestore className="size-3.5 opacity-60" />
                  <span className="truncate">{twin.name}</span>
                </DropdownMenuItem>
              ))}
            </>
          ) : null}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={openCreate} data-testid="twin-selector-new">
            <Plus className="size-3.5 opacity-60" /> {t("newTwin")}
          </DropdownMenuItem>
          {activeTwin ? (
            <>
              <DropdownMenuItem onSelect={() => openRename(activeTwin)}>
                <Pencil className="size-3.5 opacity-60" /> {t("rename")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => openClone(activeTwin)}>
                <CopyIcon className="size-3.5 opacity-60" /> {t("clone")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => handleArchiveToggle(activeTwin)}>
                <ArchiveIcon className="size-3.5 opacity-60" />{" "}
                {activeTwin.archived ? t("unarchive") : t("archive")}
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => openDelete(activeTwin)}
                data-testid="twin-selector-delete"
              >
                <Trash2 className="size-3.5" /> {t("delete")}
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Create / Rename / Clone share one Dialog (text input + confirm) */}
      <Dialog
        open={modal.mode === "create" || modal.mode === "rename" || modal.mode === "clone"}
        onOpenChange={(open) => {
          if (!open && !modal.busy) close()
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {modal.mode === "create"
                ? t("createTitle")
                : modal.mode === "rename"
                  ? t("renameTitle")
                  : t("cloneTitle")}
            </DialogTitle>
            <DialogDescription>
              {modal.mode === "create"
                ? t("createDescription")
                : modal.mode === "rename"
                  ? t("renameDescription")
                  : t("cloneDescription")}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="twin-selector-name">{t("nameLabel")}</Label>
            <Input
              id="twin-selector-name"
              data-testid="twin-selector-name-input"
              value={modal.draftName}
              onChange={(e) => setModal((prev) => ({ ...prev, draftName: e.target.value }))}
              autoFocus
              disabled={modal.busy}
            />
            {modal.error ? <p className="text-destructive text-sm">{modal.error}</p> : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={close} disabled={modal.busy}>
              {t("cancel")}
            </Button>
            <Button
              onClick={
                modal.mode === "create"
                  ? handleCreate
                  : modal.mode === "rename"
                    ? handleRename
                    : handleClone
              }
              disabled={modal.busy}
              data-testid="twin-selector-name-submit"
            >
              {modal.busy
                ? t("busy")
                : modal.mode === "create"
                  ? t("create")
                  : modal.mode === "rename"
                    ? t("save")
                    : t("clone")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete cascade confirmation */}
      <AlertDialog
        open={modal.mode === "delete"}
        onOpenChange={(open) => {
          if (!open && !modal.busy) close()
        }}
      >
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("deleteDescription", { name: modal.target?.name ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {modal.error ? (
            <p className="text-destructive text-sm" data-testid="twin-selector-delete-error">
              {modal.error}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={modal.busy}>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({ variant: "destructive" })}
              onClick={handleDelete}
              disabled={modal.busy}
              data-testid="twin-selector-delete-confirm"
            >
              {modal.busy ? t("busy") : t("delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
})
