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
  SearchIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react"
import { nanoid } from "nanoid"

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
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import { SettingsListDetail } from "@/components/settings/common/settings-master-detail"
import { Surface } from "@/components/surface/surface"
import { cn } from "@/lib/utils"
import { isTauri } from "@/lib/tauri"
import { loggers } from "@cognia/logging"
import { useProjectStore } from "@/stores/project/project-store"
import { WorkspaceKnowledgeSection } from "@/components/shell/workspace-knowledge-section"
import { WorkspaceFolderPicker } from "@/components/shell/workspace-folder-picker"
import { normalizeRoots } from "@/lib/workspace/roots"
import { useWorkspaceCommandGate } from "@/hooks/workspace/use-workspace-command-gate"
import {
  isWorkspaceTrusted,
  trustWorkspace,
  revokeWorkspaceTrust,
} from "@/lib/db/trusted-workspaces"
import type { WorkspaceRoot } from "@/types/workspace"

const log = loggers.shell

/** Row count above which the list is worth a filter field rather than a scroll. */
const SEARCH_THRESHOLD = 6

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

/** Whether the draft differs from what is stored, field by field. */
function isDirty(
  storedName: string,
  storedRoots: readonly WorkspaceRoot[],
  name: string,
  roots: readonly WorkspaceRoot[]
): boolean {
  if (storedName !== name) return true
  if (storedRoots.length !== roots.length) return true
  return storedRoots.some((stored, index) => {
    const draft = roots[index]
    if (!draft) return true
    return (
      draft.path !== stored.path ||
      (draft.label ?? "") !== (stored.label ?? "") ||
      Boolean(draft.isPrimary) !== Boolean(stored.isPrimary)
    )
  })
}

