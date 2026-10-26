"use client"

/**
 * Under a failed turn: an offer to improve the agent's harness on the
 * request that just failed (failure-triggered mode), or, once a run exists
 * for this conversation, where that run stands. Shown only for failures of
 * the agent's own conduct (`isHarnessFailure`), never for outages.
 */

import { useState, useSyncExternalStore } from "react"
import Link from "next/link"
import { useTranslations } from "next-intl"
import { DnaIcon, XIcon } from "lucide-react"
import type { Character } from "@cognia/agent-config-types"
import type { CogniaDiagnostic } from "@cognia/diagnostics"
import { Button } from "@/components/ui/button"
import { useHarnessEvolutionSettings, useHarnessRuns } from "@/hooks/harness/use-harness-data"
import { extractMessageText } from "@/lib/a2ui/from-execution/conversation"
import {
  decideFailureOffer,
  failureOfferDismissKey,
  isHarnessFailure,
  lastUserRequest,
  runOfSession,
  taskDraftFromFailedTurn,
} from "@/lib/harness/failure-offer"
import { harnessRunHref } from "@/lib/harness/runtime/run-control"
import { useSessionVisibleMessages } from "@/stores/chat/chat-store"
import { HarnessRunStatusBadge } from "./harness-run-status-badge"
import { HarnessStartRunDialog } from "./harness-start-run-dialog"

export interface HarnessFailureOfferProps {
  sessionId: string
  agent: Character | null | undefined
  diagnostic: CogniaDiagnostic | null
  projectId?: string
  workingDirectory?: string | null
}

// Dismissals live in localStorage; this store lets every chip re-read them
// when one is dismissed.
const listeners = new Set<() => void>()
function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
function readDismissed(agentId: string | undefined): number | undefined {
  if (!agentId || typeof localStorage === "undefined") return undefined
  try {
    const raw = localStorage.getItem(failureOfferDismissKey(agentId))
    const value = raw ? Number(raw) : NaN
    return Number.isFinite(value) ? value : undefined
  } catch {
    return undefined
  }
}

export function HarnessFailureOffer(props: HarnessFailureOfferProps) {
  // Cheap guard first: most failures are not harness failures, and the chip
  // must cost nothing for them.
  if (!isHarnessFailure(props.diagnostic) || !props.agent) return null
  return <FailureOfferBody {...props} agent={props.agent} />
}

function FailureOfferBody({
  sessionId,
  agent,
  diagnostic,
  projectId,
  workingDirectory,
}: HarnessFailureOfferProps & { agent: Character }) {
  const t = useTranslations("harnessEvolution.failureOffer")
  const settings = useHarnessEvolutionSettings()
  const runs = useHarnessRuns(agent.id, 50)
  const messages = useSessionVisibleMessages(sessionId)
  const dismissedAt = useSyncExternalStore(
    subscribe,
    () => readDismissed(agent.id),
    () => undefined
  )
  const [starting, setStarting] = useState(false)
  if (!runs) return null

  const request = lastUserRequest(messages, (parts) => extractMessageText(parts as never))
  const existing = runOfSession(runs, sessionId)
  if (existing && existing.status !== "cancelled" && existing.status !== "failed") {
    return (
      <div
        className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-xs"
        data-testid="harness-failure-run"
      >
        <DnaIcon className="size-3.5 text-muted-foreground" aria-hidden />
        <span>{t("runExists")}</span>
        <HarnessRunStatusBadge status={existing.status} />
        <Link className="underline underline-offset-2" href={harnessRunHref(existing.id)}>
          {t("viewRun")}
        </Link>
      </div>
    )
  }
  const decision = decideFailureOffer({
    settings,
    diagnostic,
    agent,
    prompt: request?.text ?? "",
    runs,
    ...(dismissedAt !== undefined ? { dismissedAt } : {}),
    sessionId,
    // Judged as of the failure, so the chip does not change its mind while
    // it sits on screen.
    now: diagnostic?.at ?? 0,
  })
  if (decision.kind !== "offer" || !request) return null

  const dismiss = () => {
    try {
      localStorage.setItem(failureOfferDismissKey(agent.id), String(Date.now()))
    } catch {
      // Storage unavailable: the chip comes back next render, which is the
      // honest outcome when the dismissal cannot be remembered.
    }
    for (const listener of listeners) listener()
  }

  return (
    <div
      className="flex flex-wrap items-center gap-2 rounded-md border border-dashed px-3 py-2 text-xs"
      data-testid="harness-failure-offer"
    >
      <DnaIcon className="size-3.5 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1">{t("offer", { agent: agent.name })}</span>
      <Button size="sm" variant="outline" className="h-7" onClick={() => setStarting(true)}>
        {t("improve")}
      </Button>
      <Button
        size="icon"
        variant="ghost"
        className="size-7"
        onClick={dismiss}
        aria-label={t("dismiss")}
        data-testid="harness-failure-dismiss"
      >
        <XIcon className="size-3.5" aria-hidden />
      </Button>
      <HarnessStartRunDialog
        open={starting}
        onOpenChange={setStarting}
        agent={agent}
        trigger="failure-triggered"
        sessionId={sessionId}
        {...(projectId ? { projectId } : {})}
        draft={taskDraftFromFailedTurn({
          sessionId,
          messageId: request.id,
          prompt: request.text,
          ...(workingDirectory !== undefined ? { workingDirectory } : {}),
          ...(projectId ? { projectId } : {}),
        })}
      />
    </div>
  )
}
