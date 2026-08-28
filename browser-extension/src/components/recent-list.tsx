import type { BrowserContextSubmissionSummaryV1 } from "@cognia/companion-client"
import { Button, Card, CardContent } from "@cognia/plugin-ui"

import type { BrowserApi } from "@ext/src/lib/browser-api"
import { STOPPABLE_STATUSES, failureReasonMessage } from "@ext/src/lib/panel-state"
import { StatusPill } from "./status-pill"

export interface RecentListProps {
  api: BrowserApi
  items: BrowserContextSubmissionSummaryV1[]
  /**
   * Refusal codes, by submission id, for the rows that have one.
   *
   * Fetched separately because the list does not carry them: the summary is
   * deliberately thin and `browser_context_get` is the only call that answers
   * `errorCode`. A row with no entry here simply shows its status, which is the
   * ordinary case.
   */
  failureCodes?: Record<string, string>
  /** The answer for each row the user asked to see, by submission id. */
  answers?: Record<string, { text?: string; truncated?: boolean }>
  /** Which rows are expanded. Held by the parent, which owns the fetch. */
  expanded?: readonly string[]
  onToggleAnswer?: (submissionId: string) => void
  onStop?: (submissionId: string) => void
  /** The row currently being stopped, if any. */
  stopping?: string | null
}

/**
 * The tasks started from this browser.
 *
 * Title, source host, status. No instruction and no page text — neither is
 * stored anywhere the panel could read them, which is the point rather than a
 * limitation: this list lives on disk in a browser profile, and the transcript
 * that holds the real content lives in Cognia where the user can delete it.
 *
 * `needs_input` gets "continue in Cognia" rather than an approval control. The
 * panel deliberately cannot answer a prompt (ADR-0154 §1), and offering
 * something that looks like it could would be worse than offering nothing.
 */
export function RecentList({
  api,
  items,
  failureCodes = {},
  answers = {},
  expanded = [],
  onToggleAnswer,
  onStop,
  stopping = null,
}: RecentListProps) {
  if (items.length === 0) {
    return (
      <p className="px-1 text-xs text-muted-foreground" data-testid="recent-empty">
        {api.message("recentEmpty")}
      </p>
    )
  }
  return (
    <ul className="space-y-1.5" data-testid="recent-list">
      {items.map((item) => (
        <li key={item.submissionId}>
          <Card>
            <CardContent className="space-y-1 px-2.5 py-2.5">
              <div className="flex items-start justify-between gap-2">
                <p className="line-clamp-2 min-w-0 shrink text-xs font-medium">{item.title}</p>
                <StatusPill api={api} status={item.status} />
              </div>
              {failureCodes[item.submissionId] ? (
                <p
                  className="text-[11px] text-muted-foreground"
                  data-testid={`recent-reason-${item.submissionId}`}
                >
                  {failureReasonMessage(failureCodes[item.submissionId], api.message)}
                </p>
              ) : null}
              {expanded.includes(item.submissionId) && hasTranscript(item) ? (
                <div className="space-y-1" data-testid={`recent-answer-${item.submissionId}`}>
                  {answers[item.submissionId]?.text ? (
                    // `whitespace-pre-wrap` because an assistant answer carries
                    // its own line breaks, and `break-words` because it may
                    // carry a URL longer than this panel is wide.
                    <p className="whitespace-pre-wrap break-words text-xs">
                      {answers[item.submissionId]?.text}
                    </p>
                  ) : (
                    <p className="text-[11px] text-muted-foreground">
                      {api.message("resultPending")}
                    </p>
                  )}
                  {answers[item.submissionId]?.truncated ? (
                    <p className="text-[11px] text-muted-foreground">
                      {api.message("resultTruncated")}
                    </p>
                  ) : null}
                </div>
              ) : null}
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-mono text-[11px] text-muted-foreground">
                  {item.sourceHost}
                </span>
                <div className="flex shrink-0 items-center gap-1">
                  {/* Only a conversation has a turn to stop or a transcript to
                      read. A filed issue and a queued agent task have neither,
                      and offering controls that would refuse is worse than
                      offering none. */}
                  {onStop && hasTranscript(item) && STOPPABLE_STATUSES.includes(item.status) ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => onStop(item.submissionId)}
                      disabled={stopping === item.submissionId}
                      data-testid={`recent-stop-${item.submissionId}`}
                    >
                      {stopping === item.submissionId
                        ? api.message("stopping")
                        : api.message("stop")}
                    </Button>
                  ) : null}
                  {onToggleAnswer && hasTranscript(item) ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => onToggleAnswer(item.submissionId)}
                      data-testid={`recent-answer-toggle-${item.submissionId}`}
                    >
                      {expanded.includes(item.submissionId)
                        ? api.message("resultHide")
                        : api.message("resultShow")}
                    </Button>
                  ) : null}
                  <Button size="sm" variant="ghost" onClick={() => void api.openUrl(item.deepLink)}>
                    {item.status === "needs_input"
                      ? api.message("continueInCognia")
                      : api.message("openInCognia")}
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </li>
      ))}
    </ul>
  )
}

/**
 * Whether a submission produced a conversation.
 *
 * Absent `workKind` means one, which is what every submission was before an
 * issue or an agent task could be one — an older Host sends no field and its
 * rows are all sessions.
 */
function hasTranscript(item: BrowserContextSubmissionSummaryV1): boolean {
  return !item.workKind || item.workKind === "session"
}
