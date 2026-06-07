"use client"

// Structured card for the core `write` tool (and SDK `Write`): target path +
// a syntax-highlighted preview of the content being written.

import { useTranslations } from "next-intl"
import { FilePlus2Icon } from "lucide-react"
import type { ToolUIPart } from "ai"
import { McpCardShell } from "./common"
import { CodeBlock } from "@/components/chat/renderers/code-block"

const PREVIEW_CHAR_CAP = 4_000

function languageFromPath(path: string | undefined): string {
  if (!path) return "text"
  const ext = path.toLowerCase().split(".").pop() ?? ""
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    mjs: "javascript",
    py: "python",
    rs: "rust",
    go: "go",
    java: "java",
    rb: "ruby",
    md: "markdown",
    json: "json",
    yml: "yaml",
    yaml: "yaml",
    toml: "toml",
    css: "css",
    html: "html",
    sh: "bash",
    sql: "sql",
  }
  return map[ext] ?? "text"
}

interface WriteInput {
  file_path?: string
  path?: string
  content?: string
}

export function WriteCard({ part }: { part: ToolUIPart }) {
  const t = useTranslations("chat.mcp.write")
  const input = (part.input ?? {}) as WriteInput
  const path = input.file_path ?? input.path
  if (!path || typeof input.content !== "string") return null

  const clipped = input.content.length > PREVIEW_CHAR_CAP
  const preview = clipped ? input.content.slice(0, PREVIEW_CHAR_CAP) : input.content

  return (
    <McpCardShell title={t("title")} badge={path} testId="mcp-write-card">
      <div className="flex items-start gap-2">
        <FilePlus2Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="font-mono text-[11px] text-muted-foreground" data-testid="mcp-write-path">
            {path} · {t("lineCount", { count: input.content.split("\n").length })}
          </p>
          <div className="mt-1" data-testid="mcp-write-code">
            <CodeBlock code={preview} language={languageFromPath(path)} showLineNumbers />
          </div>
          {clipped && <p className="mt-1 text-[11px] text-muted-foreground">{t("truncated")}</p>}
        </div>
      </div>
    </McpCardShell>
  )
}
