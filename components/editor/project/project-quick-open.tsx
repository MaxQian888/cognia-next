"use client"

// ⌘P / Ctrl+P quick-open: fuzzy file picker over a lazily-built workspace
// index. The index comes from `walkWorkspace` (gitignore-aware, capped) and
// refreshes stale-while-revalidate every time the palette opens, so a file
// created while it was closed still shows. Ranking reuses the composer's
// `fuzzyFilterSortRanked` so every picker in the app scores identically; the
// returned match positions paint the matched characters.

import { useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import {
  FolderSearchIcon,
  SquareFunctionIcon,
  TerminalIcon,
  TextCursorInputIcon,
} from "lucide-react"
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
import { parseCanvasSymbols, SymbolKindIcon } from "@/components/canvas/canvas-outline-panel"
import type { DocumentSymbol, SymbolKind } from "@/types/canvas/symbols"

export interface ProjectQuickOpenDeps {
  walk: typeof walkWorkspace
}

/** Cap for the walk — comfortably above a normal repo's tracked-file count. */
const INDEX_MAX_ENTRIES = 20_000
/** Rows offered to cmdk per query — beyond this the picker scrolls badly. */
const RESULT_LIMIT = 60

/** `@:` group headers follow the SymbolKind order VS Code's outline uses. */
const SYMBOL_GROUP_ORDER: SymbolKind[] = [
  "namespace",
  "module",
  "class",
  "interface",
  "struct",
  "enum",
  "enumMember",
  "typeParameter",
  "constructor",
  "method",
  "property",
  "field",
  "function",
  "variable",
  "constant",
  "event",
  "operator",
  "string",
  "number",
  "boolean",
  "array",
  "object",
  "key",
  "null",
  "file",
  "package",
]

/**
 * A workbench command surfaced through `>` mode, the way VS Code folds its
 * command palette into quick open. `hint` renders right-aligned — keybinding
 * glyphs conventionally.
 */
export interface QuickOpenCommand {
  id: string
  label: string
  hint?: string
  run: () => void
}

/**
 * Split a quick-open query into VS Code's modes:
 *   ">text"   — command palette
 *   "@name"   — go to symbol in the active editor
 *   "@:name"  — same, grouped by symbol kind
 *   ":12[:3]" — go to line (column) in the active editor
 *   "foo:12"  — open file, then go to line
 * The `@` modes must run before the `:N` suffix check — `@:name` would
 * otherwise split on its own colon. The `:N` suffix must be all digits or
 * it stays part of the file query, so a path containing a colon still
 * searches correctly.
 */
function parseQuickQuery(query: string): {
  command: boolean
  fileQuery: string
  line?: number
  column?: number
  /** The bare `:` family — no file part at all. */
  gotoOnly: boolean
  /** The `@` family — symbol search inside the active document. */
  symbolMode: boolean
  /** `@:` — symbols grouped under kind headings. */
  symbolGrouped: boolean
  symbolQuery: string
} {
  const base = {
    line: undefined as number | undefined,
    column: undefined as number | undefined,
    symbolMode: false,
    symbolGrouped: false,
    symbolQuery: "",
  }
  if (query.startsWith(">"))
    return { ...base, command: true, fileQuery: query.slice(1), gotoOnly: false }
  if (query.startsWith("@:"))
    return {
      ...base,
      command: false,
      fileQuery: "",
      gotoOnly: false,
      symbolMode: true,
      symbolGrouped: true,
      symbolQuery: query.slice(2),
    }
  if (query.startsWith("@"))
    return {
      ...base,
      command: false,
      fileQuery: "",
      gotoOnly: false,
      symbolMode: true,
      symbolQuery: query.slice(1),
    }
  const m = /^(.*?):(\d+)(?::(\d+))?$/.exec(query)
  if (m) {
    return {
      ...base,
      command: false,
      fileQuery: m[1],
      line: Number.parseInt(m[2], 10),
      column: m[3] ? Number.parseInt(m[3], 10) : undefined,
      gotoOnly: m[1] === "",
    }
  }
  return { ...base, command: false, fileQuery: query, gotoOnly: query.startsWith(":") }
}

interface Props {
  rootPath: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Open a file — pinned, the way a deliberate picker result always means. */
  onOpenFile: (relPath: string) => void
  /** Jump the active editor — or a just-picked file — to a position. */
  onGoToLine?: (relPath: string | null, line: number, column?: number) => void
  /** Commands listed in `>` mode (⌘⇧P seeds the query with `>`). */
  commands?: QuickOpenCommand[]
  /**
   * Text pushed into the input by the host — `{ text: ">" }` from ⌘⇧P. A new
   * object identity re-applies even when the text repeats.
   */
  seedQuery?: { text: string } | null
  /** Currently open relPaths, used for the "open editors" recency group. */
  openPaths?: string[]
  /**
   * The focused editor's live document — `@` symbol mode searches its
   * draft buffer (same parse the outline panel runs), never disk.
   */
  activeDocument?: { relPath: string; language: string; content: string } | null
  deps?: Partial<ProjectQuickOpenDeps>
}

export function ProjectQuickOpen({
  rootPath,
  open,
  onOpenChange,
  onOpenFile,
  onGoToLine,
  commands,
  seedQuery,
  openPaths = [],
  activeDocument,
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
  // Last seed object consumed — a fresh `{text}` re-applies mid-session, so
  // ⌘⇧P pressed while the palette is open still snaps back to `>` mode.
  const [appliedSeed, setAppliedSeed] = useState<typeof seedQuery>(null)

  // Reset on the closed→open transition during render — the sanctioned
  // alternative to syncing state inside the walk effect below.
  const [prevOpen, setPrevOpen] = useState(open)
  if (open !== prevOpen) {
    setPrevOpen(open)
    if (open) {
      setAppliedSeed(seedQuery ?? null)
      setQuery(seedQuery?.text ?? "")
      setRefreshing(true)
    }
  }
  if (open && seedQuery && seedQuery !== appliedSeed) {
    setAppliedSeed(seedQuery)
    setQuery(seedQuery.text)
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

  const parsed = useMemo(() => parseQuickQuery(query), [query])
  const {
    command: commandMode,
    fileQuery,
    line,
    column,
    gotoOnly,
    symbolMode,
    symbolGrouped,
    symbolQuery,
  } = parsed

  const ranked = useMemo(() => {
    const entries = index?.entries ?? []
    return fuzzyFilterSortRanked(entries, fileQuery, (e) => e.relPath, { limit: RESULT_LIMIT })
  }, [index, fileQuery])

  const openMatches = useMemo(() => {
    if (!fileQuery.trim())
      return openPaths.slice(0, 10).map((relPath) => ({ relPath, positions: [] }))
    const q = fileQuery.trim()
    return fuzzyFilterSortRanked(
      openPaths.map((relPath) => ({ relPath })),
      q,
      (e) => e.relPath,
      { limit: 5 }
    ).map((r) => ({ relPath: r.item.relPath, positions: r.positions }))
  }, [openPaths, fileQuery])

  const rankedCommands = useMemo(() => {
    if (!commandMode) return []
    const list = commands ?? []
    const q = fileQuery.trim()
    if (!q) return list.slice(0, RESULT_LIMIT).map((item) => ({ item, positions: [] }))
    return fuzzyFilterSortRanked(list, q, (c) => c.label, { limit: RESULT_LIMIT })
  }, [commandMode, commands, fileQuery])

  // `@` mode — the active document's outline flattened in document order,
  // from the same parser the outline tab runs on the live draft buffer.
  const flatSymbols = useMemo(() => {
    if (!symbolMode || !activeDocument) return []
    const flat: { symbol: DocumentSymbol; depth: number }[] = []
    // The regex parser can emit a symbol twice when an earlier pattern's
    // range swallows a later declaration (a `const` eating the class below
    // it) — dedupe by identity so rows never repeat.
    const seen = new Set<string>()
    const walkSymbols = (list: DocumentSymbol[], depth: number) => {
      for (const symbol of list) {
        const key = `${symbol.kind}:${symbol.name}:${symbol.selectionRange.startLine}`
        if (!seen.has(key)) {
          seen.add(key)
          flat.push({ symbol, depth })
        }
        if (symbol.children?.length) walkSymbols(symbol.children, depth + 1)
      }
    }
    walkSymbols(
      parseCanvasSymbols({
        content: activeDocument.content,
        language: activeDocument.language,
      }),
      0
    )
    return flat
  }, [symbolMode, activeDocument])

  const rankedSymbols = useMemo(() => {
    if (!symbolMode) return []
    const q = symbolQuery.trim()
    if (!q) return flatSymbols.map((item) => ({ item, positions: [] as number[] }))
    return fuzzyFilterSortRanked(flatSymbols, q, (e) => e.symbol.name, {
      limit: RESULT_LIMIT,
    })
  }, [symbolMode, symbolQuery, flatSymbols])

  // `@:` — same list bucketed by kind, headers following the SymbolKind
  // order VS Code's outline groups use.
  const groupedSymbols = useMemo(() => {
    if (!symbolGrouped) return []
    const byKind = new Map<
      SymbolKind,
      { symbol: DocumentSymbol; depth: number; positions: number[] }[]
    >()
    for (const entry of rankedSymbols) {
      const list = byKind.get(entry.item.symbol.kind) ?? []
      list.push({ ...entry.item, positions: entry.positions })
      byKind.set(entry.item.symbol.kind, list)
    }
    return SYMBOL_GROUP_ORDER.filter((kind) => byKind.has(kind)).map((kind) => ({
      kind,
      entries: byKind.get(kind)!,
    }))
  }, [symbolGrouped, rankedSymbols])

  const pick = (relPath: string) => {
    onOpenChange(false)
    // A `file:line` pick rides the goto path (which opens the file itself) so
    // the reveal lands in one shot; a plain pick stays a plain open.
    if (line !== undefined && onGoToLine) onGoToLine(relPath, line, column)
    else onOpenFile(relPath)
  }

  const runCommand = (command: QuickOpenCommand) => {
    onOpenChange(false)
    command.run()
  }

  const gotoActive = () => {
    if (line === undefined) return
    onOpenChange(false)
    onGoToLine?.(null, line, column)
  }

  /** Symbol rows always target the active editor — `@` never opens a file. */
  const pickSymbol = (symbol: DocumentSymbol) => {
    onOpenChange(false)
    onGoToLine?.(null, symbol.selectionRange.startLine, 1)
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
          <CommandList className="workbench-scroll max-h-80">
            {symbolMode ? (
              <>
                <CommandEmpty>
                  <span className="text-muted-foreground">
                    {activeDocument ? t("quickOpen.noSymbols") : t("quickOpen.noActiveDoc")}
                  </span>
                </CommandEmpty>
                {symbolGrouped ? (
                  groupedSymbols.map((group) => (
                    <CommandGroup key={group.kind} heading={symbolKindLabel(group.kind, t)}>
                      {group.entries.map((entry) => (
                        <SymbolRow
                          key={`${group.kind}:${entry.symbol.name}:${entry.symbol.selectionRange.startLine}`}
                          symbol={entry.symbol}
                          depth={entry.depth}
                          positions={entry.positions}
                          onPick={pickSymbol}
                        />
                      ))}
                    </CommandGroup>
                  ))
                ) : (
                  <CommandGroup heading={t("quickOpen.symbols")}>
                    {rankedSymbols.map((entry) => (
                      <SymbolRow
                        key={`${entry.item.symbol.name}:${entry.item.symbol.selectionRange.startLine}`}
                        symbol={entry.item.symbol}
                        depth={entry.item.depth}
                        positions={entry.positions}
                        onPick={pickSymbol}
                      />
                    ))}
                  </CommandGroup>
                )}
              </>
            ) : commandMode ? (
              <>
                <CommandEmpty>
                  <span className="text-muted-foreground">{t("quickOpen.noCommands")}</span>
                </CommandEmpty>
                <CommandGroup heading={t("quickOpen.commands")}>
                  {rankedCommands.map(({ item, positions }) => (
                    <CommandItem
                      key={item.id}
                      value={`cmd:${item.id}`}
                      onSelect={() => runCommand(item)}
                      data-testid={`quick-open-cmd-${item.id}`}
                    >
                      <TerminalIcon className="size-3.5 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">
                        <Highlighted text={item.label} offset={0} hit={new Set(positions)} />
                      </span>
                      {item.hint ? (
                        <span className="ml-2 text-xs text-muted-foreground/80">{item.hint}</span>
                      ) : null}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            ) : gotoOnly ? (
              <>
                <CommandEmpty>
                  <span className="text-muted-foreground">{t("quickOpen.gotoLineHint")}</span>
                </CommandEmpty>
                {line !== undefined ? (
                  <CommandGroup>
                    <CommandItem
                      value="goto"
                      onSelect={gotoActive}
                      data-testid="quick-open-goto-line"
                    >
                      <TextCursorInputIcon className="size-3.5 text-muted-foreground" />
                      {column !== undefined
                        ? t("quickOpen.gotoLineColumn", { line, column })
                        : t("quickOpen.gotoLine", { line })}
                    </CommandItem>
                  </CommandGroup>
                ) : null}
              </>
            ) : (
              <>
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
                <CommandGroup
                  heading={openMatches.length > 0 ? t("quickOpen.allFiles") : undefined}
                >
                  {ranked.map(({ item, positions }) => (
                    <QuickOpenRow
                      key={item.relPath}
                      relPath={item.relPath}
                      positions={positions}
                      onPick={pick}
                    />
                  ))}
                </CommandGroup>
              </>
            )}
          </CommandList>
          <div className="flex items-center gap-2 border-t px-3 py-1.5 text-[11px] text-muted-foreground">
            {symbolMode ? (
              <>
                <SquareFunctionIcon className="size-3" />
                <span>
                  {activeDocument
                    ? t("quickOpen.footerSymbols", { file: activeDocument.relPath })
                    : t("quickOpen.noActiveDocHint")}
                </span>
              </>
            ) : commandMode || gotoOnly ? (
              <>
                <TerminalIcon className="size-3" />
                <span>
                  {commandMode ? t("quickOpen.footerCommands") : t("quickOpen.footerGoto")}
                </span>
              </>
            ) : (
              <>
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
              </>
            )}
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  )
}

/** `@` row: kind glyph, name, container, and the target line on the right. */
function SymbolRow({
  symbol,
  depth,
  positions,
  onPick,
}: {
  symbol: DocumentSymbol
  depth: number
  positions: number[]
  onPick: (symbol: DocumentSymbol) => void
}) {
  return (
    <CommandItem
      value={`symbol:${symbol.name}:${symbol.selectionRange.startLine}`}
      onSelect={() => onPick(symbol)}
      data-testid={`quick-open-symbol-${symbol.name}`}
    >
      <span
        className="flex min-w-0 flex-1 items-center gap-1.5"
        style={{ paddingLeft: depth * 12 }}
      >
        <SymbolKindIcon kind={symbol.kind} />
        <span className="min-w-0 flex-1 truncate">
          <Highlighted text={symbol.name} offset={0} hit={new Set(positions)} />
        </span>
        {symbol.containerName || symbol.detail ? (
          <span className="truncate text-xs text-muted-foreground">
            {symbol.containerName ?? symbol.detail}
          </span>
        ) : null}
      </span>
      <span className="ml-2 shrink-0 text-xs text-muted-foreground/80">
        :{symbol.selectionRange.startLine}
      </span>
    </CommandItem>
  )
}

/** `@:` group heading — every SymbolKind is covered, not just parser output. */
function symbolKindLabel(kind: SymbolKind, t: (key: string) => string): string {
  switch (kind) {
    case "class":
      return t("quickOpen.symbolKind.class")
    case "method":
      return t("quickOpen.symbolKind.method")
    case "property":
      return t("quickOpen.symbolKind.property")
    case "field":
      return t("quickOpen.symbolKind.field")
    case "constructor":
      return t("quickOpen.symbolKind.constructor")
    case "enum":
      return t("quickOpen.symbolKind.enum")
    case "interface":
      return t("quickOpen.symbolKind.interface")
    case "function":
      return t("quickOpen.symbolKind.function")
    case "variable":
      return t("quickOpen.symbolKind.variable")
    case "constant":
      return t("quickOpen.symbolKind.constant")
    case "enumMember":
      return t("quickOpen.symbolKind.enumMember")
    case "struct":
      return t("quickOpen.symbolKind.struct")
    case "namespace":
      return t("quickOpen.symbolKind.namespace")
    case "module":
      return t("quickOpen.symbolKind.module")
    case "package":
      return t("quickOpen.symbolKind.package")
    case "typeParameter":
      return t("quickOpen.symbolKind.typeParameter")
    case "event":
      return t("quickOpen.symbolKind.event")
    case "operator":
      return t("quickOpen.symbolKind.operator")
    case "file":
      return t("quickOpen.symbolKind.file")
    case "string":
      return t("quickOpen.symbolKind.string")
    case "number":
      return t("quickOpen.symbolKind.number")
    case "boolean":
      return t("quickOpen.symbolKind.boolean")
    case "array":
      return t("quickOpen.symbolKind.array")
    case "object":
      return t("quickOpen.symbolKind.object")
    case "key":
      return t("quickOpen.symbolKind.key")
    case "null":
      return t("quickOpen.symbolKind.null")
  }
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
