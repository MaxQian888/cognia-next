"use client"

import { useState } from "react"
import { ChevronDownIcon, BookOpenCheckIcon } from "lucide-react"
import type { ToolUIPart } from "ai"
import { Button } from "@/components/ui/button"
import { McpCardShell, useParsedOutput } from "./common"
import { MarkdownRenderer } from "@/components/chat/markdown-renderer"

interface WikiReadOutput {
  slug?: string
  title?: string
  sections?: Array<{ heading?: string; body?: string }>
  body?: string
}

export function WikiReadCard({ part }: { part: ToolUIPart }) {
  const parsed = useParsedOutput<WikiReadOutput>(part.output)
  const [open, setOpen] = useState(true)
  if (!parsed) return null

  const sections = Array.isArray(parsed.sections) ? parsed.sections : []
  const fallbackBody = typeof parsed.body === "string" ? parsed.body : undefined

  return (
    <McpCardShell title="wiki_read" badge={parsed.slug} testId="mcp-wiki-read-card">
      <div className="flex items-start gap-2">
        <BookOpenCheckIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          {parsed.title && (
            <p className="mb-1 font-medium" data-testid="mcp-wiki-read-title">
              {parsed.title}
            </p>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1 text-[10px] text-muted-foreground"
            onClick={() => setOpen((v) => !v)}
            data-testid="mcp-wiki-read-toggle"
          >
            <ChevronDownIcon
              className={`mr-1 size-3 transition-transform ${open ? "" : "-rotate-90"}`}
            />
            {open ? "Hide" : "Show"} body
          </Button>
          {open &&
            (sections.length > 0 ? (
              <div className="mt-1 space-y-2">
                {sections.map((s, i) => (
                  <div
                    key={i}
                    className="rounded border bg-muted/30 px-2 py-1"
                    data-testid="mcp-wiki-read-section"
                  >
                    {s.heading && <p className="font-medium">{s.heading}</p>}
                    {s.body && <MarkdownRenderer content={s.body} className="text-xs" />}
                  </div>
                ))}
              </div>
            ) : fallbackBody ? (
              <div className="mt-1">
                <MarkdownRenderer content={fallbackBody} className="text-xs" />
              </div>
            ) : (
              <p className="text-muted-foreground">No content.</p>
            ))}
        </div>
      </div>
    </McpCardShell>
  )
}
