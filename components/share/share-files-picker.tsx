"use client"

/**
 * Pick files from a conversation's FileSpace to put in a share (ADR-0222).
 *
 * Folders browse lazily, one level at a time, through the same ignore-aware
 * listing the file tree uses; a ticked folder (or a whole mount) stands for
 * everything under it, which `expandShareSelection` resolves when the share
 * is built. Uploads and artifacts list their rows. Mounts that cannot be read
 * from here say why instead of offering a box that would fail.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { ChevronDownIcon, ChevronRightIcon, FileIcon, FolderIcon, Loader2Icon } from "lucide-react"

import { Checkbox } from "@/components/ui/checkbox"
import { listWorkspaceDir } from "@/lib/files/workspace-fs"
import type { WorkspaceEntry } from "@/lib/files/types"
import {
  isFileSpacePathWithin,
  joinFileSpacePath,
  normalizeFileSpacePath,
} from "@/lib/filespace/paths"
import type { FileSpaceDexieListing } from "@/lib/filespace/sources"
import { formatBytes } from "@/lib/perf/backend/format"
import { cn } from "@/lib/utils"
import type {
  ConversationFileSpace,
  FileSpaceDexieEntry,
  FileSpaceMount,
  FileSpacePath,
} from "@/types/filespace"

export interface ShareFilesPickerProps {
  space: ConversationFileSpace
  dexie: FileSpaceDexieListing
  selected: readonly FileSpacePath[]
  onToggle: (path: FileSpacePath, checked: boolean) => void
  /** Injectable for tests; the file tree's own listing by default. */
  listDir?: typeof listWorkspaceDir
}

export function ShareFilesPicker({
  space,
  dexie,
  selected,
  onToggle,
  listDir = listWorkspaceDir,
}: ShareFilesPickerProps) {
  const t = useTranslations("share.files")
  const implied = (path: FileSpacePath) =>
    selected.some((chosen) => chosen !== path && isFileSpacePathWithin(path, chosen))
  const state = (path: FileSpacePath): RowState => ({
    checked: selected.includes(path) || implied(path),
    disabled: implied(path),
  })
  const diskMounts = space.mounts.filter((mount) => mount.backing === "disk")

  return (
    <div className="max-h-72 space-y-3 overflow-y-auto rounded-md border p-2 text-sm" role="tree">
      {diskMounts.length > 0 ? (
        <section aria-label={t("folders")}>
          {diskMounts.map((mount) => (
            <MountNode
              key={mount.id}
              mount={mount}
              state={state}
              onToggle={onToggle}
              listDir={listDir}
            />
          ))}
        </section>
      ) : null}
      <DexieSection
        title={t("uploads")}
        mountPath="/uploads"
        entries={dexie.uploads}
        state={state}
        onToggle={onToggle}
      />
      <DexieSection
        title={t("artifacts")}
        mountPath="/artifacts"
        entries={dexie.artifacts}
        state={state}
        onToggle={onToggle}
      />
      {diskMounts.length === 0 && dexie.uploads.length === 0 && dexie.artifacts.length === 0 ? (
        <p className="p-2 text-xs text-muted-foreground">{t("empty")}</p>
      ) : null}
    </div>
  )
}

interface RowState {
  checked: boolean
  /** Covered by a ticked folder above it. */
  disabled: boolean
}

type StateOf = (path: FileSpacePath) => RowState

function Row({
  path,
  label,
  detail,
  icon,
  depth,
  state,
  onToggle,
  expander,
  unavailable,
}: {
  path: FileSpacePath
  label: string
  detail?: string
  icon: React.ReactNode
  depth: number
  state: StateOf
  onToggle: (path: FileSpacePath, checked: boolean) => void
  expander?: React.ReactNode
  unavailable?: string
}) {
  const t = useTranslations("share.files")
  const { checked, disabled } = state(path)
  return (
    <div
      role="treeitem"
      aria-selected={checked}
      className="flex items-center gap-2 rounded px-1 py-0.5 hover:bg-muted/50"
      style={{ paddingLeft: `${depth * 16 + 4}px` }}
    >
      <span className="flex size-4 items-center justify-center">{expander}</span>
      <Checkbox
        checked={checked}
        disabled={disabled || Boolean(unavailable)}
        aria-label={t("select", { name: label })}
        onCheckedChange={(next) => onToggle(path, next === true)}
      />
      <span className="shrink-0 text-muted-foreground">{icon}</span>
      <span className={cn("min-w-0 flex-1 truncate", unavailable && "text-muted-foreground")}>
        {label}
      </span>
      {unavailable ? (
        <span className="shrink-0 text-xs text-muted-foreground">{unavailable}</span>
      ) : detail ? (
        <span className="shrink-0 text-xs text-muted-foreground">{detail}</span>
      ) : null}
    </div>
  )
}

const UNAVAILABLE_KEY: Record<string, string> = {
  "no-fs-backend": "unavailable.noBackend",
  "host-offline": "unavailable.offline",
  "managed-missing-on-device": "unavailable.missing",
  "managed-deleted": "unavailable.deleted",
}

