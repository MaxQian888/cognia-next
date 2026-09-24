"use client"

// VS Code's Problems panel (⌘⇧M): every marker Monaco knows about, grouped
// by file, click-through to the offending line. The marker store is
// instance-global — `getModelMarkers({})` with no resource filter covers
// every model (all open files, plus anything a plugin/LSP pushed through
// `setModelMarkers`), so the panel is a workspace view, not a per-editor
// view like the status-bar summary.
//
// The filter box follows VS Code's Problems filter grammar: comma-separated
// terms, `!` negates a term, a term with `*` / `?` / `/` is a glob over the
// file's workspace-relative path, anything else is a case-insensitive text
// match over message, source and path.

import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { useTranslations } from "next-intl"
import {
  AlertCircleIcon,
  AlertTriangleIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CopyIcon,
  InfoIcon,
  MessageSquarePlusIcon,
  XIcon,
} from "lucide-react"

import { matchesDeniedGlob } from "@/lib/files/glob-match"
import { fileUriToPath } from "@/lib/files/path-uri"
import { cn } from "@/lib/utils"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { type EditorMarker, type MarkerSummary, type MonacoLike } from "@/hooks/use-monaco-markers"

export interface WorkbenchMarker extends EditorMarker {
  /** Path relative to the workspace root — the navigation target. */
  relPath: string
}

interface WorkbenchMarkerFile {
  relPath: string
  markers: WorkbenchMarker[]
}

const EMPTY_SUMMARY: MarkerSummary = { errors: 0, warnings: 0, infos: 0 }
const EMPTY_FILES: WorkbenchMarkerFile[] = []

function kindFor(severity: number): EditorMarker["kind"] {
  if (severity >= 8) return "error"
  if (severity >= 4) return "warning"
  return "info"
}

/**
 * All markers across every model, grouped by file in workspace order.
 * Mirrors `useMonacoMarkers`' syncExternalStore pattern — a signature cache
 * keeps the snapshot reference stable so the store doesn't loop.
 */
export function useWorkbenchMarkers(
  monaco: MonacoLike | null | undefined,
  rootPath: string | null
): { files: WorkbenchMarkerFile[]; summary: MarkerSummary } {
  const cacheRef = useRef<{ sig: string; files: WorkbenchMarkerFile[] }>({
    sig: "∅",
    files: EMPTY_FILES,
  })

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!monaco) return () => {}
      const sub = monaco.editor.onDidChangeMarkers(() => onStoreChange())
      return () => sub.dispose()
    },
    [monaco]
  )

  const getSnapshot = useCallback((): WorkbenchMarkerFile[] => {
    if (!monaco) {
      if (cacheRef.current.sig !== "∅") cacheRef.current = { sig: "∅", files: EMPTY_FILES }
      return cacheRef.current.files
    }
    const raw = monaco.editor.getModelMarkers({})
    const rootPrefix = rootPath ? `${rootPath.replace(/\/+$/, "")}/` : null
    const relFor = (marker: (typeof raw)[number]): string => {
      const uri = marker.resource?.toString() ?? ""
      const abs = uri.startsWith("file://") ? (fileUriToPath(uri) ?? uri) : uri
      if (rootPrefix && abs.startsWith(rootPrefix)) return abs.slice(rootPrefix.length)
      return abs
    }
    const sig = raw
      .map(
        (m) =>
          `${m.resource?.toString() ?? ""}:${m.severity}:${m.startLineNumber}:${m.startColumn}:${m.message}`
      )
      .join("|")
    if (sig === cacheRef.current.sig) return cacheRef.current.files
    const byFile = new Map<string, WorkbenchMarker[]>()
    for (const m of raw) {
      const relPath = relFor(m)
      const list = byFile.get(relPath) ?? []
      list.push({ ...m, kind: kindFor(m.severity), relPath })
      byFile.set(relPath, list)
    }
    const files = [...byFile.entries()]
      .map(([relPath, markers]) => ({
        relPath,
        markers: markers.sort(
          (a, b) => a.startLineNumber - b.startLineNumber || a.startColumn - b.startColumn
        ),
      }))
      .sort((a, b) => a.relPath.localeCompare(b.relPath))
    cacheRef.current = { sig, files }
    return files
  }, [monaco, rootPath])

  const files = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  const summary = useMemo<MarkerSummary>(() => {
    let errors = 0
    let warnings = 0
    let infos = 0
    for (const f of files) {
      for (const m of f.markers) {
        if (m.kind === "error") errors++
        else if (m.kind === "warning") warnings++
        else infos++
      }
    }
    if (errors + warnings + infos === 0) return EMPTY_SUMMARY
    return { errors, warnings, infos }
  }, [files])

  return { files, summary }
}

function SeverityIcon({ kind }: { kind: EditorMarker["kind"] }) {
  if (kind === "error") return <AlertCircleIcon className="size-3.5 text-red-500" />
  if (kind === "warning") return <AlertTriangleIcon className="size-3.5 text-amber-500" />
  return <InfoIcon className="size-3.5 text-blue-500" />
}

