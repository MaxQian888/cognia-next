"use client"

/**
 * "Send to the diagnostic service" as a support-report channel.
 *
 * The report dialog could copy a report, download it, or open a pre-filled
 * issue on a public tracker. For anyone running their own diagnostic service
 * that last option is the wrong shape: the report is exactly the kind of thing
 * the service exists to receive, and a public issue tracker is exactly where
 * its contents should not go.
 *
 * The report travels as a single `events` part rather than a package: it is
 * already assembled Markdown, it has passed the client-side redaction the
 * dialog applies, and the service re-scans every part on the way in. The
 * artifact hash is the report's own digest, so pressing the button twice
 * resumes one incident instead of filing two.
 */

import type { DiagnosticServiceClient } from "@/lib/diagnostic-service/client"
import type { SupportReport, SupportReportChannelSpec } from "./types"

export interface DiagnosticReportChannelOptions {
  /** Null when no service is configured — the channel then reports itself unavailable. */
  client: DiagnosticServiceClient | null
  /** Reported as the incident's module, so triage can tell these from crashes. */
  module?: string
  digest?: (bytes: Uint8Array) => Promise<string>
  /** Called with the support code so the dialog can show it. */
  onSubmitted?: (supportCode: string) => void
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

export const DIAGNOSTIC_REPORT_CHANNEL_ID = "diagnostic-service"

export function createDiagnosticReportChannel(
  options: DiagnosticReportChannelOptions
): SupportReportChannelSpec {
  const digest = options.digest ?? sha256Hex
  return {
    id: DIAGNOSTIC_REPORT_CHANNEL_ID,
    labelKey: DIAGNOSTIC_REPORT_CHANNEL_ID,
    isAvailable: () => options.client !== null,
    deliver: async (report: SupportReport) => {
      const client = options.client
      if (!client) throw new Error("not_configured")
      const bytes = new TextEncoder().encode(report.markdown)
      const hash = await digest(bytes)
      const created = await client.createIncident({
        artifactHash: hash,
        // The report carries no build metadata of its own; the section list is
        // what distinguishes one report shape from another in triage.
        buildId: report.generatedAt.slice(0, 10),
        platform: "report",
        module: options.module ?? "cognia-support-report",
        exception: report.sectionIds.join(",") || "support_report",
        attachmentCount: 1,
        eventCount: 1,
        totalBytes: bytes.byteLength,
        largestAttachmentBytes: bytes.byteLength,
        largestMinidumpBytes: 0,
        consent: true,
      })
      await client.uploadPart(created.incident.id, 1, bytes, hash, "events")
      const receipt = await client.completeUpload(created.incident.id)
      options.onSubmitted?.(receipt.supportCode)
    },
  }
}