function MountNode({
  mount,
  state,
  onToggle,
  listDir,
}: {
  mount: FileSpaceMount
  state: StateOf
  onToggle: (path: FileSpacePath, checked: boolean) => void
  listDir: typeof listWorkspaceDir
}) {
  const t = useTranslations("share.files")
  const path = normalizeFileSpacePath(mount.virtualPath)
  if (!path) return null
  const readable = mount.status === "available" && Boolean(mount.hostPath)
  const unavailable = readable
    ? undefined
    : t(UNAVAILABLE_KEY[mount.statusReason ?? ""] ?? "unavailable.offline")
  return (
    <DirNode
      root={mount.hostPath ?? ""}
      relPath=""
      path={path}
      label={mount.label}
      depth={0}
      state={state}
      onToggle={onToggle}
      listDir={listDir}
      unavailable={unavailable}
    />
  )
}

type Listing =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "failed" }
  | {
      status: "ready"
      entries: WorkspaceEntry[]
    }

function DirNode({
  root,
  relPath,
  path,
  label,
  depth,
  state,
  onToggle,
  listDir,
  unavailable,
}: {
  root: string
  relPath: string
  path: FileSpacePath
  label: string
  depth: number
  state: StateOf
  onToggle: (path: FileSpacePath, checked: boolean) => void
  listDir: typeof listWorkspaceDir
  unavailable?: string
}) {
  const t = useTranslations("share.files")
  const [open, setOpen] = useState(false)
  const [listing, setListing] = useState<Listing>({ status: "idle" })

  const toggleOpen = () => {
    const next = !open
    setOpen(next)
    if (next && (listing.status === "idle" || listing.status === "failed")) {
      setListing({ status: "loading" })
      listDir(root, relPath || undefined, false).then(
        (entries) => setListing({ status: "ready", entries }),
        () => setListing({ status: "failed" })
      )
    }
  }

  const expander = unavailable ? null : (
    <button
      type="button"
      onClick={toggleOpen}
      aria-label={open ? t("collapse", { name: label }) : t("expand", { name: label })}
      aria-expanded={open}
      className="text-muted-foreground hover:text-foreground"
    >
      {open ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />}
    </button>
  )

  return (
    <div role="group">
      <Row
        path={path}
        label={label}
        icon={<FolderIcon className="size-3.5" />}
        depth={depth}
        state={state}
        onToggle={onToggle}
        expander={expander}
        unavailable={unavailable}
      />
      {open && listing.status === "loading" ? (
        <p
          className="flex items-center gap-1 py-0.5 text-xs text-muted-foreground"
          style={{ paddingLeft: `${(depth + 1) * 16 + 28}px` }}
        >
          <Loader2Icon className="size-3 animate-spin" aria-hidden />
          {t("loading")}
        </p>
      ) : null}
      {open && listing.status === "failed" ? (
        <p
          className="py-0.5 text-xs text-destructive"
          style={{ paddingLeft: `${(depth + 1) * 16 + 28}px` }}
        >
          {t("listFailed")}
        </p>
      ) : null}
      {open && listing.status === "ready"
        ? listing.entries.map((entry) => {
            const childPath = joinFileSpacePath(
              path,
              entry.relPath.slice(relPath ? relPath.length + 1 : 0)
            )
            if (!childPath) return null
            const name = entry.relPath.slice(entry.relPath.lastIndexOf("/") + 1)
            return entry.isDir ? (
              <DirNode
                key={entry.relPath}
                root={root}
                relPath={entry.relPath}
                path={childPath}
                label={name}
                depth={depth + 1}
                state={state}
                onToggle={onToggle}
                listDir={listDir}
              />
            ) : (
              <Row
                key={entry.relPath}
                path={childPath}
                label={name}
                detail={formatBytes(entry.size)}
                icon={<FileIcon className="size-3.5" />}
                depth={depth + 1}
                state={state}
                onToggle={onToggle}
              />
            )
          })
        : null}
    </div>
  )
}

function DexieSection({
  title,
  mountPath,
  entries,
  state,
  onToggle,
}: {
  title: string
  mountPath: string
  entries: FileSpaceDexieEntry[]
  state: StateOf
  onToggle: (path: FileSpacePath, checked: boolean) => void
}) {
  const t = useTranslations("share.files")
  const path = normalizeFileSpacePath(mountPath)
  if (entries.length === 0 || !path) return null
  return (
    <section aria-label={title}>
      <Row
        path={path}
        label={title}
        icon={<FolderIcon className="size-3.5" />}
        depth={0}
        state={state}
        onToggle={onToggle}
      />
      {entries.map((entry) => (
        <Row
          key={entry.sourceId}
          path={entry.path}
          label={entry.path.slice(entry.path.lastIndexOf("/") + 1)}
          detail={formatBytes(entry.size)}
          icon={<FileIcon className="size-3.5" />}
          depth={1}
          state={state}
          onToggle={onToggle}
          unavailable={entry.sourceAvailable ? undefined : t("unavailable.source")}
        />
      ))}
    </section>
  )
}
