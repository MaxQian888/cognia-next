jest.mock("./mobile-submit", () => ({
  ...jest.requireActual("./mobile-submit"),
  submitMobileCrashReport: jest.fn(),
}))

import type { StoredDiagnosticConnection } from "./connection"
import { SubmissionCodeError, submitMobileCrashReport } from "./mobile-submit"
import {
  DEFAULT_SUBMISSION_CONSENT,
  submitIncidentReport,
  toNativeConnection,
  type SubmitIncidentDeps,
} from "./submit-incident"

const submitMobileMock = submitMobileCrashReport as jest.MockedFunction<
  typeof submitMobileCrashReport
>

const connection: StoredDiagnosticConnection = {
  baseUrl: "https://diag.example.com",
  tenantId: "tenant-1",
  projectId: "project-1",
  installationId: "install-1",
  autoSubmit: false,
  lastKnownRole: null,
}

const fetchImpl = jest.fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>()

type SubmitDesktop = NonNullable<SubmitIncidentDeps["submitDesktop"]>

beforeEach(() => {
  submitMobileMock.mockReset()
})

describe("toNativeConnection", () => {
  it("passes only the facts the native side takes", () => {
    expect(toNativeConnection(connection)).toEqual({
      baseUrl: "https://diag.example.com",
      tenantId: "tenant-1",
      projectId: "project-1",
    })
  })
})

describe("submitIncidentReport", () => {
  it("packages a desktop report natively with exactly the consent given", async () => {
    const submitDesktop = jest.fn<ReturnType<SubmitDesktop>, Parameters<SubmitDesktop>>(
      async () => ({
        incidentId: "inc-1",
        supportCode: "DESK-1",
        clientState: "processing",
        processingState: "received",
        serviceUrl: connection.baseUrl,
        submittedAt: "2026-10-03T00:00:00.000Z",
        includedMinidump: true,
        includedScreenshot: false,
        uploadedParts: 3,
        resumedParts: 1,
        screenshotUnavailable: false,
      })
    )
    const result = await submitIncidentReport(
      {
        connection,
        accountId: "account-a",
        incident: { id: "stem-1", runtime: "desktop", source: "panic" },
        consent: { includeMinidump: true, includeScreenshot: false, description: "  export  " },
        fetchImpl,
      },
      { submitDesktop }
    )
    expect(submitDesktop).toHaveBeenCalledWith(toNativeConnection(connection), "stem-1", {
      includeMinidump: true,
      includeScreenshot: false,
      description: "export",
    })
    expect(result).toEqual({
      uploadedParts: 3,
      resumedParts: 1,
      screenshotUnavailable: false,
      supportCode: "DESK-1",
      clientState: "processing",
    })
    expect(submitMobileMock).not.toHaveBeenCalled()
  })

  it("omits a blank description on the desktop path", async () => {
    const submitDesktop = jest.fn<ReturnType<SubmitDesktop>, Parameters<SubmitDesktop>>(
      async () => ({}) as Awaited<ReturnType<SubmitDesktop>>
    )
    await submitIncidentReport(
      {
        connection,
        accountId: null,
        incident: { id: "stem-1", runtime: "desktop", source: "native" },
        consent: DEFAULT_SUBMISSION_CONSENT,
        fetchImpl,
      },
      { submitDesktop }
    )
    expect(submitDesktop.mock.calls[0][2].description).toBeUndefined()
  })

  it("uploads a mobile report through the plugin path with the source as exception", async () => {
    submitMobileMock.mockResolvedValue({
      uploadedParts: 1,
      resumedParts: 0,
      screenshotUnavailable: false,
      supportCode: "MOB-1",
      clientState: "processing",
    })
    const result = await submitIncidentReport({
      connection,
      accountId: "account-a",
      incident: { id: "m-1", runtime: "mobile", source: "ios-kscrash" },
      consent: { includeMinidump: false, includeScreenshot: false, description: "hi" },
      fetchImpl,
    })
    expect(submitMobileMock).toHaveBeenCalledWith(
      {
        connection,
        accountId: "account-a",
        incidentId: "m-1",
        exception: "ios-kscrash",
        description: "hi",
        fetchImpl,
      },
      {}
    )
    expect(result.supportCode).toBe("MOB-1")
  })

  it("refuses a mobile report without an account to mint the grant from", async () => {
    await expect(
      submitIncidentReport({
        connection,
        accountId: null,
        incident: { id: "m-1", runtime: "mobile", source: "ios-kscrash" },
        consent: DEFAULT_SUBMISSION_CONSENT,
        fetchImpl,
      })
    ).rejects.toEqual(new SubmissionCodeError("not_configured"))
    expect(submitMobileMock).not.toHaveBeenCalled()
  })

  it("keeps the default consent free of every optional attachment", () => {
    expect(DEFAULT_SUBMISSION_CONSENT).toEqual({
      includeMinidump: false,
      includeScreenshot: false,
      description: "",
    })
    expect(Object.isFrozen(DEFAULT_SUBMISSION_CONSENT)).toBe(true)
  })
})
