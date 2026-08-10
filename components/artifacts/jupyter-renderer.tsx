"use client"

/**
 * JupyterRenderer - Lightweight `.ipynb` cell + output renderer.
 *
 * cognia-next ships a slimmed-down version of Cognia's notebook renderer:
 * no inline editor, no execute button, no toolbar — just markdown / code
 * cells with their output streams. Edit-in-Canvas covers the editor flow.
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { AlertCircle } from "lucide-react"
import { cn } from "@/lib/utils"
import { ScrollArea } from "@/components/ui/scroll-area"
import { CodeBlock } from "@/components/chat/renderers/code-block"
import { MarkdownRenderer } from "@/components/chat/markdown-renderer"
import { sanitizeHTML } from "@/lib/artifacts/preview-utils"
import { loggers } from "@cognia/logging"
import type { JupyterCell, JupyterNotebook, JupyterOutput } from "@/types"

interface JupyterRendererProps {
  content: string
  className?: string
}

function parseNotebook(content: string): JupyterNotebook | null {
  try {
    const parsed = JSON.parse(content) as JupyterNotebook
    if (Array.isArray(parsed.cells)) {
      return parsed
    }
    return null
  } catch (error) {
    loggers.ui.warn("artifacts.jupyter.parse-failed", {
      error,
      contentSize: content.length,
    })
    return null
  }
}

function flattenSource(source: string | string[]): string {
  return Array.isArray(source) ? source.join("") : source
}

function flattenText(text?: string | string[]): string {
  if (!text) return ""
  return Array.isArray(text) ? text.join("") : text
}

function getOutputDataAsString(data: Record<string, unknown> | undefined, mimeType: string) {
  if (!data) return ""
  const value = data[mimeType]
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value.join("")
  return ""
}

const NOTEBOOK_HTML_CSP =
  "default-src 'none'; img-src data: blob: https:; style-src 'unsafe-inline'; font-src data:; form-action 'none'; base-uri 'none'; frame-src 'none';"

function notebookHtmlSrcDoc(content: string): string {
  const sanitizedContent = sanitizeHTML(content, { wholeDocument: false })
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    '<meta http-equiv="Content-Security-Policy" content="',
    NOTEBOOK_HTML_CSP,
    '"><meta name="viewport" content="width=device-width, initial-scale=1">',
    "<style>:root{color-scheme:light dark}body{margin:0;padding:12px;font:13px/1.5 system-ui,sans-serif;overflow-wrap:anywhere}table{border-collapse:collapse;max-width:100%}th,td{border:1px solid color-mix(in srgb,currentColor 25%,transparent);padding:4px 8px}img{max-width:100%;height:auto}</style>",
    "</head><body>",
    sanitizedContent,
    "</body></html>",
  ].join("")
}

function JupyterCellOutput({ output }: { output: JupyterOutput }) {
  const t = useTranslations("artifactPreview")
  if (output.output_type === "stream") {
    const text = flattenText(output.text)
    const isErr = output.name === "stderr"
    return (
      <pre
        className={cn(
          "mt-2 rounded-md border bg-muted/40 p-3 text-xs whitespace-pre-wrap",
          isErr && "border-destructive/40 bg-destructive/5 text-destructive"
        )}
      >
        {text}
      </pre>
    )
  }

  if (output.output_type === "error") {
    const traceback = (output.traceback || []).join("\n")
    return (
      <pre className="mt-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive whitespace-pre-wrap">
        {output.ename}: {output.evalue}
        {traceback ? `\n${traceback}` : ""}
      </pre>
    )
  }

  // execute_result / display_data
  const html = getOutputDataAsString(output.data, "text/html")
  const png = getOutputDataAsString(output.data, "image/png")
  const text = getOutputDataAsString(output.data, "text/plain")

  if (png) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={`data:image/png;base64,${png}`}
        // i18n-exempt: pre-existing untranslated surface (repo i18n baseline); untouched by ADR-0068 import codemod
        alt="cell output"
        className="mt-2 max-w-full rounded-md border"
      />
    )
  }

  if (html) {
    return (
      <iframe
        title={t("notebookHtmlOutput")}
        sandbox="allow-popups"
        srcDoc={notebookHtmlSrcDoc(html)}
        className="mt-2 h-64 w-full rounded-md border bg-background"
      />
    )
  }

  if (text) {
    return (
      <pre className="mt-2 rounded-md border bg-muted/40 p-3 text-xs whitespace-pre-wrap">
        {text}
      </pre>
    )
  }

  return null
}

function JupyterCellView({ cell, language }: { cell: JupyterCell; language: string }) {
  const source = flattenSource(cell.source)
  if (cell.cell_type === "markdown") {
    return (
      <div className="rounded-md border bg-card p-3">
        <MarkdownRenderer content={source} rhythm="document" />
      </div>
    )
  }

  if (cell.cell_type === "code") {
    return (
      <div className="rounded-md border bg-card p-3">
        <CodeBlock code={source} language={language} showLineNumbers />
        {cell.outputs?.map((out, i) => (
          <JupyterCellOutput key={i} output={out} />
        ))}
      </div>
    )
  }

  return (
    <pre className="rounded-md border bg-muted/40 p-3 text-xs whitespace-pre-wrap">{source}</pre>
  )
}

export function JupyterRenderer({ content, className }: JupyterRendererProps) {
  const t = useTranslations("artifactPreview")
  const notebook = useMemo(() => parseNotebook(content), [content])

  if (!notebook) {
    return (
      <div className={cn("p-4 text-destructive", className)}>
        <div className="flex items-center gap-2">
          <AlertCircle className="h-4 w-4" />
          <span>{t("notebookParseError")}</span>
        </div>
      </div>
    )
  }

  const language =
    notebook.metadata.language_info?.name || notebook.metadata.kernelspec?.language || "python"

  return (
    <ScrollArea className={cn("flex-1 min-h-0", className)}>
      <div className="space-y-3 p-4">
        {notebook.cells.map((cell, index) => (
          <JupyterCellView key={cell.id || index} cell={cell} language={language} />
        ))}
      </div>
    </ScrollArea>
  )
}
