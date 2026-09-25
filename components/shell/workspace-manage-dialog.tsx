"use client"

import { useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { open as openDialog } from "@tauri-apps/plugin-dialog"
import { toast } from "sonner"
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
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
import { Textarea } from "@/components/ui/textarea"
import { SettingsListDetail } from "@/components/settings/common/settings-master-detail"
import { Surface } from "@/components/surface/surface"
import { cn } from "@/lib/utils"
import { isTauri } from "@/lib/tauri"
import { loggers } from "@cognia/logging"
import { useProjectStore } from "@/stores/project/project-store"
import { WorkspaceKnowledgeSection } from "@/components/shell/workspace-knowledge-section"
import { WorkspaceFolderPicker } from "@/components/shell/workspace-folder-picker"
import { normalizeRoots } from "@/lib/workspace/roots"
import { hasNoLeakingPii } from "@cognia/redact"
import { WORKSPACE_INSTRUCTIONS_MAX_CHARS } from "@/lib/workspace/workspace-instructions"
import { DEFAULT_PROJECT_ID } from "@/lib/db/project-defaults"
import { listWorkspaceSessions } from "@/lib/db/sessions"
import { getExecutionBroker } from "@/lib/execution/broker"
import { useWorkspaceCommandGate } from "@/hooks/workspace/use-workspace-command-gate"
import {
  isWorkspaceTrusted,
  trustWorkspace,
  revokeWorkspaceTrust,
} from "@/lib/db/trusted-workspaces"
import type { Project } from "@/types"
import type { WorkspaceRoot } from "@/types/workspace"

const log = loggers.shell

/** Row count above which the list is worth a filter field rather than a scroll. */
const SEARCH_THRESHOLD = 6

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /**
   * The workspace selected when the dialog opens. Absent, the active one is:
   * opening the manager from anywhere used to land on an empty "pick a
   * workspace" pane even when the reader had come from that workspace's page.
   */
  initialId?: string
}

/**
 * Selection id of a workspace that exists only as a draft. "New" used to
 * persist a rootless "New Workspace" row on the first click, so every
 * abandoned attempt left one behind. The row is written by Save now.
 */
const NEW_DRAFT = "__new__"

/** The editable fields, as the form holds them. */
interface Draft {
  name: string
  description: string
  instructions: string
  tags: string[]
  roots: WorkspaceRoot[]
}

function draftOf(project: Project | null): Draft {
  return {
    name: project?.name ?? "",
    description: project?.description ?? "",
    instructions: project?.customInstructions ?? "",
    tags: [...(project?.tags ?? [])],
    roots: project?.roots ? project.roots.map((r) => ({ ...r })) : [],
  }
}

/** Last path segment, for the default per-root label. */
function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

/** Whether the draft differs from what is stored, field by field. */
function isDirty(stored: Draft, draft: Draft): boolean {
  if (stored.name !== draft.name) return true
  if (stored.description !== draft.description) return true
  if (stored.instructions !== draft.instructions) return true
  if (stored.tags.join("\n") !== draft.tags.join("\n")) return true
  if (stored.roots.length !== draft.roots.length) return true
  return stored.roots.some((root, index) => {
    const next = draft.roots[index]
    if (!next) return true
    return (
      next.path !== root.path ||
      (next.label ?? "") !== (root.label ?? "") ||
      Boolean(next.isPrimary) !== Boolean(root.isPrimary)
    )
  })
}

