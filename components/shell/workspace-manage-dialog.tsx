"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { open as openDialog } from "@tauri-apps/plugin-dialog"
import { toast } from "sonner"
import {
  CheckIcon,
  FolderIcon,
  FolderPlusIcon,
  PlusIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  Trash2Icon,
} from "lucide-react"
import { nanoid } from "nanoid"

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
import { loggers } from "@cognia/logging"
import { useProjectStore } from "@/stores/project/project-store"
import { WorkspaceKnowledgeSection } from "@/components/shell/workspace-knowledge-section"
import { normalizeRoots } from "@/lib/workspace/roots"
import {
  isWorkspaceTrusted,
  trustWorkspace,
  revokeWorkspaceTrust,
} from "@/lib/db/trusted-workspaces"
import type { WorkspaceRoot } from "@/types/workspace"

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

/** Last path segment, for the default per-root label. */
function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

/**
 * Create / edit / delete workspaces (the `Project` model). Master-detail: the
 * left column lists every workspace; the right column edits the selected one —
 * its name and its multi-root folder set. Each root carries an optional label,
 * a primary flag (the cwd), and a per-folder trust toggle (VS Code-style).
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
  const [roots, setRoots] = useState<WorkspaceRoot[]>([])
  const [manualDir, setManualDir] = useState("")
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  // path → trusted? (only meaningful on desktop). Undefined while loading.
  const [trustMap, setTrustMap] = useState<Record<string, boolean>>({})

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
    setRoots(editing?.roots ? editing.roots.map((r) => ({ ...r })) : [])
    setManualDir("")
    setConfirmingDelete(false)
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [editing])

  // Load per-root trust state for the edited workspace (desktop only).
  useEffect(() => {
    if (!isTauri() || roots.length === 0) {
      return
    }
    let cancelled = false
    void Promise.all(
      roots.map(async (r) => [r.path, await isWorkspaceTrusted(r.path)] as const)
    ).then((entries) => {
      if (cancelled) return

      setTrustMap(Object.fromEntries(entries))
    })
    return () => {
      cancelled = true
    }
  }, [roots])

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

  const addRoot = (path: string) => {
    const trimmed = path.trim()
    if (!trimmed) return
    setRoots((prev) =>
      normalizeRoots([...prev, { id: `root-${nanoid()}`, path: trimmed, label: basename(trimmed) }])
    )
  }

  const handlePickRoots = async () => {
    if (!isTauri()) return
    try {
      const picked = await openDialog({
        directory: true,
        multiple: true,
        title: t("pickDirTitle"),
      })
      const paths = Array.isArray(picked) ? picked : picked ? [picked] : []
      if (paths.length === 0) return
      setRoots((prev) =>
        normalizeRoots([
          ...prev,
          ...paths.map((p) => ({ id: `root-${nanoid()}`, path: p, label: basename(p) })),
        ])
      )
    } catch (err) {
      log.error("workspace.pickDirFailed", err)
    }
  }

  const handleAddManual = () => {
    addRoot(manualDir)
    setManualDir("")
  }

  const setPrimary = (id: string) => {
    setRoots((prev) => prev.map((r) => ({ ...r, isPrimary: r.id === id })))
  }
  const setLabel = (id: string, label: string) => {
    setRoots((prev) => prev.map((r) => (r.id === id ? { ...r, label } : r)))
  }
  const removeRoot = (id: string) => {
    setRoots((prev) => normalizeRoots(prev.filter((r) => r.id !== id)))
  }

  const handleTrust = async (path: string) => {
    await trustWorkspace(path)
    setTrustMap((prev) => ({ ...prev, [path]: true }))
  }
  const handleRevoke = async (path: string) => {
    await revokeWorkspaceTrust(path)
    setTrustMap((prev) => ({ ...prev, [path]: false }))
  }

  const handleSave = () => {
    if (!editing) return
    updateProject(editing.id, {
      name: name.trim() || t("defaultName"),
      roots: normalizeRoots(roots),
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
      <DialogContent className="max-h-[calc(100vh-2rem)] max-w-2xl overflow-y-auto">
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
            <ScrollArea className="h-72">
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
                  <Label>{t("rootsLabel")}</Label>
                  <p className="text-xs text-muted-foreground">{t("rootsHint")}</p>

                  {roots.length > 0 && (
                    <ul className="flex flex-col gap-2">
                      {roots.map((r) => {
                        const trusted = trustMap[r.path]
                        return (
                          <li
                            key={r.id}
                            className="flex flex-col gap-1 rounded-md border bg-muted/30 p-2"
                          >
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                aria-label={t("setPrimary")}
                                aria-pressed={r.isPrimary ?? false}
                                onClick={() => setPrimary(r.id)}
                                className={cn(
                                  "flex size-5 shrink-0 items-center justify-center rounded-full border",
                                  r.isPrimary
                                    ? "border-primary bg-primary text-primary-foreground"
                                    : "border-muted-foreground/40 text-transparent"
                                )}
                              >
                                <CheckIcon className="size-3" />
                              </button>
                              <span className="min-w-0 flex-1 truncate font-mono text-xs">
                                {r.path}
                              </span>
                              {r.isPrimary && (
                                <span className="rounded bg-primary/15 px-1 text-[10px] font-medium uppercase text-primary">
                                  {t("primaryBadge")}
                                </span>
                              )}
                              <button
                                type="button"
                                aria-label={t("removeRoot")}
                                onClick={() => removeRoot(r.id)}
                                className="text-muted-foreground hover:text-foreground"
                              >
                                <Trash2Icon className="size-3.5" />
                              </button>
                            </div>
                            <div className="flex items-center gap-2 pl-7">
                              <Input
                                value={r.label ?? ""}
                                placeholder={t("rootLabelPlaceholder")}
                                aria-label={t("rootLabelPlaceholder")}
                                onChange={(e) => setLabel(r.id, e.target.value)}
                                className="h-7 text-xs"
                              />
                              {isTauri() &&
                                (trusted ? (
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    className="h-7 shrink-0 gap-1 text-emerald-600"
                                    onClick={() => void handleRevoke(r.path)}
                                  >
                                    <ShieldCheckIcon className="size-3.5" />
                                    {t("trustedBadge")}
                                  </Button>
                                ) : (
                                  <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    className="h-7 shrink-0 gap-1"
                                    onClick={() => void handleTrust(r.path)}
                                  >
                                    <ShieldAlertIcon className="size-3.5 text-amber-500" />
                                    {t("trustRoot")}
                                  </Button>
                                ))}
                            </div>
                          </li>
                        )
                      })}
                    </ul>
                  )}

                  <div className="flex gap-2">
                    <Input
                      value={manualDir}
                      placeholder={t("addRootManual")}
                      onChange={(e) => setManualDir(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault()
                          handleAddManual()
                        }
                      }}
                    />
                    {isTauri() ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={handlePickRoots}
                        className="shrink-0 gap-1"
                        aria-label={t("pickDir")}
                      >
                        <FolderPlusIcon className="size-4" />
                        {t("addRoot")}
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={handleAddManual}
                        className="shrink-0"
                      >
                        {t("addRoot")}
                      </Button>
                    )}
                  </div>
                </div>

                <Separator />

                <WorkspaceKnowledgeSection project={editing} />

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
