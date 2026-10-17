"use client"

import { useTranslations } from "next-intl"
import { AlertCircleIcon, CloudOffIcon, ClockIcon } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { useWorkSubmissionStatus } from "@/hooks/work-submission/use-work-submission-status"

interface Props {
  sessionId: string | undefined
}

function recoveryBodyKey(errorCode: string | undefined) {
  switch (errorCode) {
    case "observed-tool-activity":
      return "recoveryRequired.reasons.toolActivity"
    case "ambiguous-side-effects":
      return "recoveryRequired.reasons.uncertainEffects"
    case "corrupt-canonical-log":
      return "recoveryRequired.reasons.corruptLog"
    case "unreadable-journal":
      return "recoveryRequired.reasons.unreadableJournal"
    case "no-candidates":
      return "recoveryRequired.reasons.missingHistory"
    case "forked-history":
      return "recoveryRequired.reasons.conflictingHistory"
    case "no-dominant":
      return "recoveryRequired.reasons.ambiguousHistory"
    case "missing_frozen_input":
      return "recoveryRequired.reasons.missingInput"
    case "missing_frozen_context":
    case "missing_frozen_send_options":
      return "recoveryRequired.reasons.incompleteContext"
    case "invalid_frozen_input":
      return "recoveryRequired.reasons.invalidInput"
    case "frozen_payload_unreadable":
      return "recoveryRequired.reasons.unreadablePayload"
    case "frozen_input_digest_mismatch":
    case "frozen_context_digest_mismatch":
      return "recoveryRequired.reasons.integrityMismatch"
    case "takeover_abort_failed":
      return "recoveryRequired.reasons.previousRuntime"
    case "frozen_transcript_host_unverified":
      return "recoveryRequired.reasons.unverifiedHost"
    case "transcript_authoritative_host_required":
      return "recoveryRequired.reasons.authoritativeHost"
    case "frozen_transcript_session_missing":
      return "recoveryRequired.reasons.missingSession"
    case "frozen_transcript_generation_mismatch":
      return "recoveryRequired.reasons.changedHistory"
    default:
      return "recoveryRequired.body"
  }
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
  const { state, submission } = useWorkSubmissionStatus(sessionId)

  if (state === "idle") return null

  if (state === "recoveryRequired") {
    return (
      <Alert variant="destructive" data-testid="work-submission-recovery">
        <AlertCircleIcon />
        <AlertTitle>{t("recoveryRequired.title")}</AlertTitle>
        <AlertDescription>{t(recoveryBodyKey(submission?.errorCode))}</AlertDescription>
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
