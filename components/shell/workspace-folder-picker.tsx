"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { ArrowUpIcon, ChevronRightIcon, FolderIcon, Loader2Icon } from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { defaultExportDir } from "@/lib/claude/ipc"
import { listWorkspaceDir } from "@/lib/files/workspace-fs"
import type { WorkspaceEntry } from "@/lib/files/types"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialPath?: string
  onSelect: (path: string) => void
}

function parentDirectory(path: string): string | null {
  const trimmed = path.replace(/[\\/]+$/, "")
  if (!trimmed || trimmed === "/" || /^[A-Za-z]:$/.test(trimmed)) return null
  const separatorIndex = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"))
  if (separatorIndex < 0) return null
  if (separatorIndex === 0) return "/"
  if (separatorIndex === 2 && /^[A-Za-z]:/.test(trimmed)) return `${trimmed.slice(0, 2)}\\`
  return trimmed.slice(0, separatorIndex)
}

export function WorkspaceFolderPicker({ open, onOpenChange, initialPath, onSelect }: Props) {
  const t = useTranslations("workspace.manage.remotePicker")
  const requestIdRef = useRef(0)
  const [currentPath, setCurrentPath] = useState("")
  const [pathDraft, setPathDraft] = useState("")
  const [directories, setDirectories] = useState<WorkspaceEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)

  const loadPath = useCallback(async (path: string) => {
    const normalized = path.trim()
    if (!normalized) return
    const requestId = ++requestIdRef.current
    setPathDraft(normalized)
    setLoading(true)
    setLoadFailed(false)
    try {
      const entries = await listWorkspaceDir(normalized)
      if (requestId !== requestIdRef.current) return
      setCurrentPath(normalized)
      setDirectories(entries.filter((entry) => entry.isDir))
    } catch {
      if (requestId !== requestIdRef.current) return
      setLoadFailed(true)
    } finally {
      if (requestId === requestIdRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    void (async () => {
      try {
        const startPath = initialPath?.trim() || (await defaultExportDir())
        if (!cancelled) await loadPath(startPath)
      } catch {
        if (!cancelled) setLoadFailed(true)
      }
    })()
    return () => {
      cancelled = true
      requestIdRef.current += 1
    }
  }, [initialPath, loadPath, open])

  const parent = parentDirectory(currentPath)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="overflow-hidden p-0 sm:max-w-xl">
        <DialogHeader className="border-b px-6 py-5 pr-12">
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3 px-6">
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              void loadPath(pathDraft)
            }}
          >
            <Input
              value={pathDraft}
              onChange={(event) => setPathDraft(event.target.value)}
              aria-label={t("pathLabel")}
              placeholder={t("pathPlaceholder")}
              className="font-mono text-xs"
            />
            <Button type="submit" variant="secondary" disabled={!pathDraft.trim() || loading}>
              {t("go")}
            </Button>
          </form>

          <div className="flex items-center gap-2 rounded-md border bg-muted/30 px-2 py-1.5">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={!parent || loading}
              aria-label={t("up")}
              onClick={() => parent && void loadPath(parent)}
            >
              <ArrowUpIcon className="size-4" />
            </Button>
            <span className="min-w-0 flex-1 truncate font-mono text-xs" title={currentPath}>
              {currentPath || pathDraft}
            </span>
          </div>

          <ScrollArea className="h-64 rounded-md border">
            {loading ? (
              <div className="flex h-64 items-center justify-center gap-2 text-sm text-muted-foreground">
                <Loader2Icon className="size-4 animate-spin" />
                {t("loading")}
              </div>
            ) : loadFailed ? (
              <div className="flex h-64 items-center justify-center px-6 text-center text-sm text-destructive">
                {t("loadError")}
              </div>
            ) : directories.length === 0 ? (
              <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
                {t("empty")}
              </div>
            ) : (
              <ul className="space-y-1 p-2" aria-label={t("folderList")}>
                {directories.map((directory) => (
                  <li key={directory.absolutePath}>
                    <button
                      type="button"
                      aria-label={t("openFolder", { name: directory.relPath })}
                      onClick={() => void loadPath(directory.absolutePath)}
                      className="group flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <FolderIcon className="size-4 shrink-0 text-primary/80" />
                      <span className="min-w-0 flex-1 truncate">{directory.relPath}</span>
                      <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </ScrollArea>
        </div>

        <DialogFooter className="border-t bg-muted/20 px-6 py-4">
          <Button
            type="button"
            disabled={!currentPath || loading}
            onClick={() => {
              onSelect(currentPath)
              onOpenChange(false)
            }}
          >
            {t("chooseCurrent")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default WorkspaceFolderPicker
