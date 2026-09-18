"use client"

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import type { ToolUIPart } from "ai"
import { PreviewClampNote, TOOL_LIST_MAX_ROWS, useClampedRows, useParsedOutput } from "./common"
import { WorkbenchFileLink } from "./workbench-file-link"

interface GrepInput {
  pattern?: string
  path?: string
  glob?: string
  output_mode?: string
}

interface GrepOutput {
  matches?: string[]
  files?: string[]
  lines?: string[]
}

/** POSIX root (`/…`) or a Windows drive root (`C:\…`, `C:/…`). */
const ABSOLUTE_HEAD = /^(?:\/|[A-Za-z]:[\\/])/

/**
 * Whether the head of a result line names a file rather than prose.
 *
 * An absolute head is taken as-is, spaces included — a path can legitimately
 * contain one and the root already proves it is a path. A relative head has no
 * such proof, so it must be a single token that carries a separator or a dotted
 * extension. That is what keeps `count` mode's `12 matches`, a grouped-output
 * `--` separator, and a heading-mode `42:text` line (whose head is a bare
 * number) out of the link.
 */
function isFilePathHead(head: string): boolean {
  if (head === "") return false
  if (ABSOLUTE_HEAD.test(head)) return true
  if (/\s/.test(head)) return false
  return /[\\/]/.test(head) || /\.[A-Za-z0-9_+-]+$/.test(head)
}

/**
 * Split a ripgrep-style result line into the file it names and the rest.
 *
 * `content` mode emits `path:line:text`, `files_with_matches` emits the bare
 * path, and both are common enough that handling only one leaves half the
 * results unreachable. The path may be relative: `Grep` reports paths relative
 * to the session's working directory by default, so an absolute-only reading
 * left the usual output entirely unlinked.
 *
 * A line whose head is not path-shaped is returned whole and stays plain text,
 * which covers the `count` mode's totals, grouped output's separators, and any
 * line the tool wrapped or truncated.
 */
export function splitGrepMatch(line: string): { path: string; line?: number; rest: string } | null {
  // A Windows drive's own colon is part of the path, never a location suffix.
  const from = /^[A-Za-z]:[\\/]/.test(line) ? 2 : 0
  const cut = line.indexOf(":", from)
  const path = cut === -1 ? line : line.slice(0, cut)
  if (!isFilePathHead(path)) return null
  const rest = cut === -1 ? "" : line.slice(cut)
  const lineNo = /^:(\d+)(?::|$)/.exec(rest)
  return {
    path,
    line: lineNo ? Number(lineNo[1]) : undefined,
    rest,
  }
}

/**
 * Body content for the Claude built-in `Grep` tool. Shows the pattern +
 * scope (path / glob / output mode) as context and the matched files or content
 * lines in a scrollable mono list. Mirrors {@link GlobCard}; falls through to the
 * generic ToolBody (by returning `null`) when there is neither a pattern nor any
 * parsable matches. Rendered bare — the surrounding row owns the card chrome.
 */
export function GrepCard({ part, sessionId }: { part: ToolUIPart; sessionId?: string }) {
  const t = useTranslations("chat.mcp.grep")
  const input = (part.input ?? {}) as GrepInput
  const parsed = useParsedOutput<GrepOutput>(part.output)

  // Selecting (and, on the string fallback, splitting) the match list is the
  // only non-trivial work here; recompute it only when the parsed output or the
  // raw payload changes rather than on every streaming re-render.
  const lines: string[] = useMemo(() => {
    if (parsed?.matches) return parsed.matches
    if (parsed?.lines) return parsed.lines
    if (parsed?.files) return parsed.files
    if (typeof part.output === "string") return part.output.split(/\r?\n/).filter(Boolean)
    return []
  }, [parsed, part.output])
  // Every match mounts a WorkbenchFileLink; a huge grep result clamps to a
  // row budget instead of flooding the expansion with thousands of links.
  const clamp = useClampedRows(lines, TOOL_LIST_MAX_ROWS)

  if (lines.length === 0 && !input.pattern) return null

  return (
    <div className="min-w-0" data-testid="mcp-grep-card">
      {/* The row already states pattern + scope + output_mode as its target —
          the body carries only the match list. */}
      {lines.length === 0 ? (
        <p className="text-muted-foreground">{t("noMatches")}</p>
      ) : (
        <ul
          className="max-h-60 overflow-auto rounded border bg-muted/50 px-2 py-1 font-mono text-[11px]"
          data-testid="mcp-grep-list"
        >
          {clamp.visible.map((m, i) => {
            const hit = splitGrepMatch(m)
            return (
              <li key={i} data-testid="mcp-grep-match" className="truncate">
                {hit ? (
                  <>
                    <WorkbenchFileLink
                      sessionId={sessionId}
                      path={hit.path}
                      line={hit.line}
                      data-testid="mcp-grep-match-link"
                    />
                    {hit.rest}
                  </>
                ) : (
                  m
                )}
              </li>
            )
          })}
        </ul>
      )}
      {clamp.hidden > 0 && (
        <PreviewClampNote
          shown={clamp.shown}
          total={clamp.total}
          onExpand={clamp.reveal}
          testId="mcp-grep-clamped"
        />
      )}
    </div>
  )
}
