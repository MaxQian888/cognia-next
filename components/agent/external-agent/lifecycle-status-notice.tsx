"use client"

/**
 * Why a saved Agent is not ready to start.
 *
 * Reconciliation has always recorded this: at every startup `reviewAll()`
 * decides whether each Agent can honestly connect and writes the verdict plus a
 * reason code onto the config. Nothing rendered it, so an Agent whose plugin
 * was uninstalled, whose credential vanished from the keyring, or which needs a
 * Windows consent, simply stayed switched off with no explanation — the exact
 * silent failure the verdict exists to replace.
 *
 * The sentence is keyed on the REASON CODE, not on the `lifecycleReason` string
 * the service also stores: that one is a non-localized developer detail
 * (`"no protocol adapter is registered for \"acp\""`) and must not reach a user.
 *
 * Renders nothing when the Agent is ready, so call sites can mount it
 * unconditionally rather than each re-deriving the condition.
 *
 * @see lib/ai/agent/external/lifecycle/service.ts `assessReadiness`
 */

import type { ReactNode } from "react"
import { useTranslations } from "next-intl"
import { AlertTriangle, KeyRound, PackageX, ShieldQuestion } from "lucide-react"

import { lifecycleErrorKey } from "@/lib/ai/agent/external/lifecycle/error-messages"
import type {
  ExternalAgentLifecycleErrorCode,
  ExternalAgentLifecycleStatus,
} from "@/types/agent/external-agent-lifecycle"
import { cn } from "@/lib/utils"

export interface LifecycleStatusNoticeProps {
  status?: ExternalAgentLifecycleStatus
  /** Which specific failure. Drives the sentence the user reads. */
  reasonCode?: ExternalAgentLifecycleErrorCode
  /** What the user can do about it, when there is something. */
  action?: ReactNode
  className?: string
}

const STATUS_PRESENTATION: Record<
  Exclude<ExternalAgentLifecycleStatus, "ready">,
  { icon: typeof AlertTriangle; labelKey: string }
> = {
  "needs-credentials": { icon: KeyRound, labelKey: "needsCredentials" },
  "needs-consent": { icon: ShieldQuestion, labelKey: "needsConsent" },
  "needs-runtime": { icon: PackageX, labelKey: "needsRuntime" },
  blocked: { icon: AlertTriangle, labelKey: "blocked" },
}

export function LifecycleStatusNotice({
  status,
  reasonCode,
  action,
  className,
}: LifecycleStatusNoticeProps) {
  const t = useTranslations("externalAgent.lifecycle")
  const tErrors = useTranslations("externalAgent.lifecycleErrors")

  if (!status || status === "ready") return null

  const presentation = STATUS_PRESENTATION[status]
  const Icon = presentation.icon
  // A verdict always carries a code; an absent one is a defect in the writer,
  // not a state to render as "everything is fine".
  const message = reasonCode ? tErrors(lifecycleErrorKey(reasonCode)) : t("noReason")

  return (
    <div
      className={cn(
        "flex flex-wrap items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2",
        className
      )}
      data-testid="lifecycle-status-notice"
      data-status={status}
    >
      <Icon
        className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400"
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="text-xs font-medium text-amber-800 dark:text-amber-300">
          {t(`statusLabel.${presentation.labelKey}`)}
        </p>
        <p className="text-xs text-amber-800/90 dark:text-amber-300/90">{message}</p>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  )
}