/**
 * Create / edit / delete workspaces (the `Project` model). Master-detail: the
 * left column lists every workspace; the right column edits the selected one —
 * its name and its multi-root folder set. Each root carries an optional label,
 * a primary flag (the cwd), and a per-folder trust toggle (VS Code-style).
 *
 * The split is `SettingsListDetail`, the frame the settings list panes already
 * share, rather than the `md:grid-cols-[15rem_1fr]` it used to hand-roll. `md`
 * is a **viewport** query and this dialog is never the viewport: it is capped
 * at `max-w-5xl` and inset by a margin, so on an 800px window the two-column
 * layout fired while the dialog still had ~740px to split, and it stayed
 * two-column in a 560px dialog where the editor column had nothing left. The
 * shared frame measures the pane it is actually in.
 *
 * Name and folders are a DRAFT committed by Save; per-folder trust is written
 * through immediately, because a trust decision is not a form field. That split
 * was invisible before — the two kinds of control sat in one undifferentiated
 * card and an edited name was lost without a word if the reader clicked another
 * workspace. The draft now reports itself as unsaved, and leaving it asks.
 *
 * The on-disk directory pickers use the Tauri native dialog outside the desktop
 * shell, and a manual path input is always available so the web and mobile
 * surfaces can still read and text-edit paths.
 *
 * "Browse server" walks the PAIRED HOST's filesystem, which is the machine the
 * agent will actually run on. That only works when the host publishes
 * `fs_list_workspace_dir`, so the button is gated on it rather than on
 * `isTauri()`: an unpaired browser used to get a button that opened a picker
 * with nothing to list, which reads as broken rather than as unavailable. The
 * same hybrid answer `workspace-picker-list.tsx` computes for its own footer.
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
  const [search, setSearch] = useState("")
  const [folderPickerOpen, setFolderPickerOpen] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  /** A selection the draft is standing in the way of. Null when nothing waits. */
  const [pendingSelection, setPendingSelection] = useState<string | null>(null)
  // path → trusted? Undefined while loading.
  const [trustMap, setTrustMap] = useState<Record<string, boolean>>({})
  const desktop = isTauri()
  const gate = useWorkspaceCommandGate()
  // Only asked off the desktop, where the native dialog is not an option.
  const browseGate = gate("fs_list_workspace_dir")

  const sorted = useMemo(
    () => [...projects].sort((a, b) => a.name.localeCompare(b.name)),
    [projects]
  )
  const editing = useMemo(
    () => projects.find((p) => p.id === editingId) ?? null,
    [projects, editingId]
  )

  const query = search.trim().toLowerCase()
  const visible = useMemo(() => {
    if (!query) return sorted
    return sorted.filter(
      (p) =>
        p.name.toLowerCase().includes(query) ||
        (p.roots ?? []).some((root) => root.path.toLowerCase().includes(query))
    )
  }, [sorted, query])
  const offerSearch = sorted.length >= SEARCH_THRESHOLD || query.length > 0

  const dirty = editing
    ? isDirty(editing.name ?? "", editing.roots ?? [], name, roots)
    : roots.length > 0 || name.length > 0

  // Sync the local form whenever the selected workspace changes.
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    setName(editing?.name ?? "")
    setRoots(editing?.roots ? editing.roots.map((r) => ({ ...r })) : [])
    setManualDir("")
    setConfirmingDelete(false)
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [editing])

  /**
   * Load per-root trust state for the edited workspace.
   *
   * Keyed on the joined PATHS rather than on the `roots` array. Every label
   * keystroke rebuilds that array, so the old dependency re-ran one Dexie read
   * per root per character typed into the (purely cosmetic) folder-label field.
   */
  const rootPathsKey = roots.map((r) => r.path).join("\n")
  useEffect(() => {
    const paths = rootPathsKey ? rootPathsKey.split("\n") : []
    if (paths.length === 0) return
    let cancelled = false
    void Promise.all(paths.map(async (p) => [p, await isWorkspaceTrusted(p)] as const)).then(
      (entries) => {
        if (cancelled) return

        setTrustMap(Object.fromEntries(entries))
      }
    )
    return () => {
      cancelled = true
    }
  }, [rootPathsKey])

  const handleNew = () => {
    const created = createProject({ name: t("defaultName") })
    setEditingId(created.id)
  }

  /** Selection, gated on the draft. A dirty draft asks before it is thrown away. */
  const requestSelect = (id: string) => {
    if (id === editingId) return
    if (dirty && editing) {
      setPendingSelection(id)
      return
    }
    setEditingId(id)
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

  const removeWorkspace = async (mode: "detach" | "delete-data") => {
    if (!editing || deleting) return
    const id = editing.id
    setDeleting(true)
    try {
      await deleteProject(id, mode)
      setEditingId((current) => (current === id ? null : current))
      setConfirmingDelete(false)
      toast.success(t(mode === "detach" ? "detached" : "deleted"))
    } catch {
      toast.error(t("deleteFailed"))
    } finally {
      setDeleting(false)
    }
  }

  const handleDelete = () => {
    if (!editing || deleting) return
    if (!confirmingDelete) {
      setConfirmingDelete(true)
      return
    }
    // Removing a workspace is not the same decision as destroying the
    // conversations that were in it, so the confirming state asks which one
    // this is instead of assuming the destructive reading.
    void removeWorkspace("detach")
  }

  const handleDeleteWithData = () => {
    void removeWorkspace("delete-data")
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="@container/workspace-dialog h-[calc(100dvh-1rem)] max-h-[48rem] grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0 sm:h-[min(48rem,calc(100dvh-2rem))] sm:max-w-5xl">
        <DialogHeader className="border-b px-5 py-4 pr-12 text-left sm:px-6">
          <div className="flex items-center gap-2">
            <DialogTitle className="min-w-0">{t("title")}</DialogTitle>
            {projects.length > 0 ? (
              <Badge variant="secondary" className="tabular-nums">
                {projects.length}
              </Badge>
            ) : null}
          </div>
          {/* Clamped where the dialog is a phone screen: five lines of preamble
              over a list and an editor that already have to share 800px is a
              paragraph nobody reads twice at the cost of a third of the list. */}
          <DialogDescription className="line-clamp-2 max-w-3xl leading-relaxed @[36rem]/workspace-dialog:line-clamp-none">
            {t("description")}
          </DialogDescription>
        </DialogHeader>

        <SettingsListDetail
          listWidth={264}
          className="min-h-0 p-4 sm:p-5"
          data-testid="workspace-manage-pane"
        >
          {/* List. Capped on the stacked tier so a long roster cannot push the
              editor off the bottom of a phone-sized dialog. */}
          <Surface
            asChild
            radius="panel"
            className={cn(
              "border @[560px]/settings-pane:max-h-none",
              // Stacked (a phone-sized dialog), the roster and the editor share
              // one column. With something open the editor is what the reader
              // came for, so the roster keeps only enough height to switch away
              // and scrolls for the rest.
              editing ? "max-h-36" : "max-h-64"
            )}
          >
            <aside className="flex min-h-0 flex-col gap-2 p-2">
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

              {offerSearch ? (
                <div className="relative">
                  <SearchIcon
                    aria-hidden
                    className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
                  />
                  <Input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder={t("searchPlaceholder")}
                    aria-label={t("searchPlaceholder")}
                    className="h-8 pl-8 text-xs"
                    data-testid="workspace-manage-search"
                  />
                  {search ? (
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      className="absolute right-0.5 top-1/2 size-7 -translate-y-1/2"
                      onClick={() => setSearch("")}
                      aria-label={t("clearSearch")}
                    >
                      <XIcon aria-hidden className="size-3.5" />
                    </Button>
                  ) : null}
                </div>
              ) : null}

              <ScrollArea className="min-h-0 flex-1">
                <ul className="flex flex-col gap-1 pr-2" aria-label={t("listLabel")}>
                  {sorted.length === 0 && (
                    <li className="rounded-control border border-dashed px-3 py-6 text-center text-xs text-muted-foreground">
                      {t("empty")}
                    </li>
                  )}
                  {sorted.length > 0 && visible.length === 0 && (
                    <li
                      className="rounded-control border border-dashed px-3 py-6 text-center text-xs text-muted-foreground"
                      data-testid="workspace-manage-no-matches"
                    >
                      {t("noMatches")}
                    </li>
                  )}
                  {visible.map((p) => (
                    <li key={p.id}>
                      <button
                        type="button"
                        onClick={() => requestSelect(p.id)}
                        data-testid={`workspace-row-${p.id}`}
                        className={cn(
                          "group flex w-full items-center gap-2 rounded-control px-3 py-2.5 text-left text-sm transition-colors hover:bg-accent",
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
                        <span className="min-w-0 flex-1 truncate">{p.name}</span>
                        {/* An edited-but-unsaved row says so where the reader
                            is about to click away from it. */}
                        {editingId === p.id && dirty ? (
                          <span
                            className="size-1.5 shrink-0 rounded-full bg-amber-500"
                            title={t("unsaved")}
                            aria-label={t("unsaved")}
                            role="img"
                            data-testid="workspace-row-dirty"
                          />
                        ) : null}
                        {activeProjectId === p.id && (
                          <Badge variant="secondary" className="px-1.5 text-[10px] uppercase">
                            {t("activeBadge")}
                          </Badge>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              </ScrollArea>
            </aside>
          </Surface>

          {/* Editor. Its own container, so the two cards below split off the
              column they actually occupy rather than off the whole dialog. */}
          <div className="@container/workspace-editor flex min-h-0 min-w-0 flex-col overflow-hidden rounded-panel @[560px]/settings-pane:border">
            {!editing ? (
              <Empty className="min-h-60 flex-1">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <FolderPlusIcon aria-hidden />
                  </EmptyMedia>
                  <EmptyTitle>{t("noSelectionTitle")}</EmptyTitle>
                  <EmptyDescription>{t("selectHint")}</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <div className="flex h-full min-h-0 flex-col">
                <ScrollArea className="min-h-0 flex-1">
                  <div className="grid gap-4 p-4 @2xl/workspace-editor:grid-cols-2 @2xl/workspace-editor:items-start">
                    <Surface radius="panel" elevation={1} className="space-y-5 border p-4">
                      <div className="space-y-2">
                        <Label htmlFor="workspace-name">{t("nameLabel")}</Label>
                        <Input
                          id="workspace-name"
                          value={name}
                          placeholder={t("namePlaceholder")}
                          onChange={(e) => setName(e.target.value)}
                        />
                      </div>

                      {/*
                        Its own container. The folder rows are the densest thing
                        in this dialog and the card they sit in is half the
                        editor column, so sizing them off the editor — let alone
                        off the viewport — puts a path, a badge, a trust toggle
                        and a delete into 270px and leaves the path 70 of them.
                      */}
                      <div className="@container/roots space-y-3">
                        <div className="flex items-baseline gap-2">
                          <Label className="flex-1">{t("rootsLabel")}</Label>
                          {roots.length > 0 ? (
                            <span className="text-[11px] tabular-nums text-muted-foreground">
                              {roots.length}
                            </span>
                          ) : null}
                        </div>
                        <p className="text-xs leading-relaxed text-muted-foreground">
                          {t("rootsHint")}
                        </p>

                        {roots.length === 0 ? (
                          <div className="flex items-center gap-3 rounded-control border border-dashed px-3 py-4 text-xs text-muted-foreground">
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
                                  className="flex flex-col gap-2 rounded-control border bg-background p-2.5"
                                >
                                  {/*
                                    Identity on top, settings underneath. The
                                    path is the only thing on this row that has
                                    to be readable, so everything that competes
                                    with it for width is either fixed and tiny
                                    (the primary radio, delete) or drops out of
                                    the row when the card is narrow.
                                  */}
                                  <div className="flex items-center gap-2">
                                    <button
                                      type="button"
                                      aria-label={t("setPrimary")}
                                      aria-pressed={r.isPrimary ?? false}
                                      title={t("setPrimary")}
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
                                    {/* The filled radio already says which root
                                        is primary; the word is the confirmation,
                                        and it is the first thing to give up its
                                        ~50px when the card cannot afford it. */}
                                    {r.isPrimary && (
                                      <Badge
                                        variant="secondary"
                                        className="hidden shrink-0 px-1.5 text-[10px] uppercase @[20rem]/roots:inline-flex"
                                      >
                                        {t("primaryBadge")}
                                      </Badge>
                                    )}
                                    <button
                                      type="button"
                                      aria-label={t("removeRoot")}
                                      title={t("removeRoot")}
                                      onClick={() => removeRoot(r.id)}
                                      className="shrink-0 rounded-control p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
                                      className="h-7 min-w-0 flex-1 text-xs"
                                    />
                                    {/* Trust is a Dexie row (`trustedWorkspaces`),
                                        not a native call, so this used to be
                                        hidden on the one shell that needs it
                                        most: a phone or browser driving a real
                                        host. `handleTrust`/`handleRevoke` are
                                        plain table writes.

                                        `aria-pressed` because it is a toggle:
                                        a button reading "Trusted" that revokes
                                        on click is otherwise a label that lies
                                        about what the click does. */}
                                    {trusted ? (
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        size="sm"
                                        aria-pressed
                                        title={t("revokeRoot")}
                                        className="h-7 shrink-0 gap-1 px-2 text-emerald-600"
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
                                        aria-pressed={false}
                                        title={t("trustRoot")}
                                        className="h-7 shrink-0 gap-1 px-2"
                                        onClick={() => void handleTrust(r.path)}
                                      >
                                        <ShieldAlertIcon className="size-3.5 text-amber-500" />
                                        {t("trustRoot")}
                                      </Button>
                                    )}
                                  </div>
                                </li>
                              )
                            })}
                          </ul>
                        )}

                        <div className="grid gap-2 @[20rem]/roots:grid-cols-[minmax(0,1fr)_auto]">
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
                              // Typing a path is always allowed. Only BROWSING
                              // needs a host, so the button stays live the
                              // moment there is something to add by hand.
                              disabled={!manualDir.trim() && !browseGate.available}
                              title={
                                !manualDir.trim() && browseGate.reason
                                  ? browseGate.reason
                                  : undefined
                              }
                              data-testid="workspace-manage-browse"
                            >
                              {!manualDir.trim() && <FolderPlusIcon className="size-4" />}
                              {!manualDir.trim() ? t("browseServer") : t("addRoot")}
                            </Button>
                          )}
                        </div>
                        {/*
                          Stated, not only hovered. A disabled button has no
                          hover on a touch device, and this is the sentence that
                          tells an unpaired browser what to do about it.
                        */}
                        {!desktop && !browseGate.available && browseGate.reason ? (
                          <p
                            className="text-xs text-muted-foreground"
                            data-testid="workspace-manage-browse-reason"
                          >
                            {browseGate.reason}
                          </p>
                        ) : null}
                      </div>
                    </Surface>

                    <Surface radius="panel" elevation={1} className="border p-4">
                      <WorkspaceKnowledgeSection project={editing} />
                    </Surface>
                  </div>
                </ScrollArea>

                <div className="flex flex-col gap-3 border-t bg-background/95 px-4 py-3 backdrop-blur-sm @lg/workspace-editor:flex-row @lg/workspace-editor:items-center @lg/workspace-editor:justify-between">
                  <div className="flex flex-wrap items-center gap-2">
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
                    {confirmingDelete ? (
                      /*
                        Armed, the two destructive readings and the way out sit
                        inside one tinted strip. They used to be two loose
                        destructive buttons in the ordinary footer with no
                        cancel at all, so the only exit from an accidental
                        Delete was to pick one of them.
                      */
                      <div
                        className="flex flex-wrap items-center gap-1.5 rounded-control border border-destructive/40 bg-destructive/5 px-2 py-1.5"
                        data-testid="workspace-delete-confirm"
                      >
                        <span className="text-xs font-medium text-destructive">
                          {t("deleteQuestion")}
                        </span>
                        <Button
                          type="button"
                          variant="destructive"
                          size="sm"
                          className="h-7"
                          onClick={handleDelete}
                          disabled={deleting}
                          data-testid="workspace-delete"
                        >
                          {t("confirmDetach")}
                        </Button>
                        <Button
                          type="button"
                          variant="destructive"
                          size="sm"
                          className="h-7"
                          onClick={handleDeleteWithData}
                          disabled={deleting}
                          data-testid="workspace-delete-data"
                        >
                          {t("confirmDelete")}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-7"
                          onClick={() => setConfirmingDelete(false)}
                          disabled={deleting}
                          data-testid="workspace-delete-cancel"
                        >
                          {t("cancelDelete")}
                        </Button>
                      </div>
                    ) : (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={handleDelete}
                        disabled={deleting}
                        className="gap-1"
                        data-testid="workspace-delete"
                      >
                        <Trash2Icon className="size-4" />
                        {t("delete")}
                      </Button>
                    )}
                  </div>
                  <div className="flex items-center justify-end gap-2">
                    {dirty ? (
                      <span
                        className="text-xs text-muted-foreground"
                        data-testid="workspace-unsaved"
                      >
                        {t("unsaved")}
                      </span>
                    ) : null}
                    <Button
                      type="button"
                      onClick={handleSave}
                      disabled={!dirty}
                      data-testid="workspace-save"
                    >
                      {t("save")}
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </SettingsListDetail>
      </DialogContent>

      <AlertDialog
        open={pendingSelection !== null}
        onOpenChange={(next) => {
          if (!next) setPendingSelection(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("discardTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("discardDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("discardCancel")}</AlertDialogCancel>
            <AlertDialogAction
              data-testid="workspace-discard-confirm"
              onClick={() => {
                setEditingId(pendingSelection)
                setPendingSelection(null)
              }}
            >
              {t("discardConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
