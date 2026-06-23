"use client"

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { LockIcon, PencilIcon } from "lucide-react"
import type { ExternalMemoryFile } from "@/lib/memory/external/types"
import { loadExternalFile, saveExternalFile } from "@/lib/memory/external/edit"
import { Button } from "@/components/ui/button"
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
import { LightCodeEditor } from "@/components/editor/light-code-editor"

export interface ExternalMemoryEditorProps {
  file: ExternalMemoryFile | null
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Roots a write must stay within (from `useExternalMemory`). */
  allowedRoots: string[]
  /** Called after a successful save so the list can refresh sizes. */
  onSaved?: () => void
}

/**
 * View / guarded-edit dialog for one external agent-memory file. Read-only by
 * default; "编辑" unlocks editing only for editable files, and saving requires an
 * explicit confirmation that warns a `.bak` backup is written before overwrite.
 */
export function ExternalMemoryEditor({
  file,
  open,
  onOpenChange,
  allowedRoots,
  onSaved,
}: ExternalMemoryEditorProps) {
  const t = useTranslations("memory.external")
  const [content, setContent] = useState("")
  const [draft, setDraft] = useState("")
  const [editing, setEditing] = useState(false)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [saving, setSaving] = useState(false)

  const absPath = file?.absPath ?? null

  useEffect(() => {
    if (!open || !absPath) return
    let cancelled = false
    const load = async () => {
      setEditing(false)
      setLoadError(false)
      if (!file?.exists) {
        // Slot known but not yet on disk — start from an empty buffer.
        setContent("")
        setDraft("")
        return
      }
      setLoading(true)
      try {
        const text = await loadExternalFile(absPath)
        if (!cancelled) {
          setContent(text)
          setDraft(text)
        }
      } catch {
        if (!cancelled) setLoadError(true)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [open, absPath, file?.exists])

  if (!file) return null

  const handleSave = async () => {
    setConfirmOpen(false)
    setSaving(true)
    try {
      const { backupPath } = await saveExternalFile(file.absPath, draft, { allowedRoots })
      setContent(draft)
      setEditing(false)
      toast.success(backupPath ? t("toast.savedWithBackup") : t("toast.saved"))
      onSaved?.()
    } catch (e) {
      toast.error(t("toast.saveFailed", { error: e instanceof Error ? e.message : String(e) }))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] max-w-3xl flex-col gap-3">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 break-all">
            {!file.editable && <LockIcon className="size-4 shrink-0" />}
            {file.label}
          </DialogTitle>
          <DialogDescription className="break-all">{file.absPath}</DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-hidden rounded-md border">
          {loadError ? (
            <p className="p-4 text-sm text-destructive">{t("loadError")}</p>
          ) : loading ? (
            <p className="p-4 text-sm text-muted-foreground">{t("loading")}</p>
          ) : (
            <LightCodeEditor
              value={editing ? draft : content}
              onChange={setDraft}
              language="markdown"
              readOnly={!editing}
              diagnostics={false}
              aria-label={t("editorLabel")}
              data-testid="external-memory-editor"
              className="h-[55vh]"
            />
          )}
        </div>

        <DialogFooter className="gap-2">
          {file.editable && !editing && !loadError && (
            <Button variant="outline" onClick={() => setEditing(true)} data-testid="external-edit">
              <PencilIcon className="size-4" />
              {t("edit")}
            </Button>
          )}
          {editing && (
            <>
              <Button
                variant="ghost"
                onClick={() => {
                  setDraft(content)
                  setEditing(false)
                }}
              >
                {t("cancel")}
              </Button>
              <Button
                onClick={() => setConfirmOpen(true)}
                disabled={saving || draft === content}
                data-testid="external-save"
              >
                {t("save")}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("confirm.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("confirm.description", { path: file.absPath })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={handleSave}>{t("confirm.action")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  )
}
