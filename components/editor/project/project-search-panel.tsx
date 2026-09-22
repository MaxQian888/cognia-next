"use client"

// Project-wide content search over the Rust `fs_search_content_workspace`
// command (gitignore-aware). Results are grouped by file; clicking a match
// opens the file at the matched line/column.
//
// The toolbar carries the three switches the underlying command supports —
// case sensitivity and regex mode — plus a clear button. Search runs
// debounced on every edit (and immediately on Enter) with a stale-request
// guard so a slow earlier query can't paint over a newer one's results.

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { CaseSensitiveIcon, Loader2Icon, RegexIcon, SearchIcon, XIcon } from "lucide-react"
import { FileTypeIcon } from "@/components/shared/file-type-icon"
import { Input } from "@/components/ui/input"
import { searchWorkspaceContent } from "@/lib/files/workspace-fs"
import type { WorkspaceContentMatch } from "@/lib/files/types"
import { cn } from "@/lib/utils"
import { onTransportChange } from "@/lib/tauri/transport-instance"
import { subscribeActiveRemoteTransport } from "@/lib/tauri/transport-routing"

export interface ProjectSearchDeps {
  search: typeof searchWorkspaceContent
}

interface Props {
  rootPath: string
  active?: boolean
  onOpenMatch: (relPath: string, line: number, column: number) => void
  deps?: Partial<ProjectSearchDeps>
  density?: "compact" | "touch"
}

/** Keystroke-to-query delay; short enough to feel live, long enough to batch. */
const SEARCH_DEBOUNCE_MS = 250

