"use client"

/**
 * LineDiffView — a lightweight, virtualized line diff.
 *
 * The one non-Monaco diff surface: the phone review of an artifact, canvas or
 * git change, the version-history comparison, the git hunk view a diff falls
 * back to when it is too large for Monaco, an agent's `apply_patch` and a
 * ```diff block in a message. Each used to map every line of the diff into the
 * DOM, and the chat ones each parsed and drew diffs their own way.
 *
 * - Rows are virtualized (`@tanstack/react-virtual`), so DOM cost is bounded by
 *   the viewport, not the file.
 * - Unchanged runs fold to `context` lines around each change behind an
 *   "N unchanged lines" row that expands in place.
 * - `layout="split"` pairs each removal with the addition that replaced it,
 *   side by side; split rows always wrap, since two half-width columns cannot
 *   share one horizontal scroll.
 * - A removed line and its replacement emphasise the characters that changed,
 *   computed only for the rows on screen.
 * - Find (Ctrl/⌘+F inside the view, or `openFind()` from a host button)
 *   searches every line, folded ones included, and unfolds the gap a hit is in.
 * - No-wrap mode keeps a fixed row height and sizes the scroll width from the
 *   longest line, so the horizontal scrollbar does not jump as rows recycle;
 *   the gutter stays pinned while the code scrolls sideways. Wrap mode measures
 *   each rendered row instead.
 */

import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type Ref,
} from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { ChevronDownIcon, ChevronsUpDownIcon, ChevronUpIcon, SearchIcon, XIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import type { DiffLine } from "@/types"
import { collapseDiffContext, diffIndexForLine, type DiffRow } from "@/lib/artifacts/diff"
import {
  findMatches,
  intralineRanges,
  pairChangedLines,
  paintRuns,
  toSplitRows,
  MAX_FIND_MATCHES,
  type DiffEntry,
  type SplitRow,
} from "@/lib/artifacts/diff-view-model"
import { cn } from "@/lib/utils"

/** `text-xs` at `leading-5`. */
export const LINE_DIFF_ROW_HEIGHT = 20

/**
 * Characters of one line drawn before the rest is summarised — Monaco's
 * `stopRenderingLineAfter` default. A minified bundle is one line of
 * megabytes; laying that out (worse, wrapped) stalls the pane for a line
 * nobody reads character by character. Find still searches the whole line.
 */
export const MAX_RENDERED_LINE_CHARS = 10_000
const TAB_WIDTH = 4

/** Status tokens, not raw hues, like every other diff surface (ADR-0218). */
const TINT: Record<DiffLine["type"], string> = {
  added: "bg-success/10 text-success",
  removed: "bg-destructive/10 text-destructive",
  unchanged: "",
}

/** Word-level emphasis inside a tinted line. */
const EMPHASIS: Record<DiffLine["type"], string> = {
  added: "bg-success/25",
  removed: "bg-destructive/20",
  unchanged: "",
}

const SIGN: Record<DiffLine["type"], string> = { added: "+", removed: "-", unchanged: " " }

/**
 * Visual width of a line in `ch`: tabs at {@link TAB_WIDTH}, East Asian wide
 * characters as two cells. Close enough for a monospace scroll extent; the
 * row itself still renders the real text.
 */
export function visualWidth(text: string): number {
  let width = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code === 9) width += TAB_WIDTH - (width % TAB_WIDTH)
    else if (code >= 0x1100 && (code <= 0x115f || (code >= 0x2e80 && code <= 0xffdc))) width += 2
    else width += 1
  }
  return width
}

/** Imperative handle: scroll a line into view (unfolding it), or open find. */
export interface LineDiffViewHandle {
  revealLine: (target: { side: "old" | "new"; line: number }) => void
  openFind: () => void
}

/** How long a revealed line keeps its highlight ring. */
const REVEAL_HIGHLIGHT_MS = 1200

