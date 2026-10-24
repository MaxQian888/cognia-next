"use client"

/**
 * What the host's unattended runs are waiting on, answered from the phone
 * (ADR-0224 A7).
 *
 * An always-on host runs Bots and scheduled tasks with nobody at the desk. A
 * tool request the run's permission profile keeps for a person (an outbound
 * message, secret use, a host change, workspace work outside a verified
 * sandbox) parks the run, and so does a Bot's own approval step. Both arrive
 * here: the push names only the kind of decision, and this card, opened from
 * it, reads the rest with `execution_run_approval_list` (walking every page)
 * once the phone is unlocked and paired.
 *
 * Modelled on the workflow `PendingApprovalsCard`: a direct
 * `transport.call` rather than the offline outbound queue, because an answer
 * that lands after the park expired is no answer, and the live
 * `run://approval-pending` / `-resolved` frames reload the list. The answer
 * is `execution_run_approval_respond`, which the host routes through the run
 * control gate as this device; it carries no admin lease (a headless host has
 * nobody to approve one).
 *
 * A parked outbound tool request (ADR-0239) names its recipients, as the
 * desktop card does, and offers "allow for this request" when every recipient
 * can be named; a deny fences them for the rest of the request.
 *
 * Renders nothing while nothing waits, so mounting it on a page costs that
 * page no space.
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { BotIcon, CheckIcon, ClockIcon, ShieldAlertIcon, XIcon } from "lucide-react"

import { OutboundRecipients } from "@/components/chat/decisions/outbound-recipients"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import type {
  RunApprovalRespondOutcome,
  RunApprovalSummary,
} from "@/lib/execution/run-approvals"
import { collectPages, isPage, type Page } from "@/lib/tauri/companion-paging"
import { transport } from "@/lib/tauri/transport-instance"
import { cn } from "@/lib/utils"

export const RUN_APPROVAL_EVENT_CHANNELS = [
  "run://approval-pending",
  "run://approval-resolved",
] as const

/** More than a phone card should ever hold; a walk stops here rather than draining. */
const MAX_APPROVALS = 200

async function fetchApprovalPage(
  pageToken: string | undefined
): Promise<Page<RunApprovalSummary>> {
  const result = await transport.call(
    "execution_run_approval_list",
    pageToken ? { pageToken } : {}
  )
  // An older host answers something else; treat it as nothing waiting
  // rather than rendering a shape this card does not know.
  return isPage(result) ? (result as Page<RunApprovalSummary>) : { items: [] }
}

export function RunApprovalsCard({ className }: { className?: string }) {
  const t = useTranslations("mobile.runApprovals")
  const [approvals, setApprovals] = useState<RunApprovalSummary[]>([])
  const [busyId, setBusyId] = useState<string | null>(null)

  const reload = useCallback(async () => {
    try {
      setApprovals(await collectPages(fetchApprovalPage, { maxItems: MAX_APPROVALS }))
    } catch {
      // Host unreachable: keep what was last seen. The connection banners
      // tell that story; a card that blanked would read as "nothing waits".
    }
  }, [])

  useEffect(() => {
    // Deferred a tick for the same reason as the workflow card: the lint rule
    // cannot see that `reload` only sets state after the RPC resolves.
    const kickoff = setTimeout(() => void reload(), 0)
    const unsubs = RUN_APPROVAL_EVENT_CHANNELS.map((channel) =>
      transport.subscribe(channel, () => void reload())
    )
    return () => {
      clearTimeout(kickoff)
      for (const off of unsubs) off()
    }
  }, [reload])

  const respond = useCallback(
    async (interruptId: string, decision: "approve" | "deny", forRequest?: boolean) => {
      setBusyId(interruptId)
      try {
        const result = (await transport.call("execution_run_approval_respond", {
          interruptId,
          decision,
          ...(forRequest ? { forRequest: true } : {}),
        })) as RunApprovalRespondOutcome | null
        if (result?.ok) {
          setApprovals((prev) => prev.filter((a) => a.interruptId !== interruptId))
          toast.success(result.status === "approved" ? t("approvedToast") : t("deniedToast"))
        } else if (result?.reason === "gone") {
          // Answered elsewhere, or expired and denied: the list is stale.
          toast.info(t("goneToast"))
          void reload()
        } else {
          toast.error(t("refusedToast"), {
            ...(result?.reason ? { description: result.reason } : {}),
          })
          void reload()
        }
      } catch {
        toast.error(t("respondFailedToast"))
      } finally {
        setBusyId(null)
      }
    },
    [reload, t]
  )

  if (approvals.length === 0) return null

  return (
    <Card className={cn("space-y-3 p-3", className)} data-testid="run-approvals-card">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <ShieldAlertIcon className="size-4 text-amber-500" aria-hidden="true" />
        {t("heading", { count: approvals.length })}
      </div>
      <ul className="space-y-4">
        {approvals.map((a) => (
          <li
            key={a.interruptId}
            className="space-y-1.5"
            data-testid={`run-approval-${a.interruptId}`}
          >
            <div className="flex flex-wrap items-center gap-1.5">
              {a.type === "bot_approval" ? (
                <Badge variant="secondary" className="gap-1 font-normal">
                  <BotIcon className="size-3" aria-hidden="true" />
                  {t("kind.bot")}
                </Badge>
              ) : (
                <Badge variant="secondary" className="font-normal">
                  {a.permissionClass ? t(`class.${a.permissionClass}`) : t("kind.tool")}
                </Badge>
              )}
              {a.risk ? (
                <Badge
                  variant={a.risk === "high" ? "destructive" : "outline"}
                  className="font-normal"
                >
                  {t(`risk.${a.risk}`)}
                </Badge>
              ) : null}
            </div>
            <p className="text-sm font-medium leading-tight">{a.title}</p>
            <p className="text-xs text-muted-foreground">{a.runTitle}</p>
            {a.message ? <p className="line-clamp-4 text-xs">{a.message}</p> : null}
            {a.detail ? (
              <pre
                className="max-h-32 overflow-auto rounded bg-muted p-2 text-[11px] leading-snug"
                data-testid={`run-approval-detail-${a.interruptId}`}
              >
                {JSON.stringify(a.detail, null, 2)}
              </pre>
            ) : null}
            {a.detailTruncated ? (
              <p className="text-[11px] text-muted-foreground">{t("detailTruncated")}</p>
            ) : null}
            {a.outbound ? <OutboundRecipients targets={a.outbound.recipients} fenceNotice /> : null}
            <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
              <ClockIcon className="size-3" aria-hidden="true" />
              {t("expires", { time: new Date(a.expiresAt) })}
            </p>
            <div className="flex gap-2 pt-0.5">
              <Button
                size="sm"
                className="flex-1"
                disabled={busyId === a.interruptId}
                onClick={() => void respond(a.interruptId, "approve")}
                data-testid={`run-approval-approve-${a.interruptId}`}
              >
                <CheckIcon className="size-4" aria-hidden="true" />
                {t("approve")}
              </Button>
              {a.outbound?.allowForRequest ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="flex-1"
                  disabled={busyId === a.interruptId}
                  onClick={() => void respond(a.interruptId, "approve", true)}
                  data-testid={`run-approval-allow-request-${a.interruptId}`}
                >
                  {t("allowForRequest")}
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="outline"
                className="flex-1"
                disabled={busyId === a.interruptId}
                onClick={() => void respond(a.interruptId, "deny")}
                data-testid={`run-approval-deny-${a.interruptId}`}
              >
                <XIcon className="size-4" aria-hidden="true" />
                {t("deny")}
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  )
}