export function ProjectSearchPanel({
  rootPath,
  active = true,
  onOpenMatch,
  deps,
  density = "compact",
}: Props) {
  const t = useTranslations("projectEditor")
  const search = deps?.search ?? searchWorkspaceContent
  const [query, setQuery] = useState("")
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [isRegex, setIsRegex] = useState(false)
  const [matches, setMatches] = useState<WorkspaceContentMatch[]>([])
  const [loading, setLoading] = useState(false)
  const [searched, setSearched] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // A newer query invalidates every earlier in-flight one.
  const requestSeq = useRef(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [hostRevision, setHostRevision] = useState(0)
  const invalidate = useCallback(() => {
    ++requestSeq.current
    clearTimeout(debounceTimer.current)
  }, [])

  useEffect(() => {
    const changed = () => {
      invalidate()
      setHostRevision((revision) => revision + 1)
    }
    const stopTransport = onTransportChange(changed)
    const stopRemote = subscribeActiveRemoteTransport(changed)
    return () => {
      stopTransport()
      stopRemote()
    }
  }, [invalidate])

  useEffect(() => {
    if (active) inputRef.current?.focus()
  }, [active])

  const run = useCallback(
    async (q: string) => {
      clearTimeout(debounceTimer.current)
      if (!active) return
      const trimmed = q.trim()
      const seq = ++requestSeq.current
      if (!trimmed) {
        setMatches([])
        setSearched(false)
        setError(null)
        setLoading(false)
        return
      }
      setLoading(true)
      try {
        const results = await search(rootPath, trimmed, {
          maxResults: 200,
          isRegex,
          caseSensitive,
        })
        if (requestSeq.current !== seq) return
        setMatches(results)
        setError(null)
      } catch (err) {
        if (requestSeq.current !== seq) return
        setMatches([])
        // An invalid regex is user error; everything else is a backend report.
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (requestSeq.current === seq) {
          setLoading(false)
          setSearched(true)
        }
      }
    },
    [active, rootPath, search, isRegex, caseSensitive]
  )

  // Debounced live search — every edit re-arms the timer; Enter bypasses it.
  useEffect(() => {
    // Invalidate immediately, including the debounce window and hidden time.
    invalidate()
    if (active) debounceTimer.current = setTimeout(() => void run(query), SEARCH_DEBOUNCE_MS)
    return invalidate
  }, [active, query, run, hostRevision, invalidate])

  useEffect(() => {
    // Results are scoped to a host/root, even when the same query is retained.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMatches([])
    setSearched(false)
    setError(null)
    setLoading(false)
  }, [rootPath, hostRevision])

  const grouped = useMemo(() => {
    const byFile = new Map<string, WorkspaceContentMatch[]>()
    for (const m of matches) {
      const arr = byFile.get(m.relPath) ?? []
      arr.push(m)
      byFile.set(m.relPath, arr)
    }
    return [...byFile.entries()]
  }, [matches])

  const toggleClass = (active: boolean) =>
    cn(
      "flex shrink-0 items-center justify-center rounded p-1",
      density === "touch" ? "size-9" : "size-6",
      active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60"
    )

  return (
    <div className="flex h-full flex-col" data-testid="project-search-panel">
      <div className="flex items-center gap-1 border-b px-2 py-1.5">
        <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <Input
          ref={inputRef}
          value={query}
          placeholder={t("searchPlaceholder")}
          aria-label={t("search")}
          className={cn("h-7 text-sm", density === "touch" && "h-11")}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void run(query)
            if (e.key === "Escape") setQuery("")
          }}
        />
        <button
          type="button"
          className={toggleClass(caseSensitive)}
          aria-pressed={caseSensitive}
          aria-label={t("searchOptions.caseSensitive")}
          title={t("searchOptions.caseSensitive")}
          onClick={() => setCaseSensitive((v) => !v)}
          data-testid="search-case-toggle"
        >
          <CaseSensitiveIcon className="size-3.5" />
        </button>
        <button
          type="button"
          className={toggleClass(isRegex)}
          aria-pressed={isRegex}
          aria-label={t("searchOptions.regex")}
          title={t("searchOptions.regex")}
          onClick={() => setIsRegex((v) => !v)}
          data-testid="search-regex-toggle"
        >
          <RegexIcon className="size-3.5" />
        </button>
        {query ? (
          <button
            type="button"
            className={toggleClass(false)}
            aria-label={t("searchOptions.clear")}
            title={t("searchOptions.clear")}
            onClick={() => setQuery("")}
            data-testid="search-clear"
          >
            <XIcon className="size-3.5" />
          </button>
        ) : null}
        {loading ? <Loader2Icon className="size-3.5 shrink-0 animate-spin" /> : null}
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-1 text-sm">
        {error ? (
          <p className="px-3 py-2 text-xs text-destructive" data-testid="search-error">
            {error}
          </p>
        ) : null}
        {!error && searched && matches.length === 0 && !loading ? (
          <p className="px-3 py-2 text-xs text-muted-foreground">{t("searchEmpty")}</p>
        ) : null}
        {searched && matches.length > 0 ? (
          <p className="px-3 pb-1 text-[11px] text-muted-foreground" data-testid="search-count">
            {t("searchResults", { count: matches.length, files: grouped.length })}
          </p>
        ) : null}
        {grouped.map(([relPath, fileMatches]) => (
          <div key={relPath} className="mb-1">
            {/* Sticky so a long file's results keep their filename while the
                list scrolls; the count badge matches VS Code's group header. */}
            <div className="sticky top-0 z-10 flex items-center gap-1.5 bg-background px-2 py-0.5 text-xs font-medium text-muted-foreground">
              <FileTypeIcon
                path={relPath.split("/").pop() ?? relPath}
                className="size-3.5 shrink-0"
              />
              <span className="min-w-0 flex-1 truncate">{relPath}</span>
              <span className="shrink-0 rounded-full bg-muted px-1.5 text-[10px] leading-4 tabular-nums">
                {fileMatches.length}
              </span>
            </div>
            {fileMatches.map((m, i) => (
              <button
                key={`${m.line}:${m.column}:${i}`}
                type="button"
                data-testid={`search-hit-${relPath}-${m.line}`}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-0.5 text-left hover:bg-accent/50",
                  density === "touch" && "min-h-11 py-2"
                )}
                onClick={() => onOpenMatch(relPath, m.line, m.column)}
              >
                <span className="w-8 shrink-0 text-right text-xs text-muted-foreground">
                  {m.line}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{m.preview}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
