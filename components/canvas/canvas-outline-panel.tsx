"use client"

/**
 * Canvas Outline Panel — a code symbol outline for the active document, reusing
 * the existing `symbolParser` (LSP-style outline shared with the Monaco hover /
 * breadcrumb). Clicking a symbol dispatches a `canvas-goto-line` window event
 * that `CanvasPanel` listens for to reveal the line in the editor — the same
 * event-bus convention as `canvas-action` / `canvas-save`.
 *
 * The parser understands JavaScript / TypeScript / Python; other languages show
 * an empty state rather than a misleading outline.
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { Box, Braces, ListTree, Variable } from "lucide-react"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia } from "@/components/ui/empty"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { symbolParser } from "@/lib/canvas/symbols/symbol-parser"
import type { DocumentSymbol, SymbolKind } from "@/types/canvas/symbols"

/** Window event that carries an outline click to the editor. */
export const CANVAS_GOTO_LINE_EVENT = "canvas-goto-line"

export interface CanvasGotoLineDetail {
  line: number
}

/** Canvas language → the `symbolParser`'s supported language, or null. */
const PARSER_LANGUAGE: Record<string, string> = {
  javascript: "javascript",
  jsx: "javascript",
  typescript: "typescript",
  tsx: "typescript",
  python: "python",
}

/** Parse a document's symbols, or `[]` when the language is unsupported. */
export function parseCanvasSymbols(
  doc: { content: string; language: string } | undefined
): DocumentSymbol[] {
  if (!doc) return []
  const lang = PARSER_LANGUAGE[doc.language]
  if (!lang) return []
  return symbolParser.parseSymbols(doc.content, lang)
}

/** Total symbol count (including children) — used for the tab badge. */
export function countCanvasSymbols(symbols: DocumentSymbol[]): number {
  return symbols.reduce((sum, s) => sum + 1 + countCanvasSymbols(s.children ?? []), 0)
}

function SymbolKindIcon({ kind }: { kind: SymbolKind }) {
  const className = "size-3.5 shrink-0 text-muted-foreground"
  switch (kind) {
    case "class":
    case "interface":
    case "struct":
    case "enum":
      return <Box className={className} />
    case "variable":
    case "constant":
    case "field":
    case "property":
      return <Variable className={className} />
    default:
      return <Braces className={className} />
  }
}

function emitGotoLine(line: number) {
  window.dispatchEvent(
    new CustomEvent<CanvasGotoLineDetail>(CANVAS_GOTO_LINE_EVENT, { detail: { line } })
  )
}

function OutlineRow({ symbol, depth }: { symbol: DocumentSymbol; depth: number }) {
  return (
    <>
      <button
        type="button"
        role="treeitem"
        aria-label={symbol.name}
        aria-selected={false}
        aria-expanded={symbol.children && symbol.children.length > 0 ? true : undefined}
        onClick={() => emitGotoLine(symbol.selectionRange.startLine)}
        className={cn(
          "flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs hover:bg-muted/50"
        )}
        style={{ paddingLeft: depth * 12 + 6 }}
      >
        <SymbolKindIcon kind={symbol.kind} />
        <span className="truncate font-medium">{symbol.name}</span>
        {symbol.detail && (
          <span className="truncate text-[10px] text-muted-foreground">{symbol.detail}</span>
        )}
      </button>
      {symbol.children?.map((child, i) => (
        <OutlineRow key={`${child.name}-${i}`} symbol={child} depth={depth + 1} />
      ))}
    </>
  )
}

export function CanvasOutlinePanel({ documentId }: { documentId: string }) {
  const t = useTranslations("canvas.panels")
  const doc = useArtifactStore((s) => s.canvasDocuments[documentId])
  const symbols = useMemo(() => parseCanvasSymbols(doc), [doc])

  if (symbols.length === 0) {
    return (
      <Empty className="h-full border-0">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ListTree />
          </EmptyMedia>
          <EmptyDescription className="text-xs">{t("outlineEmpty")}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  return (
    <ScrollArea className="h-full">
      <div role="tree" aria-label={t("outline")} className="p-2">
        {symbols.map((symbol, i) => (
          <OutlineRow key={`${symbol.name}-${i}`} symbol={symbol} depth={0} />
        ))}
      </div>
    </ScrollArea>
  )
}
