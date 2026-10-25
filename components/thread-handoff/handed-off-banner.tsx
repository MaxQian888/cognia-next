"use client"

/**
 * Says a conversation now continues on another device (ADR-0103), and, when
 * its code went along to an always-on host (ADR-0224 A11b), brings the work
 * done there back with one action (A11c): into a new worktree on this
 * device, never into the folder the conversation started from. Then offers a
 * draft pull request when the repository is on GitHub and a credential is
 * connected.
 *
 * Mounted above the transcript of the chat pane. Renders nothing unless the
 * conversation's handoff is committed.
 */

import { useLiveQuery } from "dexie-react-hooks"
import {
  ArrowRightLeftIcon,
  DownloadIcon,
  FolderOpenIcon,
  GitPullRequestIcon,
  Loader2Icon,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { useMemo, useState } from "react"
import { toast } from "sonner"
import type { ChatSession } from "@cognia/agent-config-types"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { getThreadHandoffTicket } from "@/lib/db/thread-handoff-tickets"
import { formatBytesCompact } from "@/lib/observability/format-utils"
import { isTauri } from "@/lib/platform/detect"
import {
  bringBackFailure,
  bringBackRefusal,
  bringChangesBack,
  handedOverCode,
  openResultPullRequest,
  resultPullRequestAvailable,
  type BringBackProgress,
  type BringBackResult,
} from "@/lib/remote-host/code-supply/result-return"
import { createGitHubPullRequestProvider } from "@/lib/review/github-runtime"
import { openExternal, revealInExplorer } from "@/lib/tauri/opener"
import { useRemoteHostStore } from "@/stores/remote-host/remote-host-store"
import type { PullRequestRef } from "@/types/review"

export interface HandedOffBannerProps {
  session: ChatSession
  className?: string
}

export function HandedOffBanner({ session, className }: HandedOffBannerProps) {
  const lock = session.handoffLock
  if (!lock || lock.state !== "committed") return null
  return <CommittedBanner session={session} ticketId={lock.ticketId} className={className} />
}

/** Split out so the ticket read and the host lookup only run for a committed handoff. */
function CommittedBanner({
  session,
  ticketId,
  className,
}: {
  session: ChatSession
  ticketId: string
  className?: string
}) {
  const t = useTranslations("threadHandoff.bringBack")
  const ticket = useLiveQuery(() => getThreadHandoffTicket(ticketId, "source"), [ticketId])
  const handed = handedOverCode(session, ticket)
  const hostRef = handed?.hostRef ?? session.handoffLock?.targetHostRef
  const host = useRemoteHostStore(
    (state) => state.hosts.find((candidate) => candidate.id === hostRef) ?? null
  )
  const hostName = host?.label ?? ticket?.target.label ?? t("anotherDevice")
  const refusal = bringBackRefusal({ handed, host, isDesktop: isTauri() })
  const provider = useMemo(() => createGitHubPullRequestProvider(), [])

  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<BringBackProgress | null>(null)
  const [brought, setBrought] = useState<BringBackResult | null>(null)
  const [canPropose, setCanPropose] = useState(false)
  const [proposing, setProposing] = useState(false)
  const [pullRequest, setPullRequest] = useState<PullRequestRef | null>(null)

  const bringBack = async () => {
    setBusy(true)
    try {
      const next = await bringChangesBack(session, handed, host, { onProgress: setProgress })
      setBrought(next)
      setPullRequest(null)
      toast.success(next.applied.reused ? t("alreadyHere") : t("broughtBack", { host: hostName }))
      setCanPropose(await resultPullRequestAvailable(next, provider))
    } catch (error) {
      toast.error(t(`failure.${bringBackFailure(error)}`, { host: hostName }))
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  const propose = async () => {
    if (!brought) return
    setProposing(true)
    try {
      const opened = await openResultPullRequest(
        brought,
        { title: session.title, body: t("pullRequestBody", { host: hostName }) },
        provider,
        { sessionId: session.id }
      )
      setPullRequest(opened)
      void openExternal(opened.url)
    } catch {
      toast.error(t("pullRequestFailed"))
    } finally {
      setProposing(false)
    }
  }

  const progressText = progress
    ? progress.step === "download"
      ? t("progress.download", {
          received: formatBytesCompact(progress.receivedBytes ?? 0),
          total: formatBytesCompact(progress.totalBytes ?? 0),
        })
      : t(`progress.${progress.step}`, { host: hostName })
    : null

  return (
    <Alert className={className} role="status" data-testid="handed-off-banner">
      <ArrowRightLeftIcon />
      <AlertTitle>{t("title", { host: hostName })}</AlertTitle>
      <AlertDescription className="flex flex-col items-start gap-2">
        <span>{t("body")}</span>
        {handed && refusal === null ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void bringBack()}
              data-testid="handed-off-bring-back"
            >
              {busy ? (
                <Loader2Icon aria-hidden className="size-3.5 animate-spin" />
              ) : (
                <DownloadIcon aria-hidden className="size-3.5" />
              )}
              {t("action")}
            </Button>
            <span className="text-xs" data-testid="handed-off-progress">
              {progressText ?? t("actionDescription", { host: hostName })}
            </span>
          </div>
        ) : null}
        {handed && refusal === "host-unsupported" ? (
          <span className="text-xs" data-testid="handed-off-unsupported">
            {t("unsupported", { host: hostName })}
          </span>
        ) : null}
        {brought ? (
          <div className="flex w-full flex-col gap-1.5" data-testid="handed-off-result">
            <span className="break-all text-xs">
              {brought.applied.branch
                ? t("landedWorktree", {
                    branch: brought.applied.branch,
                    path: brought.applied.workingDir,
                  })
                : t("landedFolder", { path: brought.applied.workingDir })}
            </span>
            {brought.result.kind === "bundle" ? (
              <span className="text-xs" data-testid="handed-off-not-pushed">
                {t("notPushed", { host: hostName })}
              </span>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void revealInExplorer(brought.applied.workingDir)}
                data-testid="handed-off-reveal"
              >
                <FolderOpenIcon aria-hidden className="size-3.5" />
                {t("reveal")}
              </Button>
              {pullRequest ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void openExternal(pullRequest.url)}
                  data-testid="handed-off-pull-request-link"
                >
                  <GitPullRequestIcon aria-hidden className="size-3.5" />
                  {t("pullRequestOpened", { number: pullRequest.number })}
                </Button>
              ) : canPropose ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={proposing}
                  onClick={() => void propose()}
                  data-testid="handed-off-open-pull-request"
                >
                  <GitPullRequestIcon aria-hidden className="size-3.5" />
                  {t("openPullRequest")}
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
      </AlertDescription>
    </Alert>
  )
}
