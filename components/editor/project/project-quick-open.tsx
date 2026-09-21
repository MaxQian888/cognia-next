"use client"

// ⌘P / Ctrl+P quick-open: fuzzy file picker over a lazily-built workspace
// index. The index comes from `walkWorkspace` (gitignore-aware, capped) and
// refreshes stale-while-revalidate every time the palette opens, so a file
// created while it was closed still shows. Ranking reuses the composer's
// `fuzzyFilterSortRanked` so every picker in the app scores identically; the
// returned match positions paint the matched characters.

import { useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { FolderSearchIcon } from "lucide-react"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { FileTypeIcon } from "@/components/shared/file-type-icon"
import { fuzzyFilterSortRanked } from "@/lib/chat/completion/fuzzy-match"
import { walkWorkspace } from "@/lib/files/workspace-fs"
import type { WorkspaceEntry } from "@/lib/files/types"

export interface ProjectQuickOpenDeps {
  walk: typeof walkWorkspace
}

/** Cap for the walk — comfortably above a normal repo's tracked-file count. */
const INDEX_MAX_ENTRIES = 20_000
/** Rows offered to cmdk per query — beyond this the picker scrolls badly. */
const RESULT_LIMIT = 60

interface Props {
  rootPath: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Open a file — pinned, the way a deliberate picker result always means. */
  onOpenFile: (relPath: string) => void
  /** Currently open relPaths, used for the "open editors" recency group. */
  openPaths?: string[]
  deps?: Partial<ProjectQuickOpenDeps>
}

export function ProjectQuickOpen({
  rootPath,
  open,
  onOpenChange,
  onOpenFile,
  openPaths = [],
  deps,
}: Props) {
  const t = useTranslations("projectEditor")
  const walk = deps?.walk ?? walkWorkspace
  const [query, setQuery] = useState("")
  const [index, setIndex] = useState<{ entries: WorkspaceEntry[]; truncated: boolean } | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  // Stale-read guard: a slow walk finishing after the palette re-opened under
  // a newer root must not paint the old index.
  const requestSeq = useRef(0)

  // Reset on the closed→open transition during render — the sanctioned
  // alternative to syncing state inside the walk effect below.
  const [prevOpen, setPrevOpen] = useState(open)
  if (open !== prevOpen) {
    setPrevOpen(open)
    if (open) {
      setQuery("")
      setRefreshing(true)
    }
  }

  useEffect(() => {
    if (!open) return
    const seq = ++requestSeq.current
    walk(rootPath, { maxEntries: INDEX_MAX_ENTRIES })
      .then((result) => {
        if (requestSeq.current !== seq) return
        setIndex({ entries: result.entries.filter((e) => !e.isDir), truncated: result.truncated })
      })
      .catch(() => {
        if (requestSeq.current === seq) setIndex({ entries: [], truncated: false })
      })
      .finally(() => {
        if (requestSeq.current === seq) setRefreshing(false)
      })
  }, [open, rootPath, walk])

  const ranked = useMemo(() => {
    const entries = index?.entries ?? []
    return fuzzyFilterSortRanked(entries, query, (e) => e.relPath, { limit: RESULT_LIMIT })
  }, [index, query])

  const openMatches = useMemo(() => {
    if (!query.trim()) return openPaths.slice(0, 10).map((relPath) => ({ relPath, positions: [] }))
    const q = query.trim()
    return fuzzyFilterSortRanked(
      openPaths.map((relPath) => ({ relPath })),
      q,
      (e) => e.relPath,
      { limit: 5 }
    ).map((r) => ({ relPath: r.item.relPath, positions: r.positions }))
  }, [openPaths, query])

  const pick = (relPath: string) => {
    onOpenChange(false)
    onOpenFile(relPath)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogHeader className="sr-only">
        <DialogTitle>{t("quickOpen.title")}</DialogTitle>
        <DialogDescription>{t("quickOpen.description")}</DialogDescription>
      </DialogHeader>
      <DialogContent
        className="top-[20%] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-xl"
        showCloseButton={false}
        data-testid="project-quick-open"
      >
        {/* `shouldFilter={false}`: items arrive pre-ranked by fuzzyFilterSortRanked
            with their match positions; cmdk's own filter would undo that order. */}
        <Command shouldFilter={false} loop>
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder={t("quickOpen.placeholder")}
            aria-label={t("quickOpen.placeholder")}
          />
          <CommandList className="max-h-80">
            <CommandEmpty>
              {index === null ? (
                <span className="text-muted-foreground">{t("quickOpen.indexing")}</span>
              ) : (
                <span className="text-muted-foreground">{t("quickOpen.empty")}</span>
              )}
            </CommandEmpty>
            {openMatches.length > 0 ? (
              <CommandGroup heading={t("quickOpen.openEditors")}>
                {openMatches.map((match) => (
                  <QuickOpenRow
                    key={`open:${match.relPath}`}
                    relPath={match.relPath}
                    positions={match.positions}
                    valuePrefix="open"
                    onPick={pick}
                  />
                ))}
              </CommandGroup>
            ) : null}
            <CommandGroup heading={openMatches.length > 0 ? t("quickOpen.allFiles") : undefined}>
              {ranked.map(({ item, positions }) => (
                <QuickOpenRow
                  key={item.relPath}
                  relPath={item.relPath}
                  positions={positions}
                  onPick={pick}
                />
              ))}
            </CommandGroup>
          </CommandList>
          <div className="flex items-center gap-2 border-t px-3 py-1.5 text-[11px] text-muted-foreground">
            <FolderSearchIcon className="size-3" />
            {index === null ? (
              <span>{t("quickOpen.indexing")}</span>
            ) : index.truncated ? (
              <span>{t("quickOpen.truncated", { count: index.entries.length })}</span>
            ) : (
              <span>{t("quickOpen.indexed", { count: index.entries.length })}</span>
            )}
            {refreshing && index !== null ? <span>{t("quickOpen.refreshing")}</span> : null}
            {/* Pointer users learn the chord from the footer; on touch layouts
                there are no arrows to press, so the hint stays hidden. */}
            <span className="ml-auto hidden text-muted-foreground/80 sm:block">
              {t("quickOpen.footer")}
            </span>
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  )
}

function QuickOpenRow({
  relPath,
  positions,
  valuePrefix = "file",
  onPick,
}: {
  relPath: string
  positions: number[]
  /** Distinguishes the same path listed in two groups (open editors + all files). */
  valuePrefix?: string
  onPick: (relPath: string) => void
}) {
  const name = relPath.split("/").pop() ?? relPath
  const dir = relPath.slice(0, relPath.length - name.length).replace(/\/$/, "")
  const hit = new Set(positions)
  return (
    <CommandItem
      value={`${valuePrefix}:${relPath}`}
      onSelect={() => onPick(relPath)}
      data-testid={`quick-open-${relPath}`}
    >
      <FileTypeIcon path={name} />
      <span className="min-w-0 flex-1 truncate">
        <Highlighted text={name} offset={relPath.length - name.length} hit={hit} />
        {dir ? (
          <span className="ml-1.5 text-xs text-muted-foreground">
            <Highlighted text={dir} offset={0} hit={hit} />
          </span>
        ) : null}
      </span>
    </CommandItem>
  )
}

/** Paint the query's matched characters inside one path segment. */
function Highlighted({ text, offset, hit }: { text: string; offset: number; hit: Set<number> }) {
  return (
    <>
      {[...text].map((ch, i) =>
        hit.has(offset + i) ? (
          <span key={i} className="font-semibold text-foreground">
            {ch}
          </span>
        ) : (
          <span key={i}>{ch}</span>
        )
      )}
    </>
  )
}
