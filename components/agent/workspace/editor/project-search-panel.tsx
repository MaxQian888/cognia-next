"use client"

// Project-wide content search over the Rust `fs_search_content_workspace`
// command (gitignore-aware). Results are grouped by file; clicking a match
// opens the file at the matched line/column.

import { useCallback, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { SearchIcon, Loader2Icon } from "lucide-react"
import { Input } from "@/components/ui/input"
import { searchWorkspaceContent } from "@/lib/files/workspace-fs"
import type { WorkspaceContentMatch } from "@/lib/files/types"

export interface ProjectSearchDeps {
  search: typeof searchWorkspaceContent
}

interface Props {
  rootPath: string
  onOpenMatch: (relPath: string, line: number, column: number) => void
  deps?: Partial<ProjectSearchDeps>
}

export function ProjectSearchPanel({ rootPath, onOpenMatch, deps }: Props) {
  const t = useTranslations("agentTeamsWorkspace.editor")
  const search = deps?.search ?? searchWorkspaceContent
  const [query, setQuery] = useState("")
  const [matches, setMatches] = useState<WorkspaceContentMatch[]>([])
  const [loading, setLoading] = useState(false)
  const [searched, setSearched] = useState(false)

  const run = useCallback(async () => {
    const q = query.trim()
    if (!q) {
      setMatches([])
      setSearched(false)
      return
    }
    setLoading(true)
    try {
      const results = await search(rootPath, q, { maxResults: 200 })
      setMatches(results)
    } catch {
      setMatches([])
    } finally {
      setLoading(false)
      setSearched(true)
    }
  }, [query, rootPath, search])

  const grouped = useMemo(() => {
    const byFile = new Map<string, WorkspaceContentMatch[]>()
    for (const m of matches) {
      const arr = byFile.get(m.relPath) ?? []
      arr.push(m)
      byFile.set(m.relPath, arr)
    }
    return [...byFile.entries()]
  }, [matches])

  return (
    <div className="flex h-full flex-col" data-testid="project-search-panel">
      <div className="flex items-center gap-1 border-b px-2 py-1.5">
        <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <Input
          value={query}
          placeholder={t("searchPlaceholder")}
          aria-label={t("search")}
          className="h-7 text-sm"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void run()
          }}
        />
        {loading ? <Loader2Icon className="size-3.5 shrink-0 animate-spin" /> : null}
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-1 text-sm">
        {searched && matches.length === 0 && !loading ? (
          <p className="px-3 py-2 text-xs text-muted-foreground">{t("searchEmpty")}</p>
        ) : null}
        {grouped.map(([relPath, fileMatches]) => (
          <div key={relPath} className="mb-1">
            <div className="truncate px-2 py-0.5 text-xs font-medium text-muted-foreground">
              {relPath}
            </div>
            {fileMatches.map((m, i) => (
              <button
                key={`${m.line}:${m.column}:${i}`}
                type="button"
                data-testid={`search-hit-${relPath}-${m.line}`}
                className="flex w-full items-center gap-2 px-3 py-0.5 text-left hover:bg-accent/50"
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
