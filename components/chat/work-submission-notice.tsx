"use client"

import { useTranslations } from "next-intl"
import { AlertCircleIcon, CloudOffIcon, ClockIcon } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { useWorkSubmissionStatus } from "@/hooks/work-submission/use-work-submission-status"

interface Props {
  sessionId: string | undefined
}

/**
 * Tells the user what happened to a turn the system accepted but has not
 * answered (ADR-0123).
 *
 * Before durable submission, the three states below were indistinguishable
 * from a hung request: the message sat there and nothing explained why. Each
 * one now says which it is, because the right user response differs — wait,
 * reconnect, or intervene.
 *
 * Renders nothing while a turn is streaming normally. The existing streaming
 * UI already reports that, and a second indicator beside it would be noise.
 *
 * Visual treatment follows `character-missing-banner.tsx` so the chat surface
 * stays homogeneous; no new variant or palette is introduced.
 */
export function WorkSubmissionNotice({ sessionId }: Props) {
  const t = useTranslations("chat.workSubmission")
  const { state } = useWorkSubmissionStatus(sessionId)

  if (state === "idle") return null

  if (state === "recoveryRequired") {
    return (
      <Alert variant="destructive" data-testid="work-submission-recovery">
        <AlertCircleIcon />
        <AlertTitle>{t("recoveryRequired.title")}</AlertTitle>
        <AlertDescription>{t("recoveryRequired.body")}</AlertDescription>
      </Alert>
    )
  }

  if (state === "blocked") {
    return (
      <Alert data-testid="work-submission-blocked">
        <CloudOffIcon />
        <AlertTitle>{t("blocked.title")}</AlertTitle>
        <AlertDescription>{t("blocked.body")}</AlertDescription>
      </Alert>
    )
  }

  return (
    <Alert data-testid="work-submission-queued">
      <ClockIcon />
      <AlertTitle>{t("queued.title")}</AlertTitle>
      <AlertDescription>{t("queued.body")}</AlertDescription>
    </Alert>
  )
}
