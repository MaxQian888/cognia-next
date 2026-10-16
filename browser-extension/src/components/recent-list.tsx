import type { BrowserContextSubmissionSummaryV1 } from "@cognia/companion-client"
import { Button, Card, CardContent, CopyFeedbackIcon, Input, useCopy } from "@cognia/plugin-ui"

import type { BrowserApi } from "@ext/src/lib/browser-api"
import { STOPPABLE_STATUSES, failureReasonMessage } from "@ext/src/lib/panel-state"
import { MarkdownView } from "./markdown-view"
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
  /** Search text, when the Host pages and searches (ADR-0228 §4). */
  query?: string
  onQueryChange?: (query: string) => void
  /** Another page exists; `onLoadMore` fetches it. */
  hasMore?: boolean
  onLoadMore?: () => void
  loadingMore?: boolean
  /** Rows whose conversation can take a follow-up from this panel. */
  followUpIds?: readonly string[]
  onFollowUp?: (item: BrowserContextSubmissionSummaryV1) => void
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
  query,
  onQueryChange,
  hasMore = false,
  onLoadMore,
  loadingMore = false,
  followUpIds = [],
  onFollowUp,
}: RecentListProps) {
  const search = onQueryChange ? (
    <Input
      type="search"
      value={query ?? ""}
      onChange={(event) => onQueryChange(event.target.value)}
      placeholder={api.message("recentSearch")}
      aria-label={api.message("recentSearch")}
      className="h-7 text-xs"
      data-testid="recent-search"
    />
  ) : null
  if (items.length === 0) {
    return (
      <div className="space-y-1.5">
        {search}
        <p className="px-1 text-xs text-muted-foreground" data-testid="recent-empty">
          {query?.trim() ? api.message("recentNoMatch") : api.message("recentEmpty")}
        </p>
      </div>
    )
  }
  return (
    <div className="space-y-1.5">
      {search}
      <ul className="space-y-1.5" data-testid="recent-list">
        {items.map((item) => {
          const failureCode = failureCodes[item.submissionId]
          return (
            <li key={item.submissionId}>
              <Card>
                <CardContent className="space-y-1 px-2.5 py-2.5">
                  <div className="flex items-start justify-between gap-2">
                    <p className="line-clamp-2 min-w-0 shrink text-xs font-medium">{item.title}</p>
                    <StatusPill api={api} status={item.status} />
                  </div>
                  {failureCode ? (
                    <p
                      className="text-[11px] text-muted-foreground"
                      data-testid={`recent-reason-${item.submissionId}`}
                    >
                      {failureReasonMessage(failureCode, api.message)}
                    </p>
                  ) : null}
                  {expanded.includes(item.submissionId) && hasTranscript(item) ? (
                    <div className="space-y-1" data-testid={`recent-answer-${item.submissionId}`}>
                      {answers[item.submissionId]?.text ? (
                        <AnswerBody api={api} text={answers[item.submissionId]?.text ?? ""} />
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
                  {/* Wraps rather than squeezes. A side panel can be 320px wide,
                  and three localized buttons beside a hostname do not fit on
                  one line there — a `shrink-0` group pushed the row past the
                  card edge. The host takes what is left and truncates; the
                  buttons wrap onto a second line, right-aligned, when they
                  must. */}
                  <div
                    className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1"
                    data-testid={`recent-actions-${item.submissionId}`}
                  >
                    <span
                      className="min-w-0 flex-1 basis-24 truncate font-mono text-[11px] text-muted-foreground"
                      title={item.sourceHost}
                    >
                      {item.sourceHost}
                    </span>
                    <div className="ml-auto flex min-w-0 max-w-full flex-wrap items-center justify-end gap-1">
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
                      {onFollowUp && followUpIds.includes(item.submissionId) ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => onFollowUp(item)}
                          data-testid={`recent-follow-up-${item.submissionId}`}
                        >
                          {api.message("followUp")}
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
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void api.openUrl(item.deepLink)}
                      >
                        {item.status === "needs_input"
                          ? api.message("continueInCognia")
                          : api.message("openInCognia")}
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </li>
          )
        })}
      </ul>
      {hasMore && onLoadMore ? (
        <Button
          size="sm"
          variant="ghost"
          className="w-full"
          disabled={loadingMore}
          onClick={onLoadMore}
          data-testid="recent-load-more"
        >
          {loadingMore ? api.message("loading") : api.message("recentLoadMore")}
        </Button>
      ) : null}
    </div>
  )
}

/**
 * An answer, rendered as the Markdown it was written in, with a copy button
 * that copies that Markdown — what the agent wrote, not what the panel drew.
 */
function AnswerBody({ api, text }: { api: BrowserApi; text: string }) {
  const { copy, copied } = useCopy()
  return (
    <div className="relative">
      <Button
        size="sm"
        variant="ghost"
        className="absolute top-0 right-0 h-6 w-6 p-0"
        onClick={() => void copy(text)}
        aria-label={api.message("resultCopy")}
        data-testid="recent-answer-copy"
      >
        <CopyFeedbackIcon copied={copied} />
      </Button>
      <MarkdownView api={api} source={text} />
    </div>
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
