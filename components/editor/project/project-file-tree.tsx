"use client"

// Lazy, CRUD-capable project file tree over `lib/files/workspace-fs`. Each
// directory is listed on first expand (`.gitignore`-respecting). Files open on
// click (preview tab) and pin on double-click. Right-click a row for the full
// operation set: new file (incl. templates), new folder, rename, copy path,
// delete; drag a row onto a directory — or the empty space for the root — to
// move it, with open tabs migrated through `onRenamed`.
//
// Two toolbars' worth of navigation aids live in the header: collapse-all,
// reveal-active-file (expands the ancestors and scrolls the row into view),
// and refresh. Git status arrives as decorations — a single letter badge on
// changed files, propagated up to the directories that contain them.
//
// Every operation reports its failure. It did not used to: a failed listing
// wrote an empty array, so "you may not read this directory" rendered as "this
// directory is empty", and rename and delete failures were dropped outright
// with the dialog closing as if they had worked. That was survivable while the
// only backend was a local workspace the app had registered. It is not
// survivable over SFTP (ADR-0162), where denials, read-only mounts and dropped
// connections are ordinary. `lib/files/file-tree-failure.ts` owns the
// vocabulary so both backends explain themselves the same way.

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import {
  ChevronRightIcon,
  ChevronDownIcon,
  ClipboardPasteIcon,
  CopyIcon,
  CrosshairIcon,
  ExternalLinkIcon,
  FileIcon,
  FilePlusIcon,
  FolderIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  FolderSearchIcon,
  ListCollapseIcon,
  Loader2Icon,
  MessageSquarePlusIcon,
  RefreshCwIcon,
  ScissorsIcon,
  SquareSplitHorizontalIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { FileTypeIcon } from "@/components/shared/file-type-icon"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { FileTree } from "@/components/ai-elements/file-tree"
import { Input } from "@/components/ui/input"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
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
import type { EditorTabMode } from "@/lib/editor-workbench/editor-tab-model"
import {
  classifyFileTreeFailure,
  isFileTreeFailureRetryable,
  type FileTreeFailure,
  type FileTreeOperation,
} from "@/lib/files/file-tree-failure"
import type { WorkspaceEntry } from "@/lib/files/types"
import { isTauri } from "@/lib/platform/detect"
import { onTransportChange } from "@/lib/tauri/transport-instance"
import { isRemoteHostActive, subscribeActiveRemoteTransport } from "@/lib/tauri/transport-routing"
import type { GitFileStatus } from "@/types/git"
import type {
  listWorkspaceDir,
  createWorkspaceDir,
  readWorkspaceFile,
  writeWorkspaceFile,
  deleteWorkspaceEntry,
  renameWorkspaceEntry,
} from "@/lib/files/workspace-fs"
import { FILE_TEMPLATES, templateById, type FileTemplate } from "./file-templates"

export interface ProjectFileTreeDeps {
  listDir: typeof listWorkspaceDir
  createDir: typeof createWorkspaceDir
  writeFile: typeof writeWorkspaceFile
  deleteEntry: typeof deleteWorkspaceEntry
  renameEntry: typeof renameWorkspaceEntry
  /**
   * Backs the copy side of cut/copy/paste. Optional so lightweight hosts
   * (read-only trees) keep working — without it the clipboard group is
   * simply hidden from the menus.
   */
  readFile?: typeof readWorkspaceFile
}

interface Props {
  rootPath: string
  /** Retain the tree while pausing requests when its navigation panel is hidden. */
  active?: boolean
  /** Bump to force a reload of every expanded directory (external change). */
  refreshToken?: number
  activePath: string | null
  /** Opens a file. A plain tree click asks for a preview tab; a double-click pins it. */
  onOpenFile: (relPath: string, options?: { mode?: EditorTabMode }) => void
  deps: ProjectFileTreeDeps
  density?: "compact" | "touch"
  onRenamed?: (from: string, to: string) => void | Promise<void>
  /**
   * An entry was deleted through the tree. The host reconciles open tabs —
   * without this a deleted file's tab lingers and a later save resurrects it.
   */
  onDeleted?: (relPath: string, isDir: boolean) => void
  /** Git decorations: repo-relative path → status. Absent outside a repo. */
  gitDecorations?: Map<string, GitFileStatus>
  /** Copy a row's path to the clipboard (`absolute` = full on-disk path). */
  onCopyPath?: (relPath: string, absolute: boolean) => void
  /** VS Code's "Open to the Side" — open the file in the other editor group. */
  onOpenToSide?: (relPath: string) => void
  /** VS Code's "Reveal in Finder/Explorer" — the OS file manager, not the tree. */
  onRevealInSystem?: (relPath: string) => void
  /** Stage this entry as a chat context chip (file body / folder listing). */
  onAddToChat?: (relPath: string, isDir: boolean) => void
  /** Scope the workspace search panel to this directory. */
  onFindInFolder?: (relPath: string) => void
  /** External "reveal in tree" request — `nonce` re-triggers the same path. */
  revealRequest?: { path: string; nonce: number }
  /**
   * Told about every failed operation, so the surface that owns this tree can
   * put it somewhere the user will see. A listing failure is ALSO rendered in
   * place, because a toast that scrolls away leaves a directory looking empty.
   */
  onFailure?: (failure: FileTreeFailure, operation: FileTreeOperation, relPath: string) => void
}

const parentOf = (rel: string) => rel.split("/").slice(0, -1).join("/")
const joinRel = (parent: string, name: string) => (parent ? `${parent}/${name}` : name)

/**
 * VS Code's paste-collision naming: `a.ts` → `a copy.ts` → `a copy 2.ts`;
 * extensionless files and folders get the bare `name copy` form.
 */
function dedupeDestName(taken: ReadonlySet<string>, name: string): string {
  if (!taken.has(name)) return name
  const dot = name.lastIndexOf(".")
  // A leading dot (` .gitignore`) is not an extension separator.
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ""
  for (let i = 1; ; i++) {
    const suffix = i === 1 ? " copy" : ` copy ${i}`
    const candidate = `${stem}${suffix}${ext}`
    if (!taken.has(candidate)) return candidate
  }
}

/**
 * Recursive folder copy for the paste command. `skipRel` keeps a folder being
 * pasted into itself from swallowing its own just-created destination — the
 * child listing is read after `createDir`, so the destination shows up as a
 * source child and must be stepped over.
 */
async function copyDirRecursive(
  deps: ProjectFileTreeDeps,
  root: string,
  fromRel: string,
  toRel: string,
  skipRel: string,
  budget: { left: number }
): Promise<void> {
  const readFile = deps.readFile
  if (!readFile) throw new Error("readFile dep is required for copy")
  await deps.createDir(root, toRel)
  const children = await deps.listDir(root, fromRel)
  for (const child of children) {
    if (child.relPath === skipRel || child.relPath.startsWith(`${skipRel}/`)) continue
    budget.left -= 1
    if (budget.left <= 0) throw new Error("copy exceeded the entry limit")
    const dest = joinRel(toRel, child.relPath.split("/").pop() ?? child.relPath)
    if (child.isDir) {
      await copyDirRecursive(deps, root, child.relPath, dest, skipRel, budget)
    } else {
      const body = await readFile(root, child.relPath)
      await deps.writeFile(root, dest, body)
    }
  }
}

const TREE_DRAG_MIME = "application/x-cognia-tree-row"
const REMOTE_REFRESH_MS = 5_000

interface DirectoryRead {
  dirty: boolean
  promise: Promise<void>
}

/** Status letter shown on a row — the compact gitbadge VS Code popularised. */
const STATUS_LETTER: Record<GitFileStatus, string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  untracked: "U",
  conflicted: "C",
  typeChanged: "T",
}