export interface LineDiffViewProps {
  ref?: Ref<LineDiffViewHandle>
  /** A full line diff (`computeDiff`); folded around changes per `context`. */
  lines?: DiffLine[]
  /**
   * Pre-built rows, rendered as given (no folding) — e.g. git hunks, whose
   * between-hunk lines were never loaded. Takes precedence over `lines`.
   */
  rows?: DiffRow[]
  /** Unchanged lines kept on each side of a change; `null` shows every line. */
  context?: number | null
  /** Soft-wrap long lines instead of scrolling sideways. */
  wrap?: boolean
  /** One column of interleaved lines, or the two sides next to each other. */
  layout?: "unified" | "split"
  /**
   * Size to the content up to this many pixels instead of filling the parent
   * — for a diff embedded in a list, where a fixed box would leave a short
   * diff floating in empty space.
   */
  maxHeight?: number
  /**
   * Make each line's gutter a button that opens the file at that line (the
   * new-side number, or the old-side one for a removed line).
   */
  onOpenLine?: (line: DiffLine) => void
  /** Touch sizes the find bar's controls for a finger. */
  density?: "compact" | "touch"
  className?: string
  "aria-label"?: string
  "data-testid"?: string
}

export const LineDiffView = memo(function LineDiffView({
  ref,
  lines,
  rows: givenRows,
  context = 3,
  wrap = false,
  layout = "unified",
  maxHeight,
  onOpenLine,
  density = "compact",
  className,
  "aria-label": ariaLabel,
  "data-testid": testId = "line-diff-view",
}: LineDiffViewProps) {
  const t = useTranslations("diffView")
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const findInputRef = useRef<HTMLInputElement | null>(null)
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set())
  const split = layout === "split"
  // Two half-width columns cannot scroll sideways together.
  const wraps = wrap || split

  const rows = useMemo<DiffRow[]>(() => {
    if (givenRows) return givenRows
    const source = lines ?? []
    if (context === null) return source.map((line, index) => ({ kind: "line", line, index }))
    return collapseDiffContext(source, context, expanded)
  }, [givenRows, lines, context, expanded])

  const viewRows = useMemo<(DiffRow | SplitRow)[]>(
    () => (split ? toSplitRows(rows) : rows),
    [split, rows]
  )

  // Every line of the diff, folded or not: find and word emphasis need both
  // sides of a change even while one of them is scrolled away.
  const source = useMemo<DiffEntry[]>(() => {
    if (givenRows) {
      const out: DiffEntry[] = []
      for (const row of givenRows) if (row.kind === "line") out.push(row)
      return out
    }
    return (lines ?? []).map((line, index) => ({ line, index }))
  }, [givenRows, lines])
  const partners = useMemo(() => pairChangedLines(source), [source])

  // Source index → the rendered row that shows it (either side of a pair).
  const rowOfSource = useMemo(() => {
    const map = new Map<number, number>()
    viewRows.forEach((row, rowIndex) => {
      if (row.kind === "line") map.set(row.index, rowIndex)
      else if (row.kind === "pair") {
        if (row.left) map.set(row.left.index, rowIndex)
        if (row.right) map.set(row.right.index, rowIndex)
      }
    })
    return map
  }, [viewRows])

  // Gutter digits from the largest line number either side shows.
  // A diff with no line numbers anywhere (a snippet edit, a pasted bare
  // diff) gets a sign-only gutter rather than two empty number columns.
  const { digits, maxWidth, numbered } = useMemo(() => {
    let maxNum = 0
    let widest = 0
    for (const row of rows) {
      if (row.kind === "line") {
        maxNum = Math.max(maxNum, row.line.oldLineNum ?? 0, row.line.newLineNum ?? 0)
        if (!wraps) {
          widest = Math.max(widest, visualWidth(row.line.content.slice(0, MAX_RENDERED_LINE_CHARS)))
        }
      } else if (row.kind === "header" && !wraps) {
        widest = Math.max(widest, visualWidth(row.text))
      }
    }
    return { digits: Math.max(2, String(maxNum).length), maxWidth: widest, numbered: maxNum > 0 }
  }, [rows, wraps])

  const virtualizer = useVirtualizer({
    count: viewRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => LINE_DIFF_ROW_HEIGHT,
    overscan: 24,
    getItemKey: (index) => {
      const row = viewRows[index]
      if (!row) return index
      if (row.kind === "line") return `l${row.index}`
      if (row.kind === "pair") return `p${row.left?.index ?? "-"}:${row.right?.index ?? "-"}`
      if (row.kind === "gap") return `g${row.start}`
      return `h${row.key}`
    },
  })

  const expand = useCallback((start: number) => {
    setExpanded((prev) => new Set(prev).add(start))
  }, [])

  // A reveal into a folded gap unfolds it first; the scroll then waits for the
  // rows that contain the line.
  const pendingReveal = useRef<{ index: number; ring: boolean } | null>(null)
  const [highlighted, setHighlighted] = useState<number | null>(null)
  const scrollToSourceIndex = useCallback(
    (sourceIndex: number, ring: boolean) => {
      const rowIndex = rowOfSource.get(sourceIndex)
      if (rowIndex === undefined) return false
      virtualizer.scrollToIndex(rowIndex, { align: "center" })
      if (ring) setHighlighted(sourceIndex)
      return true
    },
    [rowOfSource, virtualizer]
  )

  /** Show source line `sourceIndex`, unfolding its gap when it is hidden. */
  const revealSource = useCallback(
    (sourceIndex: number, ring: boolean) => {
      if (scrollToSourceIndex(sourceIndex, ring)) return
      const gap = rows.find(
        (r) => r.kind === "gap" && sourceIndex >= r.start && sourceIndex < r.start + r.count
      )
      if (gap && gap.kind === "gap") {
        pendingReveal.current = { index: sourceIndex, ring }
        expand(gap.start)
      }
    },
    [rows, expand, scrollToSourceIndex]
  )

  useEffect(() => {
    const pending = pendingReveal.current
    if (pending === null) return
    if (scrollToSourceIndex(pending.index, pending.ring)) pendingReveal.current = null
  }, [rowOfSource, scrollToSourceIndex])

  useEffect(() => {
    if (highlighted === null) return
    const timer = setTimeout(() => setHighlighted(null), REVEAL_HIGHLIGHT_MS)
    return () => clearTimeout(timer)
  }, [highlighted])

  // ── Find ────────────────────────────────────────────────────────────────
  const [findOpen, setFindOpen] = useState(false)
  const [query, setQuery] = useState("")
  const deferredQuery = useDeferredValue(query)
  // Lower-cased once per diff, and only once find has been opened.
  const lowered = useMemo(
    () => (findOpen ? source.map((entry) => entry.line.content.toLowerCase()) : []),
    [findOpen, source]
  )
  const { matches, capped } = useMemo(
    () =>
      findOpen && deferredQuery
        ? findMatches(source, lowered, deferredQuery)
        : { matches: [], capped: false },
    [findOpen, deferredQuery, source, lowered]
  )
  const [cursor, setCursor] = useState(0)
  const [cursorFor, setCursorFor] = useState(matches)
  if (cursorFor !== matches) {
    setCursorFor(matches)
    setCursor(0)
  }
  const currentMatch = matches.length > 0 ? matches[Math.min(cursor, matches.length - 1)] : null
  const hitsByIndex = useMemo(() => {
    const map = new Map<number, number[]>()
    for (const m of matches) {
      const list = map.get(m.index)
      if (list) list.push(m.start)
      else map.set(m.index, [m.start])
    }
    return map
  }, [matches])

  // Follow the current hit: a new query lands on its first hit, Enter on the
  // next. Folded hits unfold their gap.
  useEffect(() => {
    if (currentMatch) revealSource(currentMatch.index, false)
    // `revealSource` changes with every unfold; following it would re-scroll
    // to the current hit each time the reader expands an unrelated gap.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentMatch])

  // Every open (Ctrl/⌘+F again included) focuses the input and selects its
  // text, once the bar has mounted.
  const [findFocus, setFindFocus] = useState(0)
  useEffect(() => {
    if (findFocus === 0) return
    findInputRef.current?.focus()
    findInputRef.current?.select()
  }, [findFocus])
  const openFind = useCallback(() => {
    setFindOpen(true)
    setFindFocus((n) => n + 1)
  }, [])
  const closeFind = useCallback(() => {
    setFindOpen(false)
    setQuery("")
    scrollRef.current?.focus()
  }, [])
  const stepMatch = useCallback(
    (delta: 1 | -1) => {
      if (matches.length === 0) return
      setCursor((c) => (c + delta + matches.length) % matches.length)
    },
    [matches.length]
  )

  useImperativeHandle(
    ref,
    () => ({
      revealLine: ({ side, line }) => {
        const key = side === "old" ? "oldLineNum" : "newLineNum"
        let sourceIndex = -1
        if (givenRows) {
          // Rows as given: the first line at or past the target on that side.
          const hit = givenRows.find((r) => r.kind === "line" && (r.line[key] ?? -Infinity) >= line)
          sourceIndex = hit && hit.kind === "line" ? hit.index : -1
        } else if (lines) {
          sourceIndex = diffIndexForLine(lines, side, line)
        }
        if (sourceIndex !== -1) revealSource(sourceIndex, true)
      },
      openFind,
    }),
    [givenRows, lines, revealSource, openFind]
  )

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "f") {
        event.preventDefault()
        event.stopPropagation()
        openFind()
        return
      }
      if (findOpen && event.key === "F3") {
        event.preventDefault()
        stepMatch(event.shiftKey ? -1 : 1)
      }
    },
    [findOpen, openFind, stepMatch]
  )

  // number columns + sign + padding, in ch
  const gutterCh = numbered ? digits * 2 + 3 : 3
  const contentMinWidth = wraps ? undefined : `calc(${gutterCh + maxWidth}ch + 1.5rem)`
  const hitLength = deferredQuery.length
  const touch = density === "touch"
  const findButton = cn(
    "inline-flex shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40",
    touch ? "size-11" : "size-6"
  )

  const lineProps = (entry: DiffEntry) => {
    const hits = hitsByIndex.get(entry.index)
    return {
      line: entry.line,
      highlighted: highlighted === entry.index,
      partner: partners.get(entry.index),
      hits,
      hitLength,
      currentHit: currentMatch?.index === entry.index ? currentMatch.start : null,
      digits: numbered ? digits : 0,
      onOpenLine,
      openLabel: (n: number) => t("openAtLine", { line: n }),
      clippedLabel: (count: number) => t("clipped", { count }),
      typeLabel:
        entry.line.type === "added"
          ? t("added")
          : entry.line.type === "removed"
            ? t("removed")
            : undefined,
    }
  }

  return (
    <div
      className={cn(
        "relative flex min-h-0 min-w-0 flex-col",
        maxHeight === undefined && "h-full",
        className
      )}
      onKeyDown={onKeyDown}
      data-testid={`${testId}-root`}
    >
      {findOpen ? (
        <div
          role="search"
          className="flex shrink-0 items-center gap-1 border-b bg-muted/40 px-1.5 py-0.5"
          data-testid="line-diff-find"
        >
          <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <input
            ref={findInputRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                stepMatch(e.shiftKey ? -1 : 1)
              } else if (e.key === "Escape") {
                e.preventDefault()
                e.stopPropagation()
                closeFind()
              }
            }}
            placeholder={t("find.placeholder")}
            aria-label={t("find.label")}
            className={cn(
              "min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground",
              touch ? "h-11 text-sm" : "h-6"
            )}
            data-testid="line-diff-find-input"
          />
          <span
            className="shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums"
            aria-live="polite"
            data-testid="line-diff-find-count"
          >
            {deferredQuery
              ? matches.length === 0
                ? t("find.none")
                : t("find.count", {
                    current: Math.min(cursor, matches.length - 1) + 1,
                    total: capped ? `${MAX_FIND_MATCHES}+` : matches.length,
                  })
              : null}
          </span>
          <button
            type="button"
            className={findButton}
            disabled={matches.length === 0}
            onClick={() => stepMatch(-1)}
            aria-label={t("find.prev")}
            title={t("find.prev")}
            data-testid="line-diff-find-prev"
          >
            <ChevronUpIcon className="size-3.5" />
          </button>
          <button
            type="button"
            className={findButton}
            disabled={matches.length === 0}
            onClick={() => stepMatch(1)}
            aria-label={t("find.next")}
            title={t("find.next")}
            data-testid="line-diff-find-next"
          >
            <ChevronDownIcon className="size-3.5" />
          </button>
          <button
            type="button"
            className={findButton}
            onClick={closeFind}
            aria-label={t("find.close")}
            title={t("find.close")}
            data-testid="line-diff-find-close"
          >
            <XIcon className="size-3.5" />
          </button>
        </div>
      ) : null}
      <div
        ref={scrollRef}
        role="region"
        aria-label={ariaLabel ?? t("label")}
        tabIndex={0}
        className={cn(
          "relative min-h-0 overflow-auto font-mono text-xs leading-5 outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
          maxHeight === undefined && "flex-1",
          wraps && "overflow-x-hidden"
        )}
        style={
          maxHeight === undefined
            ? undefined
            : // The +1px keeps a sideways scrollbar from adding a vertical one.
              { height: Math.min(virtualizer.getTotalSize() + 1, maxHeight) }
        }
        data-testid={testId}
        data-wrap={wraps ? "true" : "false"}
        data-layout={layout}
      >
        <div
          className="relative w-full"
          style={{ height: virtualizer.getTotalSize(), minWidth: contentMinWidth }}
        >
          {virtualizer.getVirtualItems().map((item) => {
            const row = viewRows[item.index]
            if (!row) return null
            return (
              <div
                key={item.key}
                ref={wraps ? virtualizer.measureElement : undefined}
                data-index={item.index}
                className="absolute left-0 w-full"
                style={{
                  transform: `translateY(${item.start}px)`,
                  height: wraps ? undefined : LINE_DIFF_ROW_HEIGHT,
                }}
              >
                {row.kind === "gap" ? (
                  <button
                    type="button"
                    className="flex h-5 w-full items-center gap-1.5 bg-muted/40 px-2 text-left text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:bg-muted focus-visible:outline-none"
                    onClick={() => expand(row.start)}
                    data-testid="line-diff-gap"
                  >
                    <ChevronsUpDownIcon className="size-3 shrink-0" />
                    {t("showUnchanged", { count: row.count })}
                  </button>
                ) : row.kind === "header" ? (
                  <div
                    className={cn(
                      "bg-muted/60 px-2 text-[11px] text-muted-foreground",
                      wraps ? "break-all" : "truncate"
                    )}
                    data-testid="line-diff-header"
                  >
                    {row.text}
                  </div>
                ) : row.kind === "pair" ? (
                  <div
                    className="grid grid-cols-2 divide-x divide-border/60"
                    data-testid="line-diff-pair"
                  >
                    {[row.left, row.right].map((entry, side) =>
                      entry ? (
                        <LineRow
                          key={side}
                          {...lineProps(entry)}
                          side={side === 0 ? "old" : "new"}
                          wrap
                        />
                      ) : (
                        <div
                          key={side}
                          className="min-h-5 bg-muted/30"
                          aria-hidden
                          data-testid="line-diff-blank"
                        />
                      )
                    )}
                  </div>
                ) : (
                  <LineRow {...lineProps(row)} wrap={wraps} />
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
})

function LineRow({
  line,
  digits,
  wrap,
  side,
  onOpenLine,
  openLabel,
  typeLabel,
  clippedLabel,
  highlighted,
  partner,
  hits,
  hitLength,
  currentHit,
}: {
  line: DiffLine
  highlighted?: boolean
  /** Gutter number width in ch; 0 hides the numbers. */
  digits: number
  wrap: boolean
  /** One side of a side-by-side pair: that side's number only. */
  side?: "old" | "new"
  onOpenLine?: (line: DiffLine) => void
  openLabel: (line: number) => string
  /** Spoken in place of the visual +/- sign. */
  typeLabel?: string
  /** "N more characters" for a line cut at {@link MAX_RENDERED_LINE_CHARS}. */
  clippedLabel: (count: number) => string
  /** The line this one replaced or was replaced by, for word emphasis. */
  partner?: DiffLine
  /** Find hits in this line (start offsets). */
  hits?: number[]
  hitLength: number
  currentHit: number | null
}) {
  const target = line.newLineNum ?? line.oldLineNum
  const numbers =
    digits === 0 ? null : side ? (
      <span className="text-right" style={{ width: `${digits}ch` }}>
        {(side === "old" ? line.oldLineNum : line.newLineNum) ?? ""}
      </span>
    ) : (
      <>
        <span className="text-right" style={{ width: `${digits}ch` }}>
          {line.oldLineNum ?? ""}
        </span>
        <span className="text-right" style={{ width: `${digits}ch` }}>
          {line.newLineNum ?? ""}
        </span>
      </>
    )
  // Only rows on screen pay for the character diff.
  const changed = useMemo(() => intralineRanges(line, partner), [line, partner])
  const clipped = line.content.length > MAX_RENDERED_LINE_CHARS
  const shown = clipped ? line.content.slice(0, MAX_RENDERED_LINE_CHARS) : line.content
  const runs = useMemo(
    () =>
      changed || (hits && hits.length > 0)
        ? paintRuns(shown, changed, hits, hitLength, currentHit)
        : null,
    [shown, changed, hits, hitLength, currentHit]
  )
  return (
    <div
      className={cn(
        "flex min-h-5 min-w-0",
        TINT[line.type],
        highlighted && "ring-1 ring-inset ring-primary/60"
      )}
      data-testid="line-diff-line"
      data-type={line.type}
      data-side={side}
      data-highlighted={highlighted ? "true" : undefined}
    >
      {/* Opaque so code scrolled sideways passes under it; the tint layer
          inside keeps the row's colour across the gutter. */}
      <div className="sticky left-0 z-[1] shrink-0 self-stretch bg-background">
        <div
          className={cn(
            "flex h-full items-start gap-[1ch] px-1 text-muted-foreground/70",
            TINT[line.type]
          )}
        >
          {onOpenLine && target !== undefined && numbers ? (
            <button
              type="button"
              className="flex gap-[1ch] rounded-sm hover:text-foreground focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              onClick={() => onOpenLine(line)}
              aria-label={openLabel(target)}
              title={openLabel(target)}
              data-testid="line-diff-open"
            >
              {numbers}
            </button>
          ) : (
            numbers
          )}
          <span className="w-[1ch] select-none opacity-60" aria-hidden>
            {SIGN[line.type]}
          </span>
          {typeLabel ? <span className="sr-only">{typeLabel}</span> : null}
        </div>
      </div>
      <span
        className={cn(
          "min-w-0 flex-1 pr-3 [tab-size:4]",
          wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre"
        )}
      >
        {runs
          ? runs.map((run, i) =>
              run.changed || run.match ? (
                <span
                  key={i}
                  className={cn(
                    "rounded-[2px]",
                    run.changed && EMPHASIS[line.type],
                    run.match && "bg-amber-300/60 text-foreground dark:bg-amber-400/40",
                    run.current && "bg-amber-400 text-black outline outline-1 outline-amber-600"
                  )}
                  data-testid={run.match ? "line-diff-hit" : "line-diff-intraline"}
                  data-current={run.current ? "true" : undefined}
                >
                  {run.text}
                </span>
              ) : (
                <span key={i}>{run.text}</span>
              )
            )
          : shown}
        {clipped ? (
          <span
            className="ml-1 rounded-sm bg-muted px-1 text-[10px] text-muted-foreground"
            data-testid="line-diff-clipped"
          >
            {clippedLabel(line.content.length - MAX_RENDERED_LINE_CHARS)}
          </span>
        ) : null}
      </span>
    </div>
  )
}
