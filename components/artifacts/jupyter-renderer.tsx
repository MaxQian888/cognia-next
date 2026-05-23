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
import { loggers } from "@/lib/logging"
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

function JupyterCellOutput({ output }: { output: JupyterOutput }) {
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
        alt="cell output"
        className="mt-2 max-w-full rounded-md border"
      />
    )
  }

  if (html) {
    return (
      <div
        className="mt-2 rounded-md border bg-muted/40 p-3 text-xs"
        // Trusted: notebook output is sandboxed at the artifact-preview iframe layer.
        dangerouslySetInnerHTML={{ __html: html }}
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
        <MarkdownRenderer content={source} />
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