/**
 * Create / edit / archive / remove workspaces (the `Project` model).
 * Master-detail: the left column lists every workspace, archived ones in their
 * own group at the bottom; the right column edits the selected one — what it
 * is (name, description, tags, the instructions sent with its conversations),
 * its multi-root folder set, and its knowledge. Each root carries an optional
 * label, a primary flag (the cwd), and a per-folder trust toggle (VS
 * Code-style).
 *
 * The split is `SettingsListDetail`, the frame the settings list panes already
 * share, rather than the `md:grid-cols-[15rem_1fr]` it used to hand-roll. `md`
 * is a **viewport** query and this dialog is never the viewport: it is capped
 * at `max-w-5xl` and inset by a margin, so on an 800px window the two-column
 * layout fired while the dialog still had ~740px to split, and it stayed
 * two-column in a 560px dialog where the editor column had nothing left. The
 * shared frame measures the pane it is actually in.
 *
 * Everything in the General and Folders cards is a DRAFT committed by Save;
 * per-folder trust and knowledge files are written through immediately,
 * because neither is a form field. The draft reports itself as unsaved, and
 * leaving it, by selecting another workspace or by closing, asks first.
 *
 * Archive is the reversible way out: the workspace leaves every picker but
 * keeps its conversations, and re-opening its folder restores it
 * (`openPathAsWorkspace`). Default can be neither archived nor removed, because
 * it is where removed workspaces hand their conversations.
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
export function WorkspaceManageDialog({ open, onOpenChange, initialId }: Props) {
  const t = useTranslations("workspace.manage")
  const projects = useProjectStore((s) => s.projects)
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const createProject = useProjectStore((s) => s.createProject)
  const updateProject = useProjectStore((s) => s.updateProject)
  const deleteProject = useProjectStore((s) => s.deleteProject)
  const setActiveProject = useProjectStore((s) => s.setActiveProject)
  const archiveProject = useProjectStore((s) => s.archiveProject)
  const unarchiveProject = useProjectStore((s) => s.unarchiveProject)

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [instructions, setInstructions] = useState("")
  const [tags, setTags] = useState<string[]>([])
  const [tagInput, setTagInput] = useState("")
  const [roots, setRoots] = useState<WorkspaceRoot[]>([])
  const [manualDir, setManualDir] = useState("")
  const [search, setSearch] = useState("")
  const [folderPickerOpen, setFolderPickerOpen] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  /** What the draft is standing in the way of. Null when nothing waits. */
  const [pending, setPending] = useState<{ kind: "select"; id: string } | { kind: "close" } | null>(
    null
  )
  // path → trusted? Undefined while loading.
  const [trustMap, setTrustMap] = useState<Record<string, boolean>>({})
  const desktop = isTauri()
  const gate = useWorkspaceCommandGate()
  // Only asked off the desktop, where the native dialog is not an option.
  const browseGate = gate("fs_list_workspace_dir")

  const creating = selectedId === NEW_DRAFT
  const editing = useMemo(
    () => (creating ? null : (projects.find((p) => p.id === selectedId) ?? null)),
    [projects, selectedId, creating]
  )
  const editorKey = creating ? NEW_DRAFT : (editing?.id ?? null)

  // Selection resets on every open, to the workspace the caller named or the
  // active one. Adjusted during render rather than in an effect: the form below
  // must not paint one frame of the previous selection first.
  const [openedFor, setOpenedFor] = useState(false)
  // Which selection the form fields were last loaded from.
  const [loadedKey, setLoadedKey] = useState<string | null>(null)
  if (open !== openedFor) {
    setOpenedFor(open)
    if (open) {
      setSelectedId(initialId ?? activeProjectId ?? null)
      setSearch("")
      // Reload the fields even when the selection is unchanged: a draft that
      // was discarded by closing must not come back on the next open.
      setLoadedKey(null)
    }
  }
  // Keyed on the selection's ID, not the row object. The row is replaced on
  // every write to it, including the knowledge files and trust that are
  // written through from inside this editor, and resetting on that replaced
  // an edited name with the stored one mid-edit.
  if (open && loadedKey !== editorKey) {
    setLoadedKey(editorKey)
    const loaded = draftOf(editing)
    setName(loaded.name)
    setDescription(loaded.description)
    setInstructions(loaded.instructions)
    setTags(loaded.tags)
    setTagInput("")
    setRoots(loaded.roots)
    setManualDir("")
    setConfirmingDelete(false)
  }

  const { live, archived } = useMemo(() => {
    const sorted = [...projects].sort((a, b) => a.name.localeCompare(b.name))
    return {
      live: sorted.filter((p) => !p.isArchived),
      archived: sorted.filter((p) => p.isArchived),
    }
  }, [projects])

  const query = search.trim().toLowerCase()
  const matches = (p: Project) =>
    !query ||
    p.name.toLowerCase().includes(query) ||
    (p.roots ?? []).some((root) => root.path.toLowerCase().includes(query)) ||
    (p.tags ?? []).some((tag) => tag.toLowerCase().includes(query))
  const visibleLive = live.filter(matches)
  const visibleArchived = archived.filter(matches)
  const offerSearch = projects.length >= SEARCH_THRESHOLD || query.length > 0

  const draft: Draft = { name, description, instructions, tags, roots }
  const dirty = creating
    ? isDirty(draftOf(null), draft)
    : editing
      ? isDirty(draftOf(editing), draft)
      : false

  // Instructions ride every turn in this workspace, and the send path refuses
  // a prompt that carries an email, key or token (`sendPrompt`'s PII gate).
  // Saved as-is, one pasted address would reject every conversation here with
  // an error far from its cause, so the editor catches it where it is typed.
  const instructionsLeak = instructions.trim().length > 0 && !hasNoLeakingPii(instructions)

  const isDefault = editing?.id === DEFAULT_PROJECT_ID
  const isActive = editing ? activeProjectId === editing.id : false
  /** Where the active pointer goes when the active workspace is archived. */
  const archiveFallback = useMemo(() => {
    if (!editing) return null
    return (
      [...projects]
        .filter((p) => p.id !== editing.id && !p.isArchived)
        .sort((a, b) => +new Date(b.lastAccessedAt ?? 0) - +new Date(a.lastAccessedAt ?? 0))[0] ??
      null
    )
  }, [projects, editing])

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

  /** Selection, gated on the draft. A dirty draft asks before it is thrown away. */
  const requestSelect = (id: string) => {
    if (id === selectedId) return
    if (dirty) {
      setPending({ kind: "select", id })
      return
    }
    setSelectedId(id)
  }

  /** Closing is leaving the draft too, so it asks the same question. */
  const requestOpenChange = (next: boolean) => {
    if (!next && dirty && !deleting) {
      setPending({ kind: "close" })
      return
    }
    onOpenChange(next)
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

  const addTag = () => {
    // A comma is a separator here, the way every chip input reads it.
    const next = tagInput
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean)
    if (next.length === 0) return
    setTags((prev) => [...new Set([...prev, ...next])])
    setTagInput("")
  }
  const removeTag = (tag: string) => setTags((prev) => prev.filter((t) => t !== tag))

  const handleTrust = async (path: string) => {
    await trustWorkspace(path)
    setTrustMap((prev) => ({ ...prev, [path]: true }))
  }
  const handleRevoke = async (path: string) => {
    await revokeWorkspaceTrust(path)
    setTrustMap((prev) => ({ ...prev, [path]: false }))
  }

  const handleSave = () => {
    if (instructionsLeak) return
    const fields = {
      name: name.trim() || t("defaultName"),
      description: description.trim() || undefined,
      customInstructions: instructions.trim() || undefined,
      tags: tags.length > 0 ? tags : undefined,
      roots: normalizeRoots(roots),
    }
    if (creating) {
      const created = createProject({
        name: fields.name,
        description: fields.description,
        systemPrompt: fields.customInstructions,
        tags: fields.tags,
        roots: fields.roots,
      })
      setSelectedId(created.id)
      toast.success(t("created"))
      return
    }
    if (!editing) return
    updateProject(editing.id, fields)
    toast.success(t("saved"))
  }

  const handleArchive = () => {
    if (!editing || isDefault) return
    if (editing.isArchived) {
      unarchiveProject(editing.id)
      toast.success(t("unarchived"))
      return
    }
    // An archived workspace is out of every picker, so it cannot stay the one
    // the app is working in. Hand the pointer to the most recently used one.
    if (isActive) {
      if (!archiveFallback) return
      setActiveProject(archiveFallback.id)
    }
    archiveProject(editing.id)
    toast.success(
      isActive ? t("archivedSwitched", { name: archiveFallback?.name ?? "" }) : t("archived")
    )
  }

  const removeWorkspace = async (mode: "detach" | "delete-data") => {
    if (!editing || deleting) return
    const id = editing.id
    setDeleting(true)
    try {
      // Moving a conversation is refused while it runs, because its cwd cannot
      // change underneath a turn. Removing its workspace changes more than the
      // cwd. The broker rather than the chat store: a conversation with no open
      // pane keeps running in the background.
      const broker = getExecutionBroker()
      const sessions = await listWorkspaceSessions(id)
      if (sessions.some((s) => s.projectId === id && broker.hasActiveSession(s.id))) {
        toast.error(t("deleteRunning"))
        return
      }
      await deleteProject(id, mode)
      setSelectedId((current) => (current === id ? null : current))
      setConfirmingDelete(false)
      toast.success(t(mode === "detach" ? "detached" : "deleted"))
    } catch (err) {
      log.error("workspace.deleteFailed", err)
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

  const renderRow = (p: Project) => (
    <li key={p.id}>
      <button
        type="button"
        onClick={() => requestSelect(p.id)}
        data-testid={`workspace-row-${p.id}`}
        className={cn(
          "group flex w-full items-center gap-2 rounded-control px-3 py-2.5 text-left text-sm transition-colors hover:bg-accent",
          selectedId === p.id && "bg-background text-foreground shadow-sm ring-1 ring-border",
          p.isArchived && selectedId !== p.id && "text-muted-foreground"
        )}
      >
        {p.isArchived ? (
          <ArchiveIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <FolderIcon
            aria-hidden
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground",
              selectedId === p.id && "text-primary"
            )}
          />
        )}
        <span className="min-w-0 flex-1 truncate">{p.name}</span>
        {/* An edited-but-unsaved row says so where the reader is about to
            click away from it. */}
        {selectedId === p.id && dirty ? (
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
  )

  return (
    <Dialog open={open} onOpenChange={requestOpenChange}>
      <DialogContent className="@container/workspace-dialog h-[calc(100dvh-1rem)] max-h-[48rem] grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0 sm:h-[min(48rem,calc(100dvh-2rem))] sm:max-w-5xl">
        <DialogHeader className="border-b px-5 py-4 pr-12 text-left sm:px-6">
          <div className="flex items-center gap-2">
            <DialogTitle className="min-w-0">{t("title")}</DialogTitle>
            {live.length > 0 ? (
              <Badge variant="secondary" className="tabular-nums">
                {live.length}
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
              editing || creating ? "max-h-36" : "max-h-64"
            )}
          >
            <aside className="flex min-h-0 flex-col gap-2 p-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => requestSelect(NEW_DRAFT)}
                className="w-full justify-start gap-2 shadow-none"
                data-testid="workspace-new"
                aria-pressed={creating}
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
                  {projects.length === 0 && (
                    <li className="rounded-control border border-dashed px-3 py-6 text-center text-xs text-muted-foreground">
                      {t("empty")}
                    </li>
                  )}
                  {projects.length > 0 &&
                    visibleLive.length === 0 &&
                    visibleArchived.length === 0 && (
                      <li
                        className="rounded-control border border-dashed px-3 py-6 text-center text-xs text-muted-foreground"
                        data-testid="workspace-manage-no-matches"
                      >
                        {t("noMatches")}
                      </li>
                    )}
                  {visibleLive.map(renderRow)}
                </ul>
                {/* Archived rows stay reachable here, and only here: this is
                    where they can be restored. */}
                {visibleArchived.length > 0 ? (
                  <div className="mt-2 pr-2" data-testid="workspace-manage-archived">
                    <p className="px-3 pb-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                      {t("archivedHeading")}
                    </p>
                    <ul className="flex flex-col gap-1" aria-label={t("archivedHeading")}>
                      {visibleArchived.map(renderRow)}
                    </ul>
                  </div>
                ) : null}
              </ScrollArea>
            </aside>
          </Surface>

          {/* Editor. Its own container, so the cards below split off the
              column they actually occupy rather than off the whole dialog. */}
          <div className="@container/workspace-editor flex min-h-0 min-w-0 flex-col overflow-hidden rounded-panel @[560px]/settings-pane:border">
            {!editing && !creating ? (
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
              <div className="flex h-full min-h-0 flex-col" data-testid="workspace-editor">
                <ScrollArea className="min-h-0 flex-1">
                  {editing?.isArchived ? (
                    <div
                      className="mx-4 mt-4 flex items-center gap-2 rounded-control border border-dashed px-3 py-2 text-xs text-muted-foreground"
                      data-testid="workspace-archived-note"
                    >
                      <ArchiveIcon aria-hidden className="size-3.5 shrink-0" />
                      {t("archivedNote")}
                    </div>
                  ) : null}
                  <div className="grid gap-4 p-4 @2xl/workspace-editor:grid-cols-2 @2xl/workspace-editor:items-start">
                    <Surface radius="panel" elevation={1} className="space-y-4 border p-4">
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
                        <Label htmlFor="workspace-description">{t("descriptionLabel")}</Label>
                        <Input
                          id="workspace-description"
                          value={description}
                          placeholder={t("descriptionPlaceholder")}
                          onChange={(e) => setDescription(e.target.value)}
                        />
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="workspace-tags">{t("tagsLabel")}</Label>
                        <Input
                          id="workspace-tags"
                          value={tagInput}
                          placeholder={t("tagsPlaceholder")}
                          onChange={(e) => setTagInput(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === ",") {
                              e.preventDefault()
                              addTag()
                            } else if (e.key === "Backspace" && !tagInput && tags.length > 0) {
                              removeTag(tags[tags.length - 1])
                            }
                          }}
                          onBlur={addTag}
                        />
                        {tags.length > 0 ? (
                          <ul className="flex flex-wrap gap-1.5" data-testid="workspace-tags">
                            {tags.map((tag) => (
                              <li key={tag}>
                                <Badge variant="secondary" className="gap-1 pr-1 font-normal">
                                  <span className="max-w-40 truncate">{tag}</span>
                                  <button
                                    type="button"
                                    onClick={() => removeTag(tag)}
                                    aria-label={t("removeTag", { tag })}
                                    className="rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                  >
                                    <XIcon aria-hidden className="size-3" />
                                  </button>
                                </Badge>
                              </li>
                            ))}
                          </ul>
                        ) : null}
                      </div>

                      <div className="space-y-2">
                        <div className="flex items-baseline gap-2">
                          <Label htmlFor="workspace-instructions" className="flex-1">
                            {t("instructionsLabel")}
                          </Label>
                          {instructions.length > 0 ? (
                            <span className="text-[11px] tabular-nums text-muted-foreground">
                              {t("instructionsCount", {
                                count: instructions.length,
                                max: WORKSPACE_INSTRUCTIONS_MAX_CHARS,
                              })}
                            </span>
                          ) : null}
                        </div>
                        <Textarea
                          id="workspace-instructions"
                          value={instructions}
                          maxLength={WORKSPACE_INSTRUCTIONS_MAX_CHARS}
                          placeholder={t("instructionsPlaceholder")}
                          aria-describedby="workspace-instructions-hint"
                          aria-invalid={instructionsLeak || undefined}
                          onChange={(e) => setInstructions(e.target.value)}
                          className="min-h-24 max-h-64 text-sm"
                        />
                        {instructionsLeak ? (
                          <p
                            id="workspace-instructions-hint"
                            role="alert"
                            className="text-xs leading-relaxed text-destructive"
                            data-testid="workspace-instructions-pii"
                          >
                            {t("instructionsPii")}
                          </p>
                        ) : (
                          <p
                            id="workspace-instructions-hint"
                            className="text-xs leading-relaxed text-muted-foreground"
                          >
                            {t("instructionsHint")}
                          </p>
                        )}
                      </div>
                    </Surface>

                    {/*
                      Its own container. The folder rows are the densest thing
                      in this dialog and the card they sit in is half the
                      editor column, so sizing them off the editor — let alone
                      off the viewport — puts a path, a badge, a trust toggle
                      and a delete into 270px and leaves the path 70 of them.
                    */}
                    <Surface
                      radius="panel"
                      elevation={1}
                      className="@container/roots space-y-3 border p-4"
                    >
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
                          aria-label={t("addRootManual")}
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
                            title={t("pickDir")}
                            data-testid="workspace-manage-pick"
                          >
                            <FolderPlusIcon aria-hidden className="size-4" />
                            {t("addRoot")}
                          </Button>
                        ) : (
                          <Button
                            type="button"
                            variant="outline"
                            onClick={handleWebAdd}
                            className="gap-1.5"
                            // Typing a path is always allowed. Only BROWSING
                            // needs a host, so the button stays live the
                            // moment there is something to add by hand.
                            disabled={!manualDir.trim() && !browseGate.available}
                            title={
                              !manualDir.trim() && browseGate.reason ? browseGate.reason : undefined
                            }
                            data-testid="workspace-manage-browse"
                          >
                            {!manualDir.trim() && <FolderPlusIcon aria-hidden className="size-4" />}
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
                    </Surface>

                    <Surface
                      radius="panel"
                      elevation={1}
                      className="border p-4 @2xl/workspace-editor:col-span-2"
                    >
                      {editing ? (
                        <WorkspaceKnowledgeSection project={editing} />
                      ) : (
                        // Knowledge files are written straight to the row,
                        // and a draft has no row yet.
                        <p
                          className="text-xs text-muted-foreground"
                          data-testid="workspace-knowledge-after-create"
                        >
                          {t("knowledgeAfterCreate")}
                        </p>
                      )}
                    </Surface>
                  </div>
                </ScrollArea>

                <div className="flex flex-col gap-3 border-t bg-background/95 px-4 py-3 backdrop-blur-sm @lg/workspace-editor:flex-row @lg/workspace-editor:items-center @lg/workspace-editor:justify-between">
                  <div className="flex flex-wrap items-center gap-2">
                    {editing && !isActive && !editing.isArchived && (
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={() => setActiveProject(editing.id)}
                      >
                        {t("setActive")}
                      </Button>
                    )}
                    {editing && isDefault ? (
                      // Stated rather than silently missing: the reader who
                      // looks for Delete here should learn why there is none.
                      <p
                        className="text-xs text-muted-foreground"
                        data-testid="workspace-default-locked"
                      >
                        {t("defaultLocked")}
                      </p>
                    ) : null}
                    {editing && !isDefault && !confirmingDelete ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={handleArchive}
                        // The active workspace needs somewhere to hand the
                        // pointer. There always is one once Default is loaded.
                        disabled={!editing.isArchived && isActive && !archiveFallback}
                        className="gap-1"
                        data-testid="workspace-archive"
                      >
                        {editing.isArchived ? (
                          <ArchiveRestoreIcon aria-hidden className="size-4" />
                        ) : (
                          <ArchiveIcon aria-hidden className="size-4" />
                        )}
                        {editing.isArchived ? t("unarchive") : t("archive")}
                      </Button>
                    ) : null}
                    {editing && !isDefault ? (
                      confirmingDelete ? (
                        /*
                          Armed, the two destructive readings and the way out
                          sit inside one tinted strip. They used to be two loose
                          destructive buttons in the ordinary footer with no
                          cancel at all, so the only exit from an accidental
                          Delete was to pick one of them.
                        */
                        <div
                          className="flex animate-in flex-wrap items-center gap-1.5 rounded-control border border-destructive/40 bg-destructive/5 px-2 py-1.5 fade-in-0 duration-150"
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
                          <Trash2Icon aria-hidden className="size-4" />
                          {t("delete")}
                        </Button>
                      )
                    ) : null}
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
                      // A draft can always be created, even untouched: it
                      // becomes "New Workspace" with no folders yet.
                      disabled={instructionsLeak || (!creating && !dirty)}
                      data-testid="workspace-save"
                    >
                      {creating ? t("create") : t("save")}
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </SettingsListDetail>
      </DialogContent>

      <AlertDialog
        open={pending !== null}
        onOpenChange={(next) => {
          if (!next) setPending(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("discardTitle")}</AlertDialogTitle>
            {/* Says which way out the reader took: closing and switching lose
                the same edits, but "switch" on a close reads as a mistake. */}
            <AlertDialogDescription>
              {pending?.kind === "close" ? t("discardCloseDescription") : t("discardDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("discardCancel")}</AlertDialogCancel>
            <AlertDialogAction
              data-testid="workspace-discard-confirm"
              onClick={() => {
                const waiting = pending
                setPending(null)
                if (waiting?.kind === "select") setSelectedId(waiting.id)
                else if (waiting?.kind === "close") onOpenChange(false)
              }}
            >
              {pending?.kind === "close" ? t("discardCloseConfirm") : t("discardConfirm")}
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
