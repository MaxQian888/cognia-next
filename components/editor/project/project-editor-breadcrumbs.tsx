"use client"

// Path breadcrumbs under the tab strip. Every directory segment opens a
// dropdown listing that directory's children — files open straight into the
// editor, directories nest one submenu deeper (each level listed lazily on
// open, the same contract the file tree uses). The filename itself is the
// non-interactive current page, as breadcrumbs convention has it.

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { ChevronRightIcon, FileIcon, FolderIcon, FolderOpenIcon, Loader2Icon } from "lucide-react"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { FileTypeIcon } from "@/components/shared/file-type-icon"
import { listWorkspaceDir } from "@/lib/files/workspace-fs"
import type { WorkspaceEntry } from "@/lib/files/types"

export interface ProjectBreadcrumbsDeps {
  listDir: typeof listWorkspaceDir
}

interface Props {
  rootPath: string
  /** Root display name (project folder / worktree name). */
  rootName: string
  relPath: string
  onOpenFile: (relPath: string) => void
  /** Reveal a directory in the file tree (dropdown dir fallback). */
  onRevealDir?: (relPath: string) => void
  deps?: Partial<ProjectBreadcrumbsDeps>
}

export function ProjectEditorBreadcrumbs({
  rootPath,
  rootName,
  relPath,
  onOpenFile,
  onRevealDir,
  deps,
}: Props) {
  const segments = relPath.split("/").filter(Boolean)
  // Prefix of `segments` up to (but excluding) index i — the dir a segment's
  // dropdown lists.
  const prefixes = segments.map((_, i) => segments.slice(0, i).join("/"))

  return (
    <Breadcrumb className="border-b px-3 py-1" data-testid="project-editor-breadcrumbs">
      <BreadcrumbList className="flex-nowrap gap-0.5 text-xs sm:gap-0.5">
        <BreadcrumbItem>
          <SegmentDropdown
            rootPath={rootPath}
            dirRel=""
            label={rootName}
            isRoot
            onOpenFile={onOpenFile}
            onRevealDir={onRevealDir}
            deps={deps}
          />
        </BreadcrumbItem>
        {segments.map((segment, i) => {
          const isFile = i === segments.length - 1
          return (
            <span key={prefixes[i]} className="flex min-w-0 items-center gap-0.5">
              <BreadcrumbSeparator>
                <ChevronRightIcon className="size-3" />
              </BreadcrumbSeparator>
              <BreadcrumbItem className="min-w-0">
                {isFile ? (
                  <BreadcrumbPage className="flex min-w-0 items-center gap-1 truncate">
                    <FileTypeIcon path={segment} className="size-3 shrink-0" />
                    <span className="truncate">{segment}</span>
                  </BreadcrumbPage>
                ) : (
                  <SegmentDropdown
                    rootPath={rootPath}
                    dirRel={prefixes[i]}
                    label={segment}
                    onOpenFile={onOpenFile}
                    onRevealDir={onRevealDir}
                    deps={deps}
                  />
                )}
              </BreadcrumbItem>
            </span>
          )
        })}
      </BreadcrumbList>
    </Breadcrumb>
  )
}

function SegmentDropdown({
  rootPath,
  dirRel,
  label,
  isRoot = false,
  onOpenFile,
  onRevealDir,
  deps,
}: {
  rootPath: string
  dirRel: string
  label: string
  isRoot?: boolean
  onOpenFile: (relPath: string) => void
  onRevealDir?: (relPath: string) => void
  deps?: Partial<ProjectBreadcrumbsDeps>
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="flex max-w-40 items-center gap-1 rounded-sm px-1 py-0.5 text-muted-foreground outline-hidden transition-colors hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground"
        data-testid={`breadcrumb-segment-${dirRel || "root"}`}
      >
        {isRoot ? (
          <FolderOpenIcon className="size-3 shrink-0" />
        ) : (
          <FolderIcon className="size-3 shrink-0" />
        )}
        <span className="truncate">{label}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 w-64 overflow-auto">
        <BreadcrumbEntries
          rootPath={rootPath}
          dirRel={dirRel}
          onOpenFile={onOpenFile}
          onRevealDir={onRevealDir}
          deps={deps}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * The children of one directory, fetched when its (sub)menu first renders.
 * Each directory row is itself a submenu, so drilling `a/b/c/d` is possible
 * without leaving the breadcrumb.
 */
function BreadcrumbEntries({
  rootPath,
  dirRel,
  onOpenFile,
  onRevealDir,
  deps,
}: {
  rootPath: string
  dirRel: string
  onOpenFile: (relPath: string) => void
  onRevealDir?: (relPath: string) => void
  deps?: Partial<ProjectBreadcrumbsDeps>
}) {
  const t = useTranslations("projectEditor")
  const listDir = deps?.listDir ?? listWorkspaceDir
  const [state, setState] = useState<
    { status: "loading" } | { status: "ready"; entries: WorkspaceEntry[] } | { status: "error" }
  >({ status: "loading" })

  // Fetch on mount — each dropdown/submenu mounts this on first open and
  // keeps it mounted while open, so the listing is per-open fresh.
  useEffect(() => {
    let cancelled = false
    listDir(rootPath, dirRel || undefined)
      .then((entries) => !cancelled && setState({ status: "ready", entries }))
      .catch(() => !cancelled && setState({ status: "error" }))
    return () => {
      cancelled = true
    }
  }, [listDir, rootPath, dirRel])

  if (state.status === "loading") {
    return (
      <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground">
        <Loader2Icon className="size-3 animate-spin" />
        {t("breadcrumbs.loading")}
      </div>
    )
  }
  if (state.status === "error") {
    return (
      <div className="px-2 py-1.5 text-xs text-muted-foreground">{t("breadcrumbs.failed")}</div>
    )
  }
  if (state.entries.length === 0) {
    return <div className="px-2 py-1.5 text-xs text-muted-foreground">{t("breadcrumbs.empty")}</div>
  }
  return (
    <>
      {state.entries.map((entry) => {
        const name = entry.relPath.split("/").pop() ?? entry.relPath
        if (entry.isDir) {
          return (
            <DropdownMenuSub key={entry.relPath}>
              <DropdownMenuSubTrigger
                className="gap-2"
                data-testid={`breadcrumb-dir-${entry.relPath}`}
              >
                <FolderIcon className="size-3.5" />
                <span className="truncate">{name}</span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-80 w-64 overflow-auto">
                <BreadcrumbEntries
                  rootPath={rootPath}
                  dirRel={entry.relPath}
                  onOpenFile={onOpenFile}
                  onRevealDir={onRevealDir}
                  deps={deps}
                />
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )
        }
        return (
          <DropdownMenuItem
            key={entry.relPath}
            className="gap-2"
            data-testid={`breadcrumb-file-${entry.relPath}`}
            onSelect={() => onOpenFile(entry.relPath)}
          >
            <FileTypeIcon path={name} />
            <span className="truncate">{name}</span>
          </DropdownMenuItem>
        )
      })}
      {onRevealDir ? (
        <DropdownMenuItem
          className="gap-2 text-muted-foreground"
          onSelect={() => onRevealDir(dirRel)}
        >
          <FileIcon className="size-3.5" />
          {t("breadcrumbs.reveal")}
        </DropdownMenuItem>
      ) : null}
    </>
  )
}
