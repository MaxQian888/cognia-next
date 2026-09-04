"use client"

// The path a tool card names, made reachable.
//
// Read, Glob, Grep and NotebookEdit all report paths — absolute or relative to
// the session's working directory — that the user then had to go and find by
// hand, while the right rail was already rooted at the same tree. This is the read-side twin of `workbench-review-button.tsx`:
// that one opens a diff for a file the agent CHANGED, this one opens the file
// itself for one the agent merely looked at.
//
// It renders plain text rather than a dead control whenever the click could not
// go anywhere: no conversation, no filesystem backend (pure web mode has no
// working tree), or a blank path. The remaining refusal, a path that lands
// outside this conversation's execution root, is only knowable asynchronously,
// so that one is reported instead of swallowed.

import { useTranslations } from "next-intl"
import { toast } from "sonner"

import {
  canOfferWorkbenchReview,
  openFileInWorkbenchWorkspace,
} from "@/lib/files/edit-review-bridge"
import { cn } from "@/lib/utils"

export interface WorkbenchFileLinkProps {
  sessionId?: string
  /**
   * The path as the tool reported it: absolute, or relative to the session's
   * working directory. `Read` accepts a relative `file_path`, and `Glob`/`Grep`
   * report relative paths by default, so demanding an absolute one here left
   * most tool-card paths inert.
   */
  path: string
  /** 1-based caret to reveal, when the tool call named one. */
  line?: number
  column?: number
  /** Defaults to `path`, so a card can show a shortened label. */
  children?: React.ReactNode
  className?: string
  "data-testid"?: string
}

export function WorkbenchFileLink({
  sessionId,
  path,
  line,
  column,
  children,
  className,
  "data-testid": testId = "mcp-workbench-file-link",
}: WorkbenchFileLinkProps) {
  const t = useTranslations("chat.mcp")
  // A relative path is NOT refused here: `openFileInWorkbenchWorkspace` joins
  // it onto the conversation's own execution root — the directory those paths
  // are relative to — and then applies the same containment check an absolute
  // path gets, so a path that climbs out still ends up reported, not opened.
  const reachable = Boolean(sessionId) && canOfferWorkbenchReview() && path.trim() !== ""

  if (!reachable) return <span className={className}>{children ?? path}</span>

  return (
    <button
      type="button"
      className={cn(
        "cursor-pointer text-left [font:inherit] underline decoration-dotted underline-offset-2",
        "hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
        className
      )}
      title={t("openInWorkspace")}
      // The path, THEN the hint. A bare `aria-label` replaced the button's
      // visible text, so twenty Grep matches all announced the same sentence
      // and the one thing telling them apart was unreachable.
      aria-label={`${path} — ${t("openInWorkspace")}`}
      data-testid={testId}
      onClick={() => {
        void openFileInWorkbenchWorkspace({
          sessionId: sessionId!,
          path,
          line,
          column,
        }).then((opened) => {
          if (!opened) toast.error(t("openInWorkspaceOutOfScope"))
        })
      }}
    >
      {children ?? path}
    </button>
  )
}
