"use client"

// Lazy, CRUD-capable project file tree over `lib/files/workspace-fs`. Each
// directory is listed on first expand (`.gitignore`-respecting). Right-click a
// row for New File / New Folder / Rename / Delete. Files open on click.

import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import {
  ChevronRightIcon,
  ChevronDownIcon,
  FolderIcon,
  RefreshCwIcon,
  FilePlusIcon,
  FolderPlusIcon,
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
import type { WorkspaceEntry } from "@/lib/files/types"
import type {
  listWorkspaceDir,
  createWorkspaceDir,
  writeWorkspaceFile,
  deleteWorkspaceEntry,
  renameWorkspaceEntry,
} from "@/lib/files/workspace-fs"

export interface ProjectFileTreeDeps {
  listDir: typeof listWorkspaceDir
  createDir: typeof createWorkspaceDir
  writeFile: typeof writeWorkspaceFile
  deleteEntry: typeof deleteWorkspaceEntry
  renameEntry: typeof renameWorkspaceEntry
}

interface Props {
  rootPath: string
  /** Bump to force a reload of every expanded directory (external change). */
  refreshToken?: number
  activePath: string | null
  /** Opens a file. A plain tree click asks for a preview tab; a double-click pins it. */
  onOpenFile: (relPath: string, options?: { mode?: EditorTabMode }) => void
  deps: ProjectFileTreeDeps
  density?: "compact" | "touch"
  onRenamed?: (from: string, to: string) => void | Promise<void>
}

const parentOf = (rel: string) => rel.split("/").slice(0, -1).join("/")
const joinRel = (parent: string, name: string) => (parent ? `${parent}/${name}` : name)

export function ProjectFileTree({
  rootPath,
  refreshToken,
  activePath,
  onOpenFile,
  deps,
  density = "compact",
  onRenamed,
}: Props) {
  const t = useTranslations("projectEditor")
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([""]))
  const [childrenByDir, setChildrenByDir] = useState<Record<string, WorkspaceEntry[]>>({})
  const [pendingCreate, setPendingCreate] = useState<{
    parent: string
    kind: "file" | "folder"
  } | null>(null)
  const [createName, setCreateName] = useState("")
  const [renameTarget, setRenameTarget] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState("")
  const [deleteTarget, setDeleteTarget] = useState<WorkspaceEntry | null>(null)

  const loadDir = useCallback(
    async (dirRel: string) => {
      try {
        const entries = await deps.listDir(rootPath, dirRel || undefined)
        setChildrenByDir((prev) => ({ ...prev, [dirRel]: entries }))
      } catch {
        setChildrenByDir((prev) => ({ ...prev, [dirRel]: [] }))
      }
    },
    [deps, rootPath]
  )

  // Reset the tree and load the root on mount / root change. The synchronous
  // resets are intentional (a fresh root must start from a clean tree).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setExpanded(new Set([""]))
    setChildrenByDir({})
    void loadDir("")
  }, [loadDir])

  // Reload every currently-expanded dir when the external-change token bumps.
  // `loadDir` sets state only after its async listDir resolves (not a
  // synchronous set-in-effect), so the set-state rule is a false positive here.
  useEffect(() => {
    if (refreshToken === undefined) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    for (const dir of expanded) void loadDir(dir)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken])

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

  const submitCreate = useCallback(async () => {
    if (!pendingCreate || !createName.trim()) {
      setPendingCreate(null)
      return
    }
    const rel = joinRel(pendingCreate.parent, createName.trim())
    try {
      if (pendingCreate.kind === "folder") await deps.createDir(rootPath, rel)
      else await deps.writeFile(rootPath, rel, "")
      await loadDir(pendingCreate.parent)
      if (pendingCreate.kind === "file") onOpenFile(rel)
    } catch {
      /* surfaced by the caller's error toast path */
    }
    setPendingCreate(null)
    setCreateName("")
  }, [pendingCreate, createName, deps, rootPath, loadDir, onOpenFile])

  const submitRename = useCallback(async () => {
    if (!renameTarget || !renameValue.trim()) {
      setRenameTarget(null)
      return
    }
    const parent = parentOf(renameTarget)
    const to = joinRel(parent, renameValue.trim())
    try {
      await deps.renameEntry(rootPath, renameTarget, to)
      await onRenamed?.(renameTarget, to)
      await loadDir(parent)
    } catch {
      /* ignore */
    }
    setRenameTarget(null)
  }, [renameTarget, renameValue, deps, rootPath, loadDir, onRenamed])

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return
    try {
      await deps.deleteEntry(rootPath, deleteTarget.relPath, deleteTarget.isDir)
      await loadDir(parentOf(deleteTarget.relPath))
    } catch {
      /* ignore */
    }
    setDeleteTarget(null)
  }, [deleteTarget, deps, rootPath, loadDir])

  const renderChildren = (dirRel: string, depth: number) => {
    const entries = childrenByDir[dirRel]
    if (!entries) return null
    return entries.map((entry) => (
      <TreeRow
        key={entry.relPath}
        entry={entry}
        depth={depth}
        expanded={expanded.has(entry.relPath)}
        isActive={activePath === entry.relPath}
        isRenaming={renameTarget === entry.relPath}
        renameValue={renameValue}
        onRenameChange={setRenameValue}
        onRenameSubmit={submitRename}
        onRenameCancel={() => setRenameTarget(null)}
        labels={{
          newFile: t("newFile"),
          newFolder: t("newFolder"),
          rename: t("rename"),
          delete: t("delete"),
        }}
        onToggle={() => toggle(entry.relPath)}
        onOpen={(mode) => onOpenFile(entry.relPath, { mode })}
        onNewFile={() => {
          setExpanded((p) => new Set(p).add(entry.relPath))
          setPendingCreate({ parent: entry.relPath, kind: "file" })
        }}
        onNewFolder={() => {
          setExpanded((p) => new Set(p).add(entry.relPath))
          setPendingCreate({ parent: entry.relPath, kind: "folder" })
        }}
        onRename={() => {
          setRenameValue(entry.relPath.split("/").pop() ?? "")
          setRenameTarget(entry.relPath)
        }}
        onDelete={() => setDeleteTarget(entry)}
        density={density}
      >
        {entry.isDir && expanded.has(entry.relPath) ? (
          <>
            {pendingCreate?.parent === entry.relPath ? (
              <CreateInput
                depth={depth + 1}
                value={createName}
                placeholder={pendingCreate.kind === "folder" ? t("newFolder") : t("newFile")}
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

  const rootIsEmpty = useMemo(() => (childrenByDir[""] ?? []).length === 0, [childrenByDir])

  return (
    <div className="flex h-full flex-col" data-testid="project-file-tree">
      <div className="flex items-center gap-1 border-b px-2 py-1">
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">
          {t("treeAria")}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className={cn("size-6", density === "touch" && "size-11")}
          aria-label={t("newFile")}
          onClick={() => setPendingCreate({ parent: "", kind: "file" })}
        >
          <FilePlusIcon className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className={cn("size-6", density === "touch" && "size-11")}
          aria-label={t("newFolder")}
          onClick={() => setPendingCreate({ parent: "", kind: "folder" })}
        >
          <FolderPlusIcon className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className={cn("size-6", density === "touch" && "size-11")}
          aria-label={t("refresh")}
          onClick={() => void loadDir("")}
        >
          <RefreshCwIcon className="size-3.5" />
        </Button>
      </div>
      <FileTree
        className="min-h-0 flex-1 overflow-auto rounded-none border-0 bg-transparent py-1 text-sm [&>div]:p-0"
        expanded={expanded}
        selectedPath={activePath ?? undefined}
      >
        {pendingCreate?.parent === "" ? (
          <CreateInput
            depth={0}
            value={createName}
            placeholder={pendingCreate.kind === "folder" ? t("newFolder") : t("newFile")}
            onChange={setCreateName}
            onSubmit={submitCreate}
            onCancel={() => setPendingCreate(null)}
          />
        ) : null}
        {renderChildren("", 0)}
        {rootIsEmpty && !pendingCreate ? (
          <p className="px-3 py-2 text-xs text-muted-foreground">{t("treeEmpty")}</p>
        ) : null}
      </FileTree>

      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
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

interface TreeRowProps {
  entry: WorkspaceEntry
  depth: number
  expanded: boolean
  isActive: boolean
  isRenaming: boolean
  renameValue: string
  onRenameChange: (v: string) => void
  onRenameSubmit: () => void
  onRenameCancel: () => void
  labels: { newFile: string; newFolder: string; rename: string; delete: string }
  onToggle: () => void
  onOpen: (mode: EditorTabMode) => void
  onNewFile: () => void
  onNewFolder: () => void
  onRename: () => void
  onDelete: () => void
  density: "compact" | "touch"
  children?: React.ReactNode
}

function TreeRow({
  entry,
  depth,
  expanded,
  isActive,
  isRenaming,
  renameValue,
  onRenameChange,
  onRenameSubmit,
  onRenameCancel,
  labels,
  onToggle,
  onOpen,
  onNewFile,
  onNewFolder,
  onRename,
  onDelete,
  density,
  children,
}: TreeRowProps) {
  const name = entry.relPath.split("/").pop() ?? entry.relPath
  return (
    <div>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            role="treeitem"
            aria-selected={isActive}
            aria-expanded={entry.isDir ? expanded : undefined}
            className={cn(
              "flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 hover:bg-accent/50",
              density === "touch" && "min-h-11 py-2",
              isActive && "bg-accent"
            )}
            style={{ paddingLeft: `${depth * 12 + 6}px` }}
            data-testid={`tree-row-${entry.relPath}`}
            onClick={() => (entry.isDir ? onToggle() : onOpen("preview"))}
            onDoubleClick={() => {
              if (!entry.isDir) onOpen("pinned")
            }}
          >
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
              <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
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
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          {entry.isDir ? (
            <>
              <ContextMenuItem onSelect={onNewFile}>{labels.newFile}</ContextMenuItem>
              <ContextMenuItem onSelect={onNewFolder}>{labels.newFolder}</ContextMenuItem>
              <ContextMenuSeparator />
            </>
          ) : null}
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
    <div style={{ paddingLeft: `${depth * 12 + 24}px` }} className="px-1 py-0.5">
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