/** Decoration severity — higher wins when a directory aggregates children. */
const STATUS_RANK: Record<GitFileStatus, number> = {
  conflicted: 7,
  modified: 6,
  renamed: 5,
  typeChanged: 4,
  deleted: 3,
  added: 2,
  untracked: 1,
}

function worstStatus(a: GitFileStatus | undefined, b: GitFileStatus): GitFileStatus {
  return a === undefined || STATUS_RANK[b] > STATUS_RANK[a] ? b : a
}

export function ProjectFileTree({
  rootPath,
  active = true,
  refreshToken,
  activePath,
  onOpenFile,
  deps,
  density = "compact",
  onRenamed,
  onDeleted,
  gitDecorations,
  onCopyPath,
  onOpenToSide,
  onRevealInSystem,
  onAddToChat,
  onFindInFolder,
  revealRequest,
  onFailure,
}: Props) {
  const t = useTranslations("projectEditor")
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([""]))
  const [childrenByDir, setChildrenByDir] = useState<Record<string, WorkspaceEntry[]>>({})
  // Keyboard navigation cursor — separate from `activePath` (which file is
  // open) the way VS Code's tree focus is separate from the active editor.
  const [focusedPath, setFocusedPath] = useState<string | null>(null)
  // Type-ahead buffer: chars within the window accumulate into a prefix
  // search; a stale buffer restarts.
  const typeaheadRef = useRef({ text: "", at: 0 })
  const [pendingCreate, setPendingCreate] = useState<{
    parent: string
    kind: "file" | "folder"
    templateId?: string
  } | null>(null)
  const [createName, setCreateName] = useState("")
  const [renameTarget, setRenameTarget] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState("")
  const [deleteTarget, setDeleteTarget] = useState<WorkspaceEntry | null>(null)
  /**
   * Kept per directory, not globally. Expanding a folder you may not read must
   * not blank out the siblings you can, and the reason belongs on the row that
   * produced it.
   */
  const [failureByDir, setFailureByDir] = useState<Record<string, FileTreeFailure>>({})
  /** Directory relPath currently highlighted as a drop target (`""` = root). */
  const [dropDir, setDropDir] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const latest = useRef({ deps, onFailure, expanded, active })
  useEffect(() => {
    latest.current = { deps, onFailure, expanded, active }
  }, [deps, onFailure, expanded, active])
  const [transportVersion, setTransportVersion] = useState(0)
  const listingRef = useRef({
    rootPath,
    transportVersion,
    active: false,
    pending: new Map<string, DirectoryRead>(),
    failures: new Map<string, string>(),
  })

  /** One place where a thrown error becomes a typed failure and reaches the caller. */
  const report = useCallback(
    (error: unknown, operation: FileTreeOperation, relPath: string): FileTreeFailure => {
      const failure = classifyFileTreeFailure(error)
      latest.current.onFailure?.(failure, operation, relPath)
      return failure
    },
    []
  )

  const loadDir = useCallback(
    (dirRel: string, invalidate = false, background = false): Promise<void> => {
      const listing = listingRef.current
      if (
        !listing.active ||
        !latest.current.active ||
        listing.rootPath !== rootPath ||
        listing.transportVersion !== transportVersion
      )
        return Promise.resolve()
      const pending = listing.pending.get(dirRel)
      if (pending) {
        // Invalidations during a read need a trailing read; expansion/polling
        // can share the current one. Never overlap reads of one directory.
        pending.dirty ||= invalidate
        return pending.promise
      }
      const current = () => listing.active && latest.current.active
      const request: DirectoryRead = { dirty: false, promise: Promise.resolve() }
      listing.pending.set(dirRel, request)
      request.promise = (async () => {
        do {
          request.dirty = false
          try {
            const entries = await latest.current.deps.listDir(listing.rootPath, dirRel || undefined)
            if (!current()) return
            if (request.dirty) continue
            listing.failures.delete(dirRel)
            setChildrenByDir((prev) => ({ ...prev, [dirRel]: entries }))
            setFailureByDir((prev) => {
              if (!(dirRel in prev)) return prev
              const next = { ...prev }
              delete next[dirRel]
              return next
            })
          } catch (error) {
            if (!current()) return
            if (request.dirty) continue
            const failure = classifyFileTreeFailure(error)
            // Keep the error visible, without repeating the same toast on
            // every background retry while a remote host remains offline.
            if (!background || listing.failures.get(dirRel) !== failure.kind) {
              report(error, "list", dirRel)
            }
            listing.failures.set(dirRel, failure.kind)
            setFailureByDir((prev) => ({ ...prev, [dirRel]: failure }))
            setChildrenByDir((prev) => {
              const next = { ...prev }
              delete next[dirRel]
              return next
            })
          }
        } while (current() && request.dirty)
      })().finally(() => {
        if (listing.pending.get(dirRel) === request) listing.pending.delete(dirRel)
      })
      return request.promise
    },
    [rootPath, transportVersion, report]
  )

  // Reset the tree and load the root on mount / root change. The synchronous
  // resets are intentional (a fresh root must start from a clean tree).
  useEffect(() => {
    const listing = {
      rootPath,
      transportVersion,
      active: true,
      pending: new Map<string, DirectoryRead>(),
      failures: new Map<string, string>(),
    }
    listingRef.current = listing
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setExpanded(new Set([""]))
    latest.current.expanded = new Set([""])
    setChildrenByDir({})
    setFailureByDir({})
    setPendingCreate(null)
    setRenameTarget(null)
    setDeleteTarget(null)
    setDropDir(null)
    void loadDir("")
    return () => {
      listing.active = false
      listing.pending.clear()
    }
  }, [rootPath, transportVersion, loadDir])

  useEffect(() => {
    const listing = listingRef.current
    const changed = () => {
      // Invalidate synchronously; an old response may settle before React
      // commits the replacement host's tree (the same root may exist there).
      listing.active = false
      setTransportVersion((version) => version + 1)
    }
    const stopTransport = onTransportChange(changed)
    const stopRemote = subscribeActiveRemoteTransport(changed)
    return () => {
      stopTransport()
      stopRemote()
    }
  }, [rootPath, transportVersion])

  useEffect(() => {
    if (!active || (isTauri() && !isRemoteHostActive())) return
    const listing = listingRef.current
    let stopped = false
    let running = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const available = () => document.visibilityState !== "hidden" && navigator.onLine !== false
    const poll = async () => {
      if (stopped || running || !available()) return
      running = true
      try {
        // Serial traversal bounds remote load regardless of expanded count.
        // Hidden descendants of a collapsed folder do not need refreshing.
        for (const dir of latest.current.expanded) {
          if (stopped || !listing.active || !available()) break
          if (!latest.current.expanded.has(dir)) continue
          let parent = dir
          let shown = true
          while (parent) {
            parent = parentOf(parent)
            if (!latest.current.expanded.has(parent)) {
              shown = false
              break
            }
          }
          if (shown) await loadDir(dir, false, true)
        }
      } finally {
        running = false
        if (!stopped && available()) timer = setTimeout(() => void poll(), REMOTE_REFRESH_MS)
      }
    }
    const onAvailability = () => {
      clearTimeout(timer)
      if (available()) void poll()
    }
    if (available()) timer = setTimeout(() => void poll(), REMOTE_REFRESH_MS)
    document.addEventListener("visibilitychange", onAvailability)
    window.addEventListener("online", onAvailability)
    window.addEventListener("offline", onAvailability)
    return () => {
      stopped = true
      clearTimeout(timer)
      document.removeEventListener("visibilitychange", onAvailability)
      window.removeEventListener("online", onAvailability)
      window.removeEventListener("offline", onAvailability)
    }
  }, [active, loadDir])

  // Reload every currently-expanded dir when the external-change token bumps.
  // `loadDir` sets state only after its async listDir resolves (not a
  // synchronous set-in-effect), so the set-state rule is a false positive here.
  const previousRefresh = useRef(refreshToken)
  const refreshExpanded = useCallback(() => {
    for (const dir of latest.current.expanded) void loadDir(dir, true)
  }, [loadDir])
  useEffect(() => {
    if (previousRefresh.current === refreshToken) return
    previousRefresh.current = refreshToken
    if (refreshToken === undefined) return
    refreshExpanded()
  }, [refreshToken, refreshExpanded])

  // Hiding never discards expansion or pending-read ownership. A reactivation
  // invalidates those reads, requesting at most one trailing fresh result.
  const previousActivation = useRef({ active, loadDir })
  useEffect(() => {
    // A new root/host already loaded its root in the lifecycle effect above.
    const resumed =
      active && !previousActivation.current.active && previousActivation.current.loadDir === loadDir
    previousActivation.current = { active, loadDir }
    if (!active) {
      // A portaled confirmation must not outlive the panel that opened it.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDeleteTarget(null)
    }
    if (!resumed) return
    for (const dir of latest.current.expanded) {
      let parent = dir
      let shown = true
      while (parent) {
        parent = parentOf(parent)
        if (!latest.current.expanded.has(parent)) {
          shown = false
          break
        }
      }
      if (shown) void loadDir(dir, true)
    }
  }, [active, loadDir])

  const toggle = useCallback(
    (dirRel: string) => {
      setExpanded((prev) => {
        const next = new Set(prev)
        if (next.has(dirRel)) {
          next.delete(dirRel)
        } else {
          next.add(dirRel)
          if (!childrenByDir[dirRel]) void loadDir(dirRel)
        }
        return next
      })
    },
    [childrenByDir, loadDir]
  )

  const collapseAll = useCallback(() => {
    setExpanded(new Set([""]))
  }, [])

  /** Expand every ancestor of `relPath` and scroll the row into view. */
  const revealPath = useCallback(
    (relPath: string) => {
      const ancestors: string[] = [""]
      const parts = relPath.split("/")
      for (let i = 1; i < parts.length; i++) ancestors.push(parts.slice(0, i).join("/"))
      setExpanded((prev) => {
        const next = new Set(prev)
        for (const a of ancestors) next.add(a)
        return next
      })
      // A reveal is an explicit selection — the keyboard cursor follows it.
      setFocusedPath(relPath)
      // Load ancestors the tree hasn't fetched yet — expansion without their
      // children would render nothing to scroll to.
      for (const a of ancestors) {
        if (!childrenByDir[a]) void loadDir(a)
      }
      // Wait for the loads + render, then find the row.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          scrollRef.current
            ?.querySelector(`[data-tree-rel="${CSS.escape(relPath)}"]`)
            ?.scrollIntoView?.({ block: "center" })
        })
      })
    },
    [childrenByDir, loadDir]
  )

  // External reveal requests (breadcrumbs, command surfaces) ride the same
  // code path as the toolbar button; `nonce` lets the same path re-trigger.
  // Deferred a frame so revealPath's expansion setState stays out of the
  // effect body (set-state-in-effect) — the scroll already waits two frames.
  useEffect(() => {
    if (!active || !revealRequest) return
    const frame = requestAnimationFrame(() => revealPath(revealRequest.path))
    return () => cancelAnimationFrame(frame)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, revealRequest?.nonce])

  const startCreate = useCallback(
    (parent: string, kind: "file" | "folder", templateId?: string) => {
      // The inline input renders inside the parent — expand it so the input is
      // actually visible (root is always expanded).
      if (parent) setExpanded((p) => new Set(p).add(parent))
      const template = templateId ? templateById(templateId) : undefined
      setCreateName(template?.suggestedName ?? "")
      setPendingCreate({ parent, kind, templateId })
    },
    []
  )

  const submitCreate = useCallback(async () => {
    const listing = listingRef.current
    if (!pendingCreate || !createName.trim()) {
      setPendingCreate(null)
      return
    }
    const rel = joinRel(pendingCreate.parent, createName.trim())
    try {
      if (pendingCreate.kind === "folder") {
        await deps.createDir(rootPath, rel)
      } else {
        const template = pendingCreate.templateId
          ? templateById(pendingCreate.templateId)
          : undefined
        await deps.writeFile(rootPath, rel, template?.content(rel) ?? "")
      }
      await loadDir(pendingCreate.parent, true)
      if (!listing.active) return
      if (pendingCreate.kind === "file") onOpenFile(rel)
    } catch (error) {
      if (!listing.active) return
      report(error, "create", rel)
    }
    setPendingCreate(null)
    setCreateName("")
  }, [pendingCreate, createName, deps, rootPath, loadDir, onOpenFile, report])

  const submitRename = useCallback(async () => {
    const listing = listingRef.current
    if (!renameTarget || !renameValue.trim()) {
      setRenameTarget(null)
      return
    }
    const parent = parentOf(renameTarget)
    const to = joinRel(parent, renameValue.trim())
    try {
      await deps.renameEntry(rootPath, renameTarget, to)
      if (!listing.active) return
      await onRenamed?.(renameTarget, to)
      await loadDir(parent, true)
      if (!listing.active) return
    } catch (error) {
      if (!listing.active) return
      report(error, "rename", renameTarget)
    }
    setRenameTarget(null)
  }, [renameTarget, renameValue, deps, rootPath, loadDir, onRenamed, report])

  const confirmDelete = useCallback(async () => {
    const listing = listingRef.current
    if (!deleteTarget) return
    try {
      await deps.deleteEntry(rootPath, deleteTarget.relPath, deleteTarget.isDir)
      // Reconcile open tabs before the listing refresh so a dirty buffer's
      // "deleted on disk" state lands with the row's disappearance.
      onDeleted?.(deleteTarget.relPath, deleteTarget.isDir)
      await loadDir(parentOf(deleteTarget.relPath), true)
      if (!listing.active) return
    } catch (error) {
      if (!listing.active) return
      report(error, "delete", deleteTarget.relPath)
    }
    setDeleteTarget(null)
  }, [deleteTarget, deps, rootPath, loadDir, onDeleted, report])

  /**
   * Move `fromRel` into directory `dirRel` (`""` = root). Renames through the
   * same path the rename dialog uses so open tabs migrate and the failure is
   * classified identically.
   */
  const moveInto = useCallback(
    async (fromRel: string, dirRel: string) => {
      const listing = listingRef.current
      const name = fromRel.split("/").pop() ?? fromRel
      const to = joinRel(dirRel, name)
      if (to === fromRel) return
      // Refuse to move a directory into itself or a descendant — the rename
      // would silently orphan the subtree.
      if (dirRel === fromRel || dirRel.startsWith(`${fromRel}/`)) return
      try {
        await deps.renameEntry(rootPath, fromRel, to)
        if (!listing.active) return
        await onRenamed?.(fromRel, to)
        await loadDir(parentOf(fromRel), true)
        await loadDir(dirRel, true)
        if (!listing.active) return
        setExpanded((prev) => (dirRel ? new Set(prev).add(dirRel) : prev))
      } catch (error) {
        if (!listing.active) return
        report(error, "rename", fromRel)
      }
    },
    [deps, rootPath, loadDir, onRenamed, report]
  )

  const dragHandlers = useCallback(
    (entry: WorkspaceEntry) => ({
      draggable: true,
      onDragStart: (e: React.DragEvent) => {
        e.dataTransfer.setData(TREE_DRAG_MIME, entry.relPath)
        e.dataTransfer.effectAllowed = "move"
      },
    }),
    []
  )

  const dropHandlers = useCallback(
    (dirRel: string) => ({
      onDragOver: (e: React.DragEvent) => {
        if (!e.dataTransfer.types.includes(TREE_DRAG_MIME)) return
        e.preventDefault()
        // Keep the event off the scroll container: its dragover would
        // overwrite this directory's highlight with the root's.
        e.stopPropagation()
        e.dataTransfer.dropEffect = "move"
        setDropDir(dirRel)
      },
      onDragLeave: () => setDropDir((cur) => (cur === dirRel ? null : cur)),
      onDrop: (e: React.DragEvent) => {
        const from = e.dataTransfer.getData(TREE_DRAG_MIME)
        setDropDir(null)
        if (!from) return
        e.preventDefault()
        e.stopPropagation()
        void moveInto(from, dirRel)
      },
    }),
    [moveInto]
  )

  // ---- file clipboard (VS Code cut/copy/paste) -----------------------------
  //
  // The clipboard holds a REFERENCE, not the bytes — paste reads the source at
  // paste time, so an agent or terminal write between copy and paste lands in
  // the pasted copy. Cut paste across directories goes through `renameEntry` +
  // `onRenamed` so open tabs migrate with their file instead of going stale.
  const [clipboard, setClipboard] = useState<{
    relPath: string
    isDir: boolean
    cut: boolean
  } | null>(null)
  const canCopy = deps.readFile !== undefined

  const copyEntry = useCallback((entry: WorkspaceEntry, cut: boolean) => {
    setClipboard({ relPath: entry.relPath, isDir: entry.isDir, cut })
  }, [])

  const pasteInto = useCallback(
    async (destDirRel: string) => {
      const listing = listingRef.current
      const clip = clipboard
      if (!clip) return
      const srcParent = parentOf(clip.relPath)
      // A folder can never be MOVED into itself or a descendant — the rename
      // would orphan the subtree. A CUT paste into a forbidden target is a
      // no-op, not a silent copy: "cut" promises the source disappears, and
      // keeping it while a duplicate appears under it is worse than doing
      // nothing. Copying (⌘C) into itself stays legal — the recursive copier
      // steps over the just-created destination.
      const moveDenied =
        clip.isDir && (destDirRel === clip.relPath || destDirRel.startsWith(`${clip.relPath}/`))
      if (clip.cut && moveDenied) return
      const isMove = clip.cut && srcParent !== destDirRel
      try {
        // Dedupe against a FRESH listing — `childrenByDir` can lag an
        // agent-side write, and a silent overwrite is not an option.
        const siblings = new Set(
          (await deps.listDir(rootPath, destDirRel || undefined)).map(
            (entry) => entry.relPath.split("/").pop() ?? entry.relPath
          )
        )
        const to = joinRel(
          destDirRel,
          dedupeDestName(siblings, clip.relPath.split("/").pop() ?? clip.relPath)
        )
        if (isMove) {
          await deps.renameEntry(rootPath, clip.relPath, to)
          if (!listing.active) return
          await onRenamed?.(clip.relPath, to)
          setClipboard(null)
        } else if (clip.isDir) {
          await copyDirRecursive(deps, rootPath, clip.relPath, to, to, { left: 5_000 })
        } else {
          const readFile = deps.readFile
          if (!readFile) return
          const body = await readFile(rootPath, clip.relPath)
          await deps.writeFile(rootPath, to, body)
        }
        if (!listing.active) return
        await loadDir(destDirRel, true)
        if (isMove) await loadDir(srcParent, true)
        if (!listing.active) return
        setExpanded((prev) => (destDirRel ? new Set(prev).add(destDirRel) : prev))
      } catch (error) {
        if (!listing.active) return
        report(error, isMove ? "rename" : "write", clip.relPath)
      }
    },
    [clipboard, deps, rootPath, loadDir, onRenamed, report]
  )

  /** Paste target for a row: a folder itself; a file's parent. */
  const pasteTargetOf = useCallback(
    (entry: WorkspaceEntry) => (entry.isDir ? entry.relPath : parentOf(entry.relPath)),
    []
  )

  // "Empty" is a claim about what is there, so it may only be made once the
  // listing actually succeeded — before that the tree is loading, not empty,
  // and a failed root renders its reason instead.
  const rootIsEmpty = useMemo(
    () => !failureByDir[""] && childrenByDir[""] !== undefined && childrenByDir[""].length === 0,
    [childrenByDir, failureByDir]
  )

  /**
   * The flat row model keyboard navigation walks — the same DFS order
   * `renderChildren` paints (a failed dir paints a FailureRow instead of its
   * entries, so it contributes no navigable rows).
   */
  const { visibleEntries, indexByRel } = useMemo(() => {
    const out: WorkspaceEntry[] = []
    const walk = (dirRel: string) => {
      if (failureByDir[dirRel]) return
      for (const entry of childrenByDir[dirRel] ?? []) {
        out.push(entry)
        if (entry.isDir && expanded.has(entry.relPath)) walk(entry.relPath)
      }
    }
    walk("")
    return { visibleEntries: out, indexByRel: new Map(out.map((e, i) => [e.relPath, i])) }
  }, [childrenByDir, expanded, failureByDir])

  const focusIndex = focusedPath ? (indexByRel.get(focusedPath) ?? -1) : -1
  // With no keyboard cursor (fresh mount, click-away) the tree treats the
  // active editor's row as current — the same way VS Code's explorer
  // selection follows the active file.
  const effectiveFocusIndex =
    focusIndex >= 0 ? focusIndex : activePath ? (indexByRel.get(activePath) ?? -1) : -1

  const scrollRowIntoView = useCallback((relPath: string) => {
    scrollRef.current
      ?.querySelector(`[data-tree-rel="${CSS.escape(relPath)}"]`)
      ?.scrollIntoView?.({ block: "nearest" })
  }, [])

  /**
   * VS Code's tree keymap: ↑↓/Home/End/PgUp/PgDn move the focus row, → expands
   * or steps into a folder, ← collapses or steps out to the parent, Enter opens
   * (pinned) or toggles, Space opens a preview, F2 renames, Delete deletes,
   * printable characters type-ahead to the next matching name.
   */
  const onTreeKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      // Inputs rendered inside rows (rename, create) keep their own keys.
      const target = event.target
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      )
        return

      // File clipboard chords, same as VS Code's explorer: ⌘C copy, ⌘X cut,
      // ⌘V paste into the focused folder (or the focused file's parent).
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey) {
        const key = event.key.toLowerCase()
        const focused = effectiveFocusIndex >= 0 ? visibleEntries[effectiveFocusIndex] : null
        if (key === "c" && focused && canCopy) {
          event.preventDefault()
          copyEntry(focused, false)
          return
        }
        if (key === "x" && focused) {
          event.preventDefault()
          copyEntry(focused, true)
          return
        }
        if (key === "v" && clipboard) {
          event.preventDefault()
          void pasteInto(focused ? pasteTargetOf(focused) : "")
          return
        }
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const entries = visibleEntries
      if (entries.length === 0) return

      const currentIndex = effectiveFocusIndex
      const focusAt = (index: number) => {
        const clamped = Math.max(0, Math.min(entries.length - 1, index))
        const entry = entries[clamped]
        setFocusedPath(entry.relPath)
        scrollRowIntoView(entry.relPath)
      }
      const focusedEntry = currentIndex >= 0 ? entries[currentIndex] : null

      switch (event.key) {
        case "ArrowDown":
          event.preventDefault()
          focusAt(currentIndex < 0 ? 0 : currentIndex + 1)
          return
        case "ArrowUp":
          event.preventDefault()
          focusAt(currentIndex < 0 ? entries.length - 1 : currentIndex - 1)
          return
        case "Home":
          event.preventDefault()
          focusAt(0)
          return
        case "End":
          event.preventDefault()
          focusAt(entries.length - 1)
          return
        case "PageDown":
          event.preventDefault()
          focusAt((currentIndex < 0 ? 0 : currentIndex) + 10)
          return
        case "PageUp":
          event.preventDefault()
          focusAt((currentIndex < 0 ? entries.length - 1 : currentIndex) - 10)
          return
        case "ArrowRight": {
          event.preventDefault()
          if (!focusedEntry) {
            focusAt(0)
            return
          }
          if (focusedEntry.isDir) {
            if (!expanded.has(focusedEntry.relPath)) toggle(focusedEntry.relPath)
            else focusAt(currentIndex + 1)
          }
          return
        }
        case "ArrowLeft": {
          event.preventDefault()
          if (!focusedEntry) return
          if (focusedEntry.isDir && expanded.has(focusedEntry.relPath)) {
            toggle(focusedEntry.relPath)
            return
          }
          const parent = parentOf(focusedEntry.relPath)
          const parentIndex = parent ? indexByRel.get(parent) : undefined
          if (parentIndex !== undefined) focusAt(parentIndex)
          return
        }
        case "Enter": {
          event.preventDefault()
          if (!focusedEntry) return
          if (focusedEntry.isDir) toggle(focusedEntry.relPath)
          else onOpenFile(focusedEntry.relPath, { mode: "pinned" })
          return
        }
        case " ": {
          event.preventDefault()
          if (!focusedEntry) return
          if (focusedEntry.isDir) toggle(focusedEntry.relPath)
          else onOpenFile(focusedEntry.relPath, { mode: "preview" })
          return
        }
        case "F2": {
          event.preventDefault()
          if (!focusedEntry) return
          setRenameValue(focusedEntry.relPath.split("/").pop() ?? "")
          setRenameTarget(focusedEntry.relPath)
          return
        }
        case "Delete":
        case "Backspace": {
          event.preventDefault()
          if (focusedEntry) setDeleteTarget(focusedEntry)
          return
        }
        default:
          break
      }

      // Type-ahead: printable chars accumulate into a prefix match against the
      // row names, scanning forward from the current focus with wrap-around.
      // A run of one repeated character cycles through that letter's matches.
      if (event.key.length === 1) {
        const buffer = typeaheadRef.current
        let text = Date.now() - buffer.at < 700 ? buffer.text + event.key : event.key
        if (text.length > 1 && [...text].every((ch) => ch === text[0])) text = event.key
        typeaheadRef.current = { text, at: Date.now() }
        const needle = text.toLowerCase()
        const start = currentIndex < 0 ? 0 : currentIndex + 1
        for (let i = 0; i < entries.length; i++) {
          const index = (start + i) % entries.length
          const name = (
            entries[index].relPath.split("/").pop() ?? entries[index].relPath
          ).toLowerCase()
          if (name.startsWith(needle)) {
            focusAt(index)
            break
          }
        }
      }
    },
    [
      canCopy,
      clipboard,
      copyEntry,
      expanded,
      effectiveFocusIndex,
      indexByRel,
      onOpenFile,
      pasteInto,
      pasteTargetOf,
      scrollRowIntoView,
      toggle,
      visibleEntries,
    ]
  )

  const renderChildren = (dirRel: string, depth: number) => {
    const failure = failureByDir[dirRel]
    if (failure) {
      return (
        <FailureRow
          key={`failure:${dirRel}`}
          depth={depth}
          failure={failure}
          label={t(`treeFailure.${failure.kind}`)}
          retryLabel={t("refresh")}
          onRetry={isFileTreeFailureRetryable(failure) ? () => void loadDir(dirRel) : undefined}
          testId={`file-tree-failure-${dirRel || "root"}`}
        />
      )
    }
    const entries = childrenByDir[dirRel]
    if (!entries) return null
    return entries.map((entry) => (
      <TreeRow
        key={entry.relPath}
        entry={entry}
        depth={depth}
        expanded={expanded.has(entry.relPath)}
        isActive={activePath === entry.relPath}
        isFocused={focusedPath === entry.relPath}
        flatIndex={indexByRel.get(entry.relPath)}
        isRenaming={renameTarget === entry.relPath}
        renameValue={renameValue}
        onRenameChange={setRenameValue}
        onRenameSubmit={submitRename}
        onRenameCancel={() => setRenameTarget(null)}
        gitStatus={gitDecorations?.get(entry.relPath)}
        dirGitStatus={entry.isDir ? aggregateDirStatus(entry.relPath, gitDecorations) : undefined}
        isDropTarget={dropDir === entry.relPath}
        labels={{
          newFile: t("newFile"),
          newFolder: t("newFolder"),
          rename: t("rename"),
          delete: t("delete"),
          copyPath: t("action.copyPath"),
          copyRelativePath: t("action.copyRelativePath"),
          newFromTemplate: t("newFromTemplate"),
          open: t("action.open"),
          openToSide: t("action.openToSide"),
          revealInSystem: t("action.revealInFileExplorer"),
          addToChat: t("action.addToChat"),
          findInFolder: t("action.findInFolder"),
          cut: t("action.cut"),
          copy: t("action.copy"),
          paste: t("action.paste"),
          templateLabel: (id: string) => t(`templates.${id}`),
        }}
        onToggle={() => toggle(entry.relPath)}
        onOpen={(mode) => onOpenFile(entry.relPath, { mode })}
        onNewFile={() => startCreate(entry.relPath, "file")}
        onNewFromTemplate={(template: FileTemplate) =>
          startCreate(entry.relPath, "file", template.id)
        }
        onNewFolder={() => startCreate(entry.relPath, "folder")}
        onRename={() => {
          setRenameValue(entry.relPath.split("/").pop() ?? "")
          setRenameTarget(entry.relPath)
        }}
        onCopyPath={onCopyPath ? (absolute) => onCopyPath(entry.relPath, absolute) : undefined}
        onOpenToSide={!entry.isDir && onOpenToSide ? () => onOpenToSide(entry.relPath) : undefined}
        onRevealInSystem={onRevealInSystem ? () => onRevealInSystem(entry.relPath) : undefined}
        onAddToChat={onAddToChat ? () => onAddToChat(entry.relPath, entry.isDir) : undefined}
        onFindInFolder={
          entry.isDir && onFindInFolder ? () => onFindInFolder(entry.relPath) : undefined
        }
        onCut={() => copyEntry(entry, true)}
        onCopy={canCopy ? () => copyEntry(entry, false) : undefined}
        onPaste={clipboard ? () => void pasteInto(pasteTargetOf(entry)) : undefined}
        isCut={clipboard?.cut === true && clipboard.relPath === entry.relPath}
        onDelete={() => setDeleteTarget(entry)}
        dragProps={dragHandlers(entry)}
        // A file row is a drop target for its *parent* directory — without
        // handlers of its own the drop bubbles to the scroll container and
        // lands at the workspace root instead of next to the sibling.
        dropProps={dropHandlers(entry.isDir ? entry.relPath : parentOf(entry.relPath))}
        density={density}
      >
        {entry.isDir && expanded.has(entry.relPath) ? (
          <>
            {pendingCreate?.parent === entry.relPath ? (
              <CreateInput
                depth={depth + 1}
                value={createName}
                placeholder={
                  pendingCreate.kind === "folder"
                    ? t("newFolder")
                    : pendingCreate.templateId
                      ? t(`templates.${pendingCreate.templateId}`)
                      : t("newFile")
                }
                onChange={setCreateName}
                onSubmit={submitCreate}
                onCancel={() => setPendingCreate(null)}
              />
            ) : null}
            {renderChildren(entry.relPath, depth + 1)}
          </>
        ) : null}
      </TreeRow>
    ))
  }

  return (
    <div className="flex h-full flex-col" data-testid="project-file-tree">
      <div className="flex items-center gap-0.5 border-b px-2 py-1">
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">
          {t("treeAria")}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className={cn("size-6", density === "touch" && "size-11")}
          aria-label={t("newFile")}
          title={t("newFile")}
          onClick={() => startCreate("", "file")}
        >
          <FilePlusIcon className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className={cn("size-6", density === "touch" && "size-11")}
          aria-label={t("newFolder")}
          title={t("newFolder")}
          onClick={() => startCreate("", "folder")}
        >
          <FolderPlusIcon className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className={cn("size-6", density === "touch" && "size-11")}
          aria-label={t("collapseAll")}
          title={t("collapseAll")}
          onClick={collapseAll}
          data-testid="tree-collapse-all"
        >
          <ListCollapseIcon className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className={cn("size-6", density === "touch" && "size-11")}
          aria-label={t("revealActive")}
          title={t("revealActive")}
          disabled={!activePath}
          onClick={() => activePath && revealPath(activePath)}
          data-testid="tree-reveal-active"
        >
          <CrosshairIcon className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className={cn("size-6", density === "touch" && "size-11")}
          aria-label={t("refresh")}
          title={t("refresh")}
          onClick={refreshExpanded}
        >
          <RefreshCwIcon className="size-3.5" />
        </Button>
      </div>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            ref={scrollRef}
            className={cn(
              "workbench-scroll min-h-0 flex-1 overflow-auto",
              dropDir === "" && "bg-accent/30"
            )}
            data-testid="project-file-tree-scroll"
            onDragOver={(e) => {
              // The container is the root drop target: a row dropped on empty
              // space lands at the top of the workspace.
              if (!e.dataTransfer.types.includes(TREE_DRAG_MIME)) return
              e.preventDefault()
              e.dataTransfer.dropEffect = "move"
              setDropDir("")
            }}
            onDragLeave={() => setDropDir((cur) => (cur === "" ? null : cur))}
            onDrop={(e) => {
              const from = e.dataTransfer.getData(TREE_DRAG_MIME)
              setDropDir(null)
              if (!from) return
              e.preventDefault()
              void moveInto(from, "")
            }}
          >
            <FileTree
              className="rounded-none border-0 bg-transparent py-1 text-sm outline-none [&>div]:p-0"
              expanded={expanded}
              selectedPath={activePath ?? undefined}
              tabIndex={0}
              aria-activedescendant={
                effectiveFocusIndex >= 0 ? `tree-item-${effectiveFocusIndex}` : undefined
              }
              onKeyDown={onTreeKeyDown}
              onClick={(e) => {
                // Clicking a row also moves the keyboard cursor so a
                // subsequent ↑ continues from what was clicked.
                const rel = (e.target as HTMLElement)
                  .closest?.("[data-tree-rel]")
                  ?.getAttribute("data-tree-rel")
                if (rel) setFocusedPath(rel)
              }}
            >
              {pendingCreate?.parent === "" ? (
                <CreateInput
                  depth={0}
                  value={createName}
                  placeholder={
                    pendingCreate.kind === "folder"
                      ? t("newFolder")
                      : pendingCreate.templateId
                        ? t(`templates.${pendingCreate.templateId}`)
                        : t("newFile")
                  }
                  onChange={setCreateName}
                  onSubmit={submitCreate}
                  onCancel={() => setPendingCreate(null)}
                />
              ) : null}
              {renderChildren("", 0)}
              {rootIsEmpty && !pendingCreate ? (
                <div className="flex flex-col items-start gap-1.5 px-3 py-2">
                  <p className="text-xs text-muted-foreground">{t("treeEmpty")}</p>
                  <button
                    type="button"
                    className="flex items-center gap-1.5 rounded px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    onClick={() => startCreate("", "file")}
                    data-testid="tree-empty-new-file"
                  >
                    <FilePlusIcon className="size-3.5" />
                    {t("newFile")}
                  </button>
                </div>
              ) : null}
              {!failureByDir[""] && childrenByDir[""] === undefined ? (
                <div
                  className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground"
                  role="status"
                  data-testid="tree-loading"
                >
                  <Loader2Icon className="size-3 animate-spin" />
                  {t("treeLoading")}
                </div>
              ) : null}
            </FileTree>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={() => startCreate("", "file")}>
            <FilePlusIcon className="size-3.5" />
            {t("newFile")}
          </ContextMenuItem>
          <ContextMenuSub>
            <ContextMenuSubTrigger>{t("newFromTemplate")}</ContextMenuSubTrigger>
            <ContextMenuSubContent>
              {FILE_TEMPLATES.map((template) => (
                <ContextMenuItem
                  key={template.id}
                  onSelect={() => startCreate("", "file", template.id)}
                >
                  {t(`templates.${template.id}`)}
                </ContextMenuItem>
              ))}
            </ContextMenuSubContent>
          </ContextMenuSub>
          <ContextMenuItem onSelect={() => startCreate("", "folder")}>
            <FolderPlusIcon className="size-3.5" />
            {t("newFolder")}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            disabled={!clipboard}
            onSelect={() => void pasteInto("")}
            data-testid="tree-root-paste"
          >
            <ClipboardPasteIcon className="size-3.5" />
            {t("action.paste")}
          </ContextMenuItem>
          <ContextMenuItem onSelect={refreshExpanded}>
            <RefreshCwIcon className="size-3.5" />
            {t("refresh")}
          </ContextMenuItem>
          <ContextMenuItem onSelect={collapseAll}>
            <ListCollapseIcon className="size-3.5" />
            {t("collapseAll")}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      <AlertDialog
        open={active && !!deleteTarget}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("delete")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("deleteConfirm", { name: deleteTarget?.relPath ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmDelete()}>
              {t("delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/**
 * One vertical guide per ancestor level, centred under that level's
 * disclosure chevron — the depth cue a dense tree needs.
 */
function IndentGuides({ depth }: { depth: number }) {
  return (
    <>
      {Array.from({ length: depth }, (_, i) => (
        <span
          key={i}
          aria-hidden
          className="pointer-events-none absolute inset-y-0 w-px bg-border/40"
          style={{ left: `${i * 12 + 13}px` }}
        />
      ))}
    </>
  )
}

/**
 * The worst git status anywhere under `dirRel` — lets a collapsed directory
 * still show that something inside it changed.
 */
function aggregateDirStatus(
  dirRel: string,
  byPath: Map<string, GitFileStatus> | undefined
): GitFileStatus | undefined {
  if (!byPath) return undefined
  let worst: GitFileStatus | undefined
  const prefix = `${dirRel}/`
  for (const [path, status] of byPath) {
    if (path.startsWith(prefix)) worst = worstStatus(worst, status)
  }
  return worst
}

/**
 * A directory that could not be read, in the place its contents would have been.
 *
 * In place rather than only in a toast: a toast scrolls away and leaves the
 * folder looking empty, which is the exact confusion this whole change exists
 * to remove. The far side's own words go in `title` rather than the row, so a
 * long `errno` string cannot break the tree's layout.
 */
function FailureRow({
  depth,
  failure,
  label,
  retryLabel,
  onRetry,
  testId,
}: {
  depth: number
  failure: FileTreeFailure
  label: string
  retryLabel: string
  onRetry?: () => void
  testId: string
}) {
  return (
    <div
      className="relative flex items-center gap-1.5 py-1 pr-2 text-xs text-muted-foreground"
      style={{ paddingLeft: `${depth * 12 + 12}px` }}
      data-testid={testId}
      data-failure={failure.kind}
      title={failure.detail ?? undefined}
    >
      <IndentGuides depth={depth} />
      <TriangleAlertIcon className="size-3 shrink-0 text-amber-600 dark:text-amber-500" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {onRetry ? (
        <Button
          variant="ghost"
          size="icon"
          className="size-5"
          aria-label={retryLabel}
          onClick={onRetry}
        >
          <RefreshCwIcon className="size-3" />
        </Button>
      ) : null}
    </div>
  )
}

interface TreeRowProps {
  entry: WorkspaceEntry
  depth: number
  expanded: boolean
  isActive: boolean
  /** Keyboard navigation cursor — renders the focus ring and the row's id. */
  isFocused?: boolean
  /** Position in the flat visible-row model — backs aria-activedescendant. */
  flatIndex?: number
  isRenaming: boolean
  renameValue: string
  onRenameChange: (v: string) => void
  onRenameSubmit: () => void
  onRenameCancel: () => void
  gitStatus?: GitFileStatus
  /** Worst status of any descendant — directories only. */
  dirGitStatus?: GitFileStatus
  isDropTarget?: boolean
  labels: {
    newFile: string
    newFolder: string
    rename: string
    delete: string
    copyPath: string
    copyRelativePath: string
    newFromTemplate: string
    open: string
    openToSide: string
    revealInSystem: string
    addToChat: string
    findInFolder: string
    cut: string
    copy: string
    paste: string
    templateLabel: (id: string) => string
  }
  onToggle: () => void
  onOpen: (mode: EditorTabMode) => void
  onNewFile: () => void
  onNewFromTemplate: (template: FileTemplate) => void
  onNewFolder: () => void
  onRename: () => void
  onCopyPath?: (absolute: boolean) => void
  onOpenToSide?: () => void
  onRevealInSystem?: () => void
  onAddToChat?: () => void
  onFindInFolder?: () => void
  onCut: () => void
  onCopy?: () => void
  onPaste?: () => void
  /** This row is the cut source — VS Code dims it until the paste lands. */
  isCut?: boolean
  onDelete: () => void
  dragProps?: {
    draggable: boolean
    onDragStart: (e: React.DragEvent) => void
  }
  dropProps?: {
    onDragOver: (e: React.DragEvent) => void
    onDragLeave: () => void
    onDrop: (e: React.DragEvent) => void
  }
  density: "compact" | "touch"
  children?: React.ReactNode
}

function TreeRow({
  entry,
  depth,
  expanded,
  isActive,
  isFocused,
  flatIndex,
  isRenaming,
  renameValue,
  onRenameChange,
  onRenameSubmit,
  onRenameCancel,
  gitStatus,
  dirGitStatus,
  isDropTarget,
  labels,
  onToggle,
  onOpen,
  onNewFile,
  onNewFromTemplate,
  onNewFolder,
  onRename,
  onCopyPath,
  onOpenToSide,
  onRevealInSystem,
  onAddToChat,
  onFindInFolder,
  onCut,
  onCopy,
  onPaste,
  isCut,
  onDelete,
  dragProps,
  dropProps,
  density,
  children,
}: TreeRowProps) {
  const name = entry.relPath.split("/").pop() ?? entry.relPath
  const badge = entry.isDir ? dirGitStatus : gitStatus
  return (
    <div>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            role="treeitem"
            id={flatIndex !== undefined ? `tree-item-${flatIndex}` : undefined}
            aria-selected={isActive}
            aria-expanded={entry.isDir ? expanded : undefined}
            data-tree-rel={entry.relPath}
            {...(dragProps ?? {})}
            {...(dropProps ?? {})}
            className={cn(
              "relative flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 hover:bg-accent/50",
              density === "touch" && "min-h-11 py-2",
              isActive && "bg-accent text-foreground",
              isFocused && "ring-1 ring-inset ring-primary/50",
              isDropTarget && "bg-primary/15 ring-1 ring-primary/50 ring-inset",
              isCut && "opacity-50"
            )}
            style={{ paddingLeft: `${depth * 12 + 6}px` }}
            data-testid={`tree-row-${entry.relPath}`}
            onClick={() => (entry.isDir ? onToggle() : onOpen("preview"))}
            onDoubleClick={() => {
              if (!entry.isDir) onOpen("pinned")
            }}
          >
            <IndentGuides depth={depth} />
            {entry.isDir ? (
              expanded ? (
                <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
              )
            ) : (
              <span className="w-3.5 shrink-0" />
            )}
            {entry.isDir ? (
              expanded ? (
                <FolderOpenIcon className="size-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
              )
            ) : (
              <FileTypeIcon path={name} />
            )}
            {isRenaming ? (
              <Input
                autoFocus
                aria-label={labels.rename}
                value={renameValue}
                onChange={(e) => onRenameChange(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onBlur={onRenameSubmit}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onRenameSubmit()
                  if (e.key === "Escape") onRenameCancel()
                }}
                className="h-5 py-0 text-sm"
              />
            ) : (
              <span className="min-w-0 flex-1 truncate">{name}</span>
            )}
            {badge ? (
              <span
                className={cn("ml-auto shrink-0 text-[10px] font-semibold", gitStatusColor(badge))}
                data-testid={`tree-git-${entry.relPath}`}
              >
                {STATUS_LETTER[badge]}
              </span>
            ) : null}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent data-testid={`tree-menu-${entry.relPath}`}>
          {entry.isDir ? (
            <>
              <ContextMenuItem onSelect={onNewFile}>{labels.newFile}</ContextMenuItem>
              <ContextMenuSub>
                <ContextMenuSubTrigger>{labels.newFromTemplate}</ContextMenuSubTrigger>
                <ContextMenuSubContent>
                  {FILE_TEMPLATES.map((template) => (
                    <ContextMenuItem key={template.id} onSelect={() => onNewFromTemplate(template)}>
                      {labels.templateLabel(template.id)}
                    </ContextMenuItem>
                  ))}
                </ContextMenuSubContent>
              </ContextMenuSub>
              <ContextMenuItem onSelect={onNewFolder}>{labels.newFolder}</ContextMenuItem>
              {onFindInFolder || onRevealInSystem || onAddToChat ? <ContextMenuSeparator /> : null}
              {onFindInFolder ? (
                <ContextMenuItem onSelect={onFindInFolder}>
                  <FolderSearchIcon className="size-3.5" />
                  {labels.findInFolder}
                </ContextMenuItem>
              ) : null}
            </>
          ) : (
            <>
              <ContextMenuItem onSelect={() => onOpen("pinned")}>
                <FileIcon className="size-3.5" />
                {labels.open}
              </ContextMenuItem>
              {onOpenToSide ? (
                <ContextMenuItem onSelect={onOpenToSide}>
                  <SquareSplitHorizontalIcon className="size-3.5" />
                  {labels.openToSide}
                </ContextMenuItem>
              ) : null}
              <ContextMenuSeparator />
            </>
          )}
          {onRevealInSystem ? (
            <ContextMenuItem onSelect={onRevealInSystem}>
              <ExternalLinkIcon className="size-3.5" />
              {labels.revealInSystem}
            </ContextMenuItem>
          ) : null}
          {onAddToChat ? (
            <ContextMenuItem onSelect={onAddToChat}>
              <MessageSquarePlusIcon className="size-3.5" />
              {labels.addToChat}
            </ContextMenuItem>
          ) : null}
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={onCut}>
            <ScissorsIcon className="size-3.5" />
            {labels.cut}
          </ContextMenuItem>
          <ContextMenuItem disabled={!onCopy} onSelect={onCopy}>
            <CopyIcon className="size-3.5" />
            {labels.copy}
          </ContextMenuItem>
          {entry.isDir ? (
            <ContextMenuItem disabled={!onPaste} onSelect={onPaste}>
              <ClipboardPasteIcon className="size-3.5" />
              {labels.paste}
            </ContextMenuItem>
          ) : null}
          {onCopyPath ? (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem onSelect={() => onCopyPath(false)}>
                <CopyIcon className="size-3.5" />
                {labels.copyRelativePath}
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => onCopyPath(true)}>
                <CopyIcon className="size-3.5" />
                {labels.copyPath}
              </ContextMenuItem>
            </>
          ) : null}
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={onRename}>{labels.rename}</ContextMenuItem>
          <ContextMenuItem onSelect={onDelete} className="text-destructive">
            {labels.delete}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {children}
    </div>
  )
}

/** Badge colour per status — green adds, amber edits, red deletes/conflicts. */
function gitStatusColor(status: GitFileStatus): string {
  switch (status) {
    case "added":
    case "untracked":
      return "text-emerald-600 dark:text-emerald-400"
    case "deleted":
    case "conflicted":
      return "text-red-600 dark:text-red-400"
    case "renamed":
    case "typeChanged":
      return "text-sky-600 dark:text-sky-400"
    default:
      return "text-amber-600 dark:text-amber-400"
  }
}

function CreateInput({
  depth,
  value,
  placeholder,
  onChange,
  onSubmit,
  onCancel,
}: {
  depth: number
  value: string
  placeholder: string
  onChange: (v: string) => void
  onSubmit: () => void
  onCancel: () => void
}) {
  return (
    <div style={{ paddingLeft: `${depth * 12 + 24}px` }} className="relative px-1 py-0.5">
      <IndentGuides depth={depth} />
      <Input
        autoFocus
        aria-label={placeholder}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onSubmit}
        onKeyDown={(e) => {
          if (e.key === "Enter") onSubmit()
          if (e.key === "Escape") onCancel()
        }}
        className="h-5 py-0 text-sm"
      />
    </div>
  )
}