interface ProjectProblemsPanelProps {
  monaco: MonacoLike | null
  rootPath: string | null
  onNavigate: (relPath: string, line: number, column: number) => void
  onClose: () => void
  /** Stage one marker as a chat context chip ("ask the agent to fix this"). */
  onAddToChat?: (relPath: string, marker: WorkbenchMarker) => void
  /** Stage every marker of one file as a single chat context chip. */
  onAddMarkersToChat?: (relPath: string, markers: WorkbenchMarker[]) => void
}

/**
 * One parsed filter term. `value` is lowercased: text terms compare
 * case-insensitively, and globs are matched against the lowercased path (the
 * glob matcher leaves case folding to its caller).
 */
interface ProblemsFilterTerm {
  kind: "text" | "glob"
  value: string
}

interface ProblemsFilter {
  include: ProblemsFilterTerm[]
  exclude: ProblemsFilterTerm[]
}

/** A term is a glob when it uses any glob syntax the path matcher understands. */
function isGlobTerm(term: string): boolean {
  return /[*?/]/.test(term)
}

/**
 * Parse the filter box into include / exclude terms. Terms are split on
 * commas and trimmed; empty terms (stray commas, a bare `!`) are dropped.
 * Returns `null` when nothing remains — every marker is shown.
 */
function parseProblemsFilter(raw: string): ProblemsFilter | null {
  const include: ProblemsFilterTerm[] = []
  const exclude: ProblemsFilterTerm[] = []
  for (const part of raw.split(",")) {
    const trimmed = part.trim()
    const negated = trimmed.startsWith("!")
    const body = (negated ? trimmed.slice(1) : trimmed).trim().toLowerCase()
    if (!body) continue
    const term: ProblemsFilterTerm = { kind: isGlobTerm(body) ? "glob" : "text", value: body }
    if (negated) exclude.push(term)
    else include.push(term)
  }
  return include.length === 0 && exclude.length === 0 ? null : { include, exclude }
}

/**
 * Does one term hit this marker? A glob looks only at the file path
 * (segment-aware, basename-style when it has no `/`); text looks at the
 * message, the source and the path.
 */
function termMatches(term: ProblemsFilterTerm, relPath: string, marker: WorkbenchMarker): boolean {
  if (term.kind === "glob") return matchesDeniedGlob(relPath.toLowerCase(), term.value)
  return (
    marker.message.toLowerCase().includes(term.value) ||
    (marker.source ?? "").toLowerCase().includes(term.value) ||
    relPath.toLowerCase().includes(term.value)
  )
}

/** Shown when any include term hits (or there are none) and no exclude term does. */
function markerPassesFilter(
  filter: ProblemsFilter,
  relPath: string,
  marker: WorkbenchMarker
): boolean {
  if (filter.include.length > 0 && !filter.include.some((t) => termMatches(t, relPath, marker))) {
    return false
  }
  return !filter.exclude.some((t) => termMatches(t, relPath, marker))
}

/** The clipboard form of one marker — VS Code's Copy on a Problems row. */
function markerCopyText(relPath: string, marker: WorkbenchMarker): string {
  return (
    `${relPath}:${marker.startLineNumber}:${marker.startColumn} ` +
    `${marker.kind}: ${marker.message}` +
    (marker.source ? ` (${marker.source})` : "")
  )
}

