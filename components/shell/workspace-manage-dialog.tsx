"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { open as openDialog } from "@tauri-apps/plugin-dialog"
import { toast } from "sonner"
import { FolderIcon, FolderPlusIcon, PlusIcon, Trash2Icon, XIcon } from "lucide-react"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"
import { isTauri } from "@/lib/tauri"
import { loggers } from "@/lib/logging"
import { useProjectStore } from "@/stores/project/project-store"

const log = loggers.shell

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /**
   * When the dialog opens, immediately create a fresh workspace and select it
   * for editing. Lets the rail's "New workspace" action jump straight into the
   * editor instead of opening an empty manager. Default: false (plain manage).
   */
  autoCreateOnOpen?: boolean
}

/**
 * Create / edit / delete workspaces (the `Project` model). Master-detail: the
 * left column lists every workspace (with a "set active" affordance); the right
 * column edits the selected one — name, primary `rootDir`, and the extra
 * `additionalDirs` mounted into the SDK's `additionalDirectories`.
 *
 * The on-disk directory pickers use the Tauri native dialog and are hidden
 * outside the desktop shell; a manual path input is always available so the
 * web/mobile surfaces can still read and (text-)edit paths.
 */
export function WorkspaceManageDialog({ open, onOpenChange, autoCreateOnOpen }: Props) {
  const t = useTranslations("workspace.manage")
  const projects = useProjectStore((s) => s.projects)
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const createProject = useProjectStore((s) => s.createProject)
  const updateProject = useProjectStore((s) => s.updateProject)
  const deleteProject = useProjectStore((s) => s.deleteProject)
  const setActiveProject = useProjectStore((s) => s.setActiveProject)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [name, setName] = useState("")
  const [rootDir, setRootDir] = useState("")
  const [additionalDirs, setAdditionalDirs] = useState<string[]>([])
  const [manualDir, setManualDir] = useState("")
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  const sorted = useMemo(
    () => [...projects].sort((a, b) => a.name.localeCompare(b.name)),
    [projects]
  )
  const editing = useMemo(
    () => projects.find((p) => p.id === editingId) ?? null,
    [projects, editingId]
  )

  // Sync the local form whenever the selected workspace changes.
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    setName(editing?.name ?? "")
    setRootDir(editing?.rootDir ?? "")
    setAdditionalDirs(editing?.additionalDirs ? [...editing.additionalDirs] : [])
    setManualDir("")
    setConfirmingDelete(false)
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [editing])

  const handleNew = () => {
    const created = createProject({ name: t("defaultName") })
    setEditingId(created.id)
  }

  // Auto-create a workspace on open when the caller (rail "New workspace")
  // asked for it — fires once per open transition, then resets.
  const wasOpen = useRef(false)
  useEffect(() => {
    if (open && !wasOpen.current && autoCreateOnOpen) {
      const created = createProject({ name: t("defaultName") })
      setEditingId(created.id)
    }
    wasOpen.current = open
  }, [open, autoCreateOnOpen, createProject, t])

  const pickSingleDir = async (): Promise<string | null> => {
    if (!isTauri()) return null
    try {
      const picked = await openDialog({
        directory: true,
        multiple: false,
        title: t("pickDirTitle"),
      })
      return typeof picked === "string" ? picked : null
    } catch (err) {
      log.error("workspace.pickDirFailed", err)
      return null
    }
  }

  const handlePickRoot = async () => {
    const picked = await pickSingleDir()
    if (picked) setRootDir(picked)
  }

  const handlePickAdditional = async () => {
    const picked = await pickSingleDir()
    if (picked && !additionalDirs.includes(picked)) {
      setAdditionalDirs((prev) => [...prev, picked])
    }
  }

  const handleAddManualDir = () => {
    const trimmed = manualDir.trim()
    if (trimmed && !additionalDirs.includes(trimmed)) {
      setAdditionalDirs((prev) => [...prev, trimmed])
      setManualDir("")
    }
  }

  const removeAdditional = (dir: string) => {
    setAdditionalDirs((prev) => prev.filter((d) => d !== dir))
  }

  const handleSave = () => {
    if (!editing) return
    updateProject(editing.id, {
      name: name.trim() || t("defaultName"),
      rootDir: rootDir.trim() || undefined,
      additionalDirs: additionalDirs.length > 0 ? additionalDirs : undefined,
    })
    toast.success(t("saved"))
  }

  const handleDelete = () => {
    if (!editing) return
    if (!confirmingDelete) {
      setConfirmingDelete(true)
      return
    }
    deleteProject(editing.id)
    setEditingId(null)
    toast.success(t("deleted"))
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-[minmax(0,11rem)_1fr] gap-4">
          {/* List */}
          <div className="flex flex-col gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleNew}
              className="justify-start gap-2"
              data-testid="workspace-new"
            >
              <PlusIcon className="size-4" />
              {t("newWorkspace")}
            </Button>
            <Separator />
            <ScrollArea className="h-64">
              <ul className="flex flex-col gap-1 pr-2" aria-label={t("listLabel")}>
                {sorted.length === 0 && (
                  <li className="px-2 py-1.5 text-xs text-muted-foreground">{t("empty")}</li>
                )}
                {sorted.map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      onClick={() => setEditingId(p.id)}
                      data-testid={`workspace-row-${p.id}`}
                      className={cn(
                        "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent",
                        editingId === p.id && "bg-primary/10 text-foreground"
                      )}
                    >
                      <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
                      <span className="flex-1 truncate">{p.name}</span>
                      {activeProjectId === p.id && (
                        <span className="rounded bg-primary/15 px-1 text-[10px] font-medium uppercase text-primary">
                          {t("activeBadge")}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </ScrollArea>
          </div>

          {/* Editor */}
          <div className="min-w-0">
            {!editing ? (
              <div className="flex h-full items-center justify-center rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                {t("selectHint")}
              </div>
            ) : (
              <div className="flex flex-col gap-4">
                <div className="space-y-2">
                  <Label htmlFor="workspace-name">{t("nameLabel")}</Label>
                  <Input
                    id="workspace-name"
                    value={name}
                    placeholder={t("namePlaceholder")}
                    onChange={(e) => setName(e.target.value)}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="workspace-rootdir">{t("rootDirLabel")}</Label>
                  <div className="flex gap-2">
                    <Input
                      id="workspace-rootdir"
                      value={rootDir}
                      placeholder={t("rootDirPlaceholder")}
                      onChange={(e) => setRootDir(e.target.value)}
                    />
                    {isTauri() && (
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        aria-label={t("pickDir")}
                        onClick={handlePickRoot}
                      >
                        <FolderPlusIcon className="size-4" />
                      </Button>
                    )}
                  </div>
                </div>

                <div className="space-y-2">
                  <Label>{t("additionalDirsLabel")}</Label>
                  <p className="text-xs text-muted-foreground">{t("additionalDirsHint")}</p>
                  {additionalDirs.length > 0 && (
                    <ul className="flex flex-col gap-1">
                      {additionalDirs.map((dir) => (
                        <li
                          key={dir}
                          className="flex items-center gap-2 rounded bg-muted/50 px-2 py-1 text-xs"
                        >
                          <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
                          <span className="flex-1 truncate font-mono">{dir}</span>
                          <button
                            type="button"
                            aria-label={t("removeDir")}
                            onClick={() => removeAdditional(dir)}
                            className="text-muted-foreground hover:text-foreground"
                          >
                            <XIcon className="size-3.5" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="flex gap-2">
                    <Input
                      value={manualDir}
                      placeholder={t("addDirManual")}
                      onChange={(e) => setManualDir(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault()
                          handleAddManualDir()
                        }
                      }}
                    />
                    {isTauri() ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={handlePickAdditional}
                        className="shrink-0 gap-1"
                      >
                        <FolderPlusIcon className="size-4" />
                        {t("addDir")}
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={handleAddManualDir}
                        className="shrink-0"
                      >
                        {t("addDir")}
                      </Button>
                    )}
                  </div>
                </div>

                <Separator />

                <div className="flex items-center justify-between gap-2">
                  <div className="flex gap-2">
                    {activeProjectId !== editing.id && (
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={() => setActiveProject(editing.id)}
                      >
                        {t("setActive")}
                      </Button>
                    )}
                    <Button
                      type="button"
                      variant={confirmingDelete ? "destructive" : "ghost"}
                      size="sm"
                      onClick={handleDelete}
                      className="gap-1"
                      data-testid="workspace-delete"
                    >
                      <Trash2Icon className="size-4" />
                      {confirmingDelete ? t("confirmDelete") : t("delete")}
                    </Button>
                  </div>
                  <Button type="button" size="sm" onClick={handleSave} data-testid="workspace-save">
                    {t("save")}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export default WorkspaceManageDialog
