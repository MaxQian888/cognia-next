"use client"

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { BracesIcon } from "lucide-react"
import { parseCanvasSymbols } from "@/components/canvas/canvas-outline-panel"
import type { EditorLanguage } from "@/components/editor/editor-language"
import type { DocumentSymbol } from "@/types/canvas/symbols"
import { PROJECT_EDITOR_GOTO_EVENT } from "./editor-events"

function OutlineRow({
  symbol,
  relPath,
  depth,
}: {
  symbol: DocumentSymbol
  relPath: string
  depth: number
}) {
  return (
    <>
      <button
        type="button"
        role="treeitem"
        aria-selected={false}
        className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs hover:bg-muted/50"
        style={{ paddingLeft: depth * 12 + 6 }}
        onClick={() =>
          window.dispatchEvent(
            new CustomEvent(PROJECT_EDITOR_GOTO_EVENT, {
              detail: { relPath, line: symbol.selectionRange.startLine, column: 1 },
            })
          )
        }
      >
        <BracesIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">{symbol.name}</span>
      </button>
      {symbol.children?.map((child, index) => (
        <OutlineRow
          key={`${child.name}-${index}`}
          symbol={child}
          relPath={relPath}
          depth={depth + 1}
        />
      ))}
    </>
  )
}

export function ProjectFileOutlinePanel({
  relPath,
  language,
  content,
}: {
  relPath: string
  language: EditorLanguage
  content: string
}) {
  const t = useTranslations("projectEditor.workbench")
  const symbols = useMemo(() => parseCanvasSymbols({ language, content }), [content, language])
  if (symbols.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-xs text-muted-foreground">
        {t("outlineEmpty")}
      </div>
    )
  }
  return (
    <div role="tree" aria-label={t("outline")} className="h-full overflow-auto p-2">
      {symbols.map((symbol, index) => (
        <OutlineRow key={`${symbol.name}-${index}`} symbol={symbol} relPath={relPath} depth={0} />
      ))}
    </div>
  )
}