export function ProjectProblemsPanel({
  monaco,
  rootPath,
  onNavigate,
  onClose,
  onAddToChat,
  onAddMarkersToChat,
}: ProjectProblemsPanelProps) {
  const t = useTranslations("projectEditor")
  const { files, summary } = useWorkbenchMarkers(monaco, rootPath)
  const [filter, setFilter] = useState("")
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())

  const parsedFilter = useMemo(() => parseProblemsFilter(filter), [filter])
  const visibleFiles = useMemo(() => {
    if (!parsedFilter) return files
    return files
      .map((f) => ({
        relPath: f.relPath,
        markers: f.markers.filter((m) => markerPassesFilter(parsedFilter, f.relPath, m)),
      }))
      .filter((f) => f.markers.length > 0)
  }, [files, parsedFilter])

  const toggleFile = (relPath: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(relPath)) next.delete(relPath)
      else next.add(relPath)
      return next
    })

  const total = summary.errors + summary.warnings + summary.infos

  return (
    <div
      className="flex h-44 shrink-0 flex-col border-t bg-background text-xs"
      data-testid="problems-panel"
      role="region"
      aria-label={t("problems.title")}
    >
      {/* The panel is as wide as the editor column — in the chat dock often
          under 400px — so the counts (the status bar repeats them) give way
          first and the filter shrinks rather than pushing the close button
          out of reach. */}
      <div className="@container/problems flex h-8 min-w-0 shrink-0 items-center gap-3 border-b px-3">
        <span className="shrink-0 font-medium tracking-wide uppercase text-muted-foreground">
          {t("problems.title")}
        </span>
        {total > 0 ? (
          <span className="hidden shrink-0 items-center gap-2 text-muted-foreground @sm/problems:flex">
            {summary.errors > 0 ? (
              <span className="flex items-center gap-0.5 text-red-500">
                <AlertCircleIcon className="size-3" />
                {summary.errors}
              </span>
            ) : null}
            {summary.warnings > 0 ? (
              <span className="flex items-center gap-0.5 text-amber-500">
                <AlertTriangleIcon className="size-3" />
                {summary.warnings}
              </span>
            ) : null}
            {summary.infos > 0 ? (
              <span className="flex items-center gap-0.5">
                <InfoIcon className="size-3" />
                {summary.infos}
              </span>
            ) : null}
          </span>
        ) : null}
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={t("problems.filter")}
          aria-label={t("problems.filter")}
          className="ml-auto h-6 w-44 min-w-16 shrink rounded-sm border bg-transparent px-2 outline-none placeholder:text-muted-foreground/60 focus:border-ring"
          data-testid="problems-filter"
        />
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 rounded-sm p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label={t("problems.close")}
          data-testid="problems-close"
        >
          <XIcon className="size-3.5" />
        </button>
      </div>
      <div className="workbench-scroll min-h-0 flex-1 overflow-y-auto" data-testid="problems-list">
        {visibleFiles.length === 0 ? (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            {total === 0 ? t("problems.empty") : t("problems.noMatch")}
          </div>
        ) : (
          visibleFiles.map((file) => {
            const isCollapsed = collapsed.has(file.relPath)
            return (
              <div key={file.relPath}>
                <ContextMenu>
                  <ContextMenuTrigger asChild>
                    <button
                      type="button"
                      onClick={() => toggleFile(file.relPath)}
                      className="flex w-full items-center gap-1.5 px-2 py-1 text-left hover:bg-accent/50"
                      data-testid={`problems-file-${file.relPath}`}
                    >
                      {isCollapsed ? (
                        <ChevronRightIcon className="size-3 text-muted-foreground" />
                      ) : (
                        <ChevronDownIcon className="size-3 text-muted-foreground" />
                      )}
                      <span className="truncate font-medium">{file.relPath}</span>
                      <span
                        className={cn(
                          "ml-auto rounded-sm px-1 text-[10px] tabular-nums",
                          file.markers.some((m) => m.kind === "error")
                            ? "bg-red-500/15 text-red-500"
                            : "bg-amber-500/15 text-amber-600"
                        )}
                      >
                        {file.markers.length}
                      </span>
                    </button>
                  </ContextMenuTrigger>
                  <ContextMenuContent data-testid={`problems-file-menu-${file.relPath}`}>
                    <ContextMenuItem
                      onSelect={() => void navigator.clipboard?.writeText(file.relPath)}
                    >
                      <CopyIcon className="size-3.5" />
                      {t("action.copyRelativePath")}
                    </ContextMenuItem>
                    {onAddMarkersToChat ? (
                      <ContextMenuItem
                        onSelect={() => onAddMarkersToChat(file.relPath, file.markers)}
                      >
                        <MessageSquarePlusIcon className="size-3.5" />
                        {t("action.addToChat")}
                      </ContextMenuItem>
                    ) : null}
                  </ContextMenuContent>
                </ContextMenu>
                {isCollapsed
                  ? null
                  : file.markers.map((m, i) => (
                      <ContextMenu key={`${m.startLineNumber}:${m.startColumn}:${i}`}>
                        <ContextMenuTrigger asChild>
                          <button
                            type="button"
                            onClick={() =>
                              onNavigate(file.relPath, m.startLineNumber, m.startColumn)
                            }
                            className="flex w-full items-start gap-2 px-2 py-0.5 pl-7 text-left hover:bg-accent/50"
                            data-testid={`problems-marker-${file.relPath}-${m.startLineNumber}-${m.startColumn}`}
                          >
                            <SeverityIcon kind={m.kind} />
                            <span className="min-w-0 flex-1">
                              <span className="break-words">{m.message}</span>
                              {m.source ? (
                                <span className="ml-1 text-muted-foreground">({m.source})</span>
                              ) : null}
                            </span>
                            <span className="shrink-0 tabular-nums text-muted-foreground">
                              [{m.startLineNumber}, {m.startColumn}]
                            </span>
                          </button>
                        </ContextMenuTrigger>
                        <ContextMenuContent
                          data-testid={`problems-marker-menu-${file.relPath}-${m.startLineNumber}`}
                        >
                          <ContextMenuItem
                            onSelect={() =>
                              void navigator.clipboard?.writeText(markerCopyText(file.relPath, m))
                            }
                          >
                            <CopyIcon className="size-3.5" />
                            {t("action.copy")}
                          </ContextMenuItem>
                          {onAddToChat ? (
                            <ContextMenuItem onSelect={() => onAddToChat(file.relPath, m)}>
                              <MessageSquarePlusIcon className="size-3.5" />
                              {t("action.addToChat")}
                            </ContextMenuItem>
                          ) : null}
                        </ContextMenuContent>
                      </ContextMenu>
                    ))}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
