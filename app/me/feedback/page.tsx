"use client"

/**
 * Feedback / diagnostics entry. Provides:
 *   • Direct link to file a new GitHub issue.
 *   • Action to copy a diagnostics blob (app version + UA + sync status)
 *     onto the system clipboard.
 *   • Permission / device check shortcut into `/me/device-info`.
 */

import { useTranslations } from "next-intl"
import { BugIcon, ClipboardCopyIcon, ExternalLinkIcon, HardDriveIcon } from "lucide-react"
import { toast } from "sonner"

import { MeRow } from "@/components/mobile/me/me-row"
import { MeSection } from "@/components/mobile/me/me-section"
import { SubPageShell } from "@/components/mobile/me/sub-page-shell"
import { APP_VERSION } from "@/lib/app-version"
import { snapshotSyncStates } from "@/lib/sync/companion-sync"
import { useCopy } from "@/hooks/ui/use-copy"

const ISSUES_URL = "https://github.com/anthropics/claude-code/issues/new"

function diagnosticsPayload(): string {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "unknown"
  let sync = ""
  try {
    sync = JSON.stringify(snapshotSyncStates(), null, 2)
  } catch {
    sync = "(unavailable)"
  }
  return [
    `cognia-next ${APP_VERSION}`,
    `UA: ${ua}`,
    `Date: ${new Date().toISOString()}`,
    `Sync snapshot:\n${sync}`,
  ].join("\n")
}

export default function MobileFeedbackPage() {
  const t = useTranslations("mobile.me")
  const tFeedback = useTranslations("mobile.me.feedback")
  const { copied, copy } = useCopy(2000)

  const copyDiagnostics = async () => {
    const ok = await copy(diagnosticsPayload())
    if (ok) {
      toast.success(tFeedback("copyToast"))
    } else {
      toast.error(tFeedback("copyError"))
    }
  }

  return (
    <SubPageShell
      title={t("feedbackRow")}
      backAria={t("appearanceBackAria")}
      testid="mobile-feedback-page"
    >
      <div className="flex flex-col gap-4">
        <MeSection title={tFeedback("reportTitle")} testid="feedback-section-report">
          <MeRow
            icon={BugIcon}
            label={tFeedback("openIssueLabel")}
            description={tFeedback("openIssueDescription")}
            value={<ExternalLinkIcon className="size-3.5" aria-hidden="true" />}
            href={ISSUES_URL}
            testid="feedback-row-open-issue"
          />
          <MeRow
            icon={ClipboardCopyIcon}
            label={copied ? tFeedback("copyLabelDone") : tFeedback("copyLabel")}
            description={tFeedback("copyDescription")}
            onClick={() => void copyDiagnostics()}
            testid="feedback-row-copy"
          />
        </MeSection>
        <MeSection title={tFeedback("diagnosticsTitle")} testid="feedback-section-diagnostics">
          <MeRow
            icon={HardDriveIcon}
            label={tFeedback("deviceInfoLabel")}
            description={tFeedback("deviceInfoDescription")}
            href="/me/device-info"
            testid="feedback-row-device-info"
          />
        </MeSection>
      </div>
    </SubPageShell>
  )
}
