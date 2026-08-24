"use client"

import { useEffect, useMemo, useState } from "react"
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
import { cn } from "@/lib/utils"
import { isTauri } from "@/lib/tauri"
import { loggers } from "@cognia/logging"
import { useProjectStore } from "@/stores/project/project-store"
import { WorkspaceKnowledgeSection } from "@/components/shell/workspace-knowledge-section"
import { WorkspaceFolderPicker } from "@/components/shell/workspace-folder-picker"
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
export function WorkspaceManageDialog({ open, onOpenChange }: Props) {
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
  const [folderPickerOpen, setFolderPickerOpen] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  // path → trusted? (only meaningful on desktop). Undefined while loading.
  const [trustMap, setTrustMap] = useState<Record<string, boolean>>({})
  const desktop = isTauri()

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

  const handleWebAdd = () => {
    if (manualDir.trim()) {
      handleAddManual()
      return
    }
    setFolderPickerOpen(true)
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
    // Removing a workspace is not the same decision as destroying the
    // conversations that were in it, so the confirming state asks which one
    // this is instead of assuming the destructive reading.
    deleteProject(editing.id, "detach")
    setEditingId(null)
    setConfirmingDelete(false)
    toast.success(t("detached"))
  }

  const handleDeleteWithData = () => {
    if (!editing) return
    deleteProject(editing.id, "delete-data")
    setEditingId(null)
    setConfirmingDelete(false)
    toast.success(t("deleted"))
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="h-[calc(100dvh-1rem)] max-h-[48rem] grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0 sm:h-[min(48rem,calc(100dvh-2rem))] sm:max-w-5xl">
        <DialogHeader className="border-b px-5 py-5 pr-12 sm:px-6">
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription className="max-w-3xl leading-relaxed">
            {t("description")}
          </DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] md:grid-cols-[15rem_minmax(0,1fr)] md:grid-rows-1">
          {/* List */}
          <aside className="flex min-h-0 flex-col gap-3 border-b bg-muted/20 p-4 md:border-r md:border-b-0">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={handleNew}
              className="w-full justify-start gap-2 shadow-none"
              data-testid="workspace-new"
            >
              <PlusIcon className="size-4" />
              {t("newWorkspace")}
            </Button>
            <ScrollArea className="max-h-28 md:max-h-none md:min-h-0 md:flex-1">
              <ul className="flex flex-col gap-1 pr-2" aria-label={t("listLabel")}>
                {sorted.length === 0 && (
                  <li className="rounded-lg border border-dashed px-3 py-6 text-center text-xs text-muted-foreground">
                    {t("empty")}
                  </li>
                )}
                {sorted.map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      onClick={() => setEditingId(p.id)}
                      data-testid={`workspace-row-${p.id}`}
                      className={cn(
                        "group flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm transition-colors hover:bg-accent",
                        editingId === p.id &&
                          "bg-background text-foreground shadow-sm ring-1 ring-border"
                      )}
                    >
                      <FolderIcon
                        className={cn(
                          "size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground",
                          editingId === p.id && "text-primary"
                        )}
                      />
                      <span className="flex-1 truncate">{p.name}</span>
                      {activeProjectId === p.id && (
                        <span className="rounded-md bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
                          {t("activeBadge")}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </ScrollArea>
          </aside>

          {/* Editor */}
          <div className="min-h-0 min-w-0">
            {!editing ? (
              <div className="flex h-full min-h-60 items-center justify-center p-6">
                <div className="flex max-w-sm flex-col items-center gap-3 rounded-xl border border-dashed bg-muted/10 px-8 py-10 text-center text-sm text-muted-foreground">
                  <FolderPlusIcon className="size-8 text-muted-foreground/60" />
                  {t("selectHint")}
                </div>
              </div>
            ) : (
              <div className="flex h-full min-h-0 flex-col">
                <ScrollArea className="min-h-0 flex-1">
                  <div className="grid gap-5 p-5 lg:grid-cols-2 lg:items-start lg:p-6">
                    <section className="space-y-5 rounded-xl border bg-card/40 p-4 shadow-xs sm:p-5">
                      <div className="space-y-2">
                        <Label htmlFor="workspace-name">{t("nameLabel")}</Label>
                        <Input
                          id="workspace-name"
                          value={name}
                          placeholder={t("namePlaceholder")}
                          onChange={(e) => setName(e.target.value)}
                        />
                      </div>

                      <div className="space-y-3">
                        <div className="space-y-1">
                          <Label>{t("rootsLabel")}</Label>
                          <p className="text-xs leading-relaxed text-muted-foreground">
                            {t("rootsHint")}
                          </p>
                        </div>

                        {roots.length === 0 ? (
                          <div className="flex items-center gap-3 rounded-lg border border-dashed bg-muted/10 px-3 py-4 text-xs text-muted-foreground">
                            <FolderPlusIcon className="size-5 shrink-0" />
                            {t("rootsEmpty")}
                          </div>
                        ) : (
                          <ul className="flex flex-col gap-2">
                            {roots.map((r) => {
                              const trusted = trustMap[r.path]
                              return (
                                <li
                                  key={r.id}
                                  className="flex flex-col gap-2 rounded-lg border bg-background p-3 shadow-xs"
                                >
                                  <div className="flex items-center gap-2">
                                    <button
                                      type="button"
                                      aria-label={t("setPrimary")}
                                      aria-pressed={r.isPrimary ?? false}
                                      onClick={() => setPrimary(r.id)}
                                      className={cn(
                                        "flex size-5 shrink-0 items-center justify-center rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                        r.isPrimary
                                          ? "border-primary bg-primary text-primary-foreground"
                                          : "border-muted-foreground/40 text-transparent hover:border-primary/70"
                                      )}
                                    >
                                      <CheckIcon className="size-3" />
                                    </button>
                                    <span
                                      className="min-w-0 flex-1 truncate font-mono text-xs"
                                      title={r.path}
                                    >
                                      {r.path}
                                    </span>
                                    {r.isPrimary && (
                                      <span className="rounded-md bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
                                        {t("primaryBadge")}
                                      </span>
                                    )}
                                    <button
                                      type="button"
                                      aria-label={t("removeRoot")}
                                      onClick={() => removeRoot(r.id)}
                                      className="rounded p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
                                      className="h-8 text-xs"
                                    />
                                    {desktop &&
                                      (trusted ? (
                                        <Button
                                          type="button"
                                          variant="ghost"
                                          size="sm"
                                          className="h-8 shrink-0 gap-1 text-emerald-600"
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
                                          className="h-8 shrink-0 gap-1"
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

                        <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
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
                          {desktop ? (
                            <Button
                              type="button"
                              variant="outline"
                              onClick={handlePickRoots}
                              className="gap-1.5"
                              aria-label={t("pickDir")}
                            >
                              <FolderPlusIcon className="size-4" />
                              {t("addRoot")}
                            </Button>
                          ) : (
                            <Button
                              type="button"
                              variant="outline"
                              onClick={handleWebAdd}
                              className="gap-1.5"
                              aria-label={!manualDir.trim() ? t("browseServer") : undefined}
                            >
                              {!manualDir.trim() && <FolderPlusIcon className="size-4" />}
                              {!manualDir.trim() ? t("browseServer") : t("addRoot")}
                            </Button>
                          )}
                        </div>
                      </div>
                    </section>

                    <section className="rounded-xl border bg-card/40 p-4 shadow-xs sm:p-5">
                      <WorkspaceKnowledgeSection project={editing} />
                    </section>
                  </div>
                </ScrollArea>

                <div className="flex flex-col-reverse gap-3 border-t bg-background/95 px-5 py-4 backdrop-blur-sm sm:flex-row sm:items-center sm:justify-between lg:px-6">
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
                      {confirmingDelete ? t("confirmDetach") : t("delete")}
                    </Button>
                    {confirmingDelete && (
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        className="gap-1"
                        onClick={handleDeleteWithData}
                        data-testid="workspace-delete-data"
                      >
                        {t("confirmDelete")}
                      </Button>
                    )}
                  </div>
                  <Button type="button" onClick={handleSave} data-testid="workspace-save">
                    {t("save")}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      </DialogContent>
      <WorkspaceFolderPicker
        open={folderPickerOpen}
        onOpenChange={setFolderPickerOpen}
        initialPath={roots.find((root) => root.isPrimary)?.path ?? roots[0]?.path}
        onSelect={addRoot}
      />
    </Dialog>
  )
}

export default WorkspaceManageDialog
