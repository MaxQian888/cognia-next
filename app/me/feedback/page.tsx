"use client"

/**
 * Feedback / diagnostics entry. Provides:
 *   • "Report a problem" — the unified support-report dialog (description,
 *     redacted sections, copy / download / pre-filled GitHub issue).
 *   • One-tap copy of the default redacted report onto the clipboard.
 *   • Direct link to the issue tracker for feature requests.
 *   • Permission / device check shortcut into `/me/device-info`.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { BugIcon, ClipboardCopyIcon, ExternalLinkIcon, HardDriveIcon } from "lucide-react"
import { toast } from "sonner"

import { MeRow } from "@/components/mobile/me/me-row"
import { MeSection } from "@/components/mobile/me/me-section"
import { SubPageShell } from "@/components/mobile/me/sub-page-shell"
import { ReportProblemDialog } from "@/components/support/report-problem-dialog"
import { buildSupportReport } from "@/lib/support-report/build"
import { deliverSupportReport } from "@/lib/support-report/channels"
import { resolveIssueTrackerUrl, resolveNewIssueEndpoint } from "@/lib/support-report/issue-url"
import type { SupportReportContext } from "@/lib/support-report/types"

export default function MobileFeedbackPage() {
  const t = useTranslations("mobile.me")
  const tFeedback = useTranslations("mobile.me.feedback")
  const [reportOpen, setReportOpen] = useState(false)
  const [copying, setCopying] = useState(false)
  const reportContext = useMemo<Omit<SupportReportContext, "description">>(
    () => ({ surface: "mobile" }),
    []
  )

  const copyDiagnostics = async () => {
    if (copying) return
    setCopying(true)
    try {
      const report = await buildSupportReport({ context: reportContext })
      await deliverSupportReport("copy", report)
      toast.success(tFeedback("copyToast"))
    } catch {
      toast.error(tFeedback("copyError"))
    } finally {
      setCopying(false)
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
            label={tFeedback("reportProblemLabel")}
            description={tFeedback("reportProblemDescription")}
            onClick={() => setReportOpen(true)}
            testid="feedback-row-report-problem"
          />
          <MeRow
            icon={ClipboardCopyIcon}
            label={tFeedback("copyLabel")}
            description={tFeedback("copyDescription")}
            onClick={() => void copyDiagnostics()}
            testid="feedback-row-copy"
          />
          <MeRow
            icon={ExternalLinkIcon}
            label={tFeedback("openIssueLabel")}
            description={tFeedback("openIssueDescription")}
            href={resolveNewIssueEndpoint(resolveIssueTrackerUrl())}
            testid="feedback-row-open-issue"
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
      <ReportProblemDialog context={reportContext} open={reportOpen} onOpenChange={setReportOpen} />
    </SubPageShell>
  )
}
