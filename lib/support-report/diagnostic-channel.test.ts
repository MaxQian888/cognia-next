import type { DiagnosticServiceClient } from "@/lib/diagnostic-service/client"

import { createDiagnosticReportChannel, DIAGNOSTIC_REPORT_CHANNEL_ID } from "./diagnostic-channel"
import type { SupportReport } from "./types"

const report: SupportReport = {
  title: "Crash while exporting",
  markdown: "### App\n\nversion 1.2.3\n",
  filename: "report.md",
  generatedAt: "2026-08-20T10:11:12.000Z",
  sectionIds: ["app", "error"],
}

function stubClient() {
  return {
    createIncident: jest.fn(async () => ({ incident: { id: "inc-1" }, created: true })),
    uploadPart: jest.fn(async () => ({ partNumber: 1 })),
    completeUpload: jest.fn(async () => ({ supportCode: "SUP-9" })),
  } as unknown as DiagnosticServiceClient
}

describe("createDiagnosticReportChannel", () => {
  it("reports itself unavailable until a service is configured", () => {
    expect(createDiagnosticReportChannel({ client: null }).isAvailable()).toBe(false)
    expect(createDiagnosticReportChannel({ client: stubClient() }).isAvailable()).toBe(true)
    expect(createDiagnosticReportChannel({ client: null }).id).toBe(DIAGNOSTIC_REPORT_CHANNEL_ID)
  })

  it("refuses to deliver without a client rather than silently succeeding", async () => {
    // A caller that believed the report was sent would stop trying.
    await expect(createDiagnosticReportChannel({ client: null }).deliver(report)).rejects.toThrow()
  })

  it("uploads the report as one events part keyed on its own digest", async () => {
    const client = stubClient()
    const onSubmitted = jest.fn()
    await createDiagnosticReportChannel({
      client,
      digest: async () => "d".repeat(64),
      onSubmitted,
    }).deliver(report)

    expect(client.createIncident).toHaveBeenCalledWith(
      expect.objectContaining({
        artifactHash: "d".repeat(64),
        module: "cognia-support-report",
        platform: "report",
        // The section list is what distinguishes one report shape from
        // another once it reaches triage.
        exception: "app,error",
        eventCount: 1,
        attachmentCount: 1,
        largestMinidumpBytes: 0,
        consent: true,
      })
    )
    const [, partNumber, bytes, hash, kind] = (client.uploadPart as jest.Mock).mock.calls[0]
    expect(partNumber).toBe(1)
    expect(new TextDecoder().decode(bytes as Uint8Array)).toBe(report.markdown)
    expect(hash).toBe("d".repeat(64))
    // `events`, not `attachment`: it is the kind the service scans for frames
    // and the one that keeps a report out of the binary-artifact path.
    expect(kind).toBe("events")
    expect(onSubmitted).toHaveBeenCalledWith("SUP-9")
  })

  it("keys on the report digest so pressing the button twice resumes one incident", async () => {
    const client = stubClient()
    const channel = createDiagnosticReportChannel({ client })
    await channel.deliver(report)
    await channel.deliver(report)
    const [first, second] = (client.createIncident as jest.Mock).mock.calls
    expect(first[0].artifactHash).toBe(second[0].artifactHash)
    expect(first[0].artifactHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it("falls back to a stable exception when the report contributed no sections", async () => {
    const client = stubClient()
    await createDiagnosticReportChannel({ client }).deliver({ ...report, sectionIds: [] })
    expect((client.createIncident as jest.Mock).mock.calls[0][0].exception).toBe("support_report")
  })

  it("lets the caller label the module it files under", async () => {
    const client = stubClient()
    await createDiagnosticReportChannel({ client, module: "cognia-mobile-feedback" }).deliver(
      report
    )
    expect((client.createIncident as jest.Mock).mock.calls[0][0].module).toBe(
      "cognia-mobile-feedback"
    )
  })
})
