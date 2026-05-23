"use client"

/**
 * Detail dialog for a single shared-memory entry: full value (pretty-printed
 * when JSON-ish), copy-to-clipboard, edit (re-opens the composer), and a
 * confirm-gated delete.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"

import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { deleteEntry } from "@/lib/ai/agent/team/shared-memory-orchestrator"
import type { SharedMemoryEntry } from "@/types/agent/agent-team"
import { ConfirmActionDialog } from "./confirm-action-dialog"
import { markSettingsSaved } from "./settings-save-indicator"

export interface MemoryEntryDetailProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  teamId: string
  entry: SharedMemoryEntry | null
  onEdit: (entry: SharedMemoryEntry) => void
}

function prettyValue(value: unknown): string {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

export function MemoryEntryDetail({
  open,
  onOpenChange,
  teamId,
  entry,
  onEdit,
}: MemoryEntryDetailProps) {
  const t = useTranslations("agentTeamsWorkspace.settings.memory.detail")
  const tConfirm = useTranslations("agentTeamsWorkspace.settings.confirm")
  const [copied, setCopied] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)

  if (!entry) return null

  const handleCopy = () => {
    void navigator.clipboard?.writeText(prettyValue(entry.value)).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  const handleDelete = () => {
    deleteEntry(teamId, entry.key)
    markSettingsSaved()
    setDeleteOpen(false)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{entry.key}</code>
            <Badge variant="outline" className="text-[10px]">
              v{entry.version}
            </Badge>
          </DialogTitle>
        </DialogHeader>
        <ScrollArea className="max-h-[300px] rounded-md border p-2">
          <pre className="whitespace-pre-wrap break-words text-xs">{prettyValue(entry.value)}</pre>
        </ScrollArea>
        {entry.tags && entry.tags.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {entry.tags.map((tag) => (
              <Badge key={tag} variant="secondary" className="font-mono text-[10px]">
                {tag}
              </Badge>
            ))}
          </div>
        ) : null}
        <DialogFooter className="gap-2 sm:justify-between">
          <Button variant="outline" size="sm" onClick={handleCopy}>
            {copied ? t("copied") : t("copy")}
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => onEdit(entry)}>
              {t("edit")}
            </Button>
            <Button variant="destructive" size="sm" onClick={() => setDeleteOpen(true)}>
              {t("delete")}
            </Button>
          </div>
        </DialogFooter>

        <ConfirmActionDialog
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          title={t("delete")}
          description={tConfirm("clearMemory.description")}
          confirmLabel={tConfirm("confirmLabel")}
          cancelLabel={tConfirm("cancelLabel")}
          onConfirm={handleDelete}
        />
      </DialogContent>
    </Dialog>
  )
}
