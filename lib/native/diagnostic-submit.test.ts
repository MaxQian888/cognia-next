/**
 * @jest-environment node
 *
 * Tests for native/diagnostic-submit — invoke wrappers for the Rust crash
 * submission commands. Off the desktop runtime they must refuse rather than
 * silently pretend, because a caller that believes a report was sent will
 * delete the local copy.
 */

import { invoke } from "@tauri-apps/api/core"

let isTauriValue = false
jest.mock("@/lib/tauri", () => ({
  isTauri: () => isTauriValue,
}))

import {
  canSubmitDiagnostics,
  deleteSubmission,
  DiagnosticSubmitError,
  listSubmissionRecords,
  refreshSubmission,
  submitCrashReport,
  withdrawSubmission,
  type DiagnosticConnectionInput,
  type SubmissionRecord,
} from "./diagnostic-submit"

const mockedInvoke = invoke as unknown as jest.Mock

const connection: DiagnosticConnectionInput = {
  baseUrl: "https://diag.example.com",
  tenantId: "tenant-1",
  projectId: "project-1",
}

const record: SubmissionRecord = {
  incidentId: "inc-1",
  supportCode: "ABC123",
  clientState: "processing",
  processingState: "received",
  serviceUrl: "https://diag.example.com",
  submittedAt: "2026-08-20T00:00:00Z",
  includedMinidump: false,
  includedScreenshot: false,
}

beforeEach(() => {
  isTauriValue = false
  mockedInvoke.mockReset()
})

describe("off the desktop runtime", () => {
  it("reports that it cannot submit and refuses every mutation", async () => {
    expect(canSubmitDiagnostics()).toBe(false)
    await expect(
      submitCrashReport(connection, "crash-a", {
        includeMinidump: false,
        includeScreenshot: false,
      })
    ).rejects.toMatchObject({ code: "desktop_only" })
    await expect(refreshSubmission(connection, "crash-a")).rejects.toMatchObject({
      code: "desktop_only",
    })
    await expect(withdrawSubmission(connection, "crash-a")).rejects.toMatchObject({
      code: "desktop_only",
    })
    await expect(deleteSubmission(connection, "crash-a")).rejects.toMatchObject({
      code: "desktop_only",
    })
    expect(mockedInvoke).not.toHaveBeenCalled()
  })

  it("still answers the read-only listing with an empty map", async () => {
    // The list is merged into a report view; failing here would take the whole
    // list down for a shell that simply has no submissions.
    await expect(listSubmissionRecords()).resolves.toEqual({})
    expect(mockedInvoke).not.toHaveBeenCalled()
  })
})

describe("on the desktop runtime", () => {
  beforeEach(() => {
    isTauriValue = true
  })

  it("passes the connection and consent through verbatim", async () => {
    mockedInvoke.mockResolvedValue({
      ...record,
      uploadedParts: 3,
      resumedParts: 0,
      screenshotUnavailable: false,
    })
    const outcome = await submitCrashReport(connection, "crash-a", {
      includeMinidump: true,
      includeScreenshot: true,
      description: "I was exporting a workflow",
    })
    expect(mockedInvoke).toHaveBeenCalledWith("crash_submit_report", {
      connection,
      stem: "crash-a",
      consent: {
        includeMinidump: true,
        includeScreenshot: true,
        description: "I was exporting a workflow",
      },
    })
    expect(outcome.uploadedParts).toBe(3)
    expect(outcome.screenshotUnavailable).toBe(false)
  })

  it("turns the native error string into a typed code", async () => {
    mockedInvoke.mockRejectedValue("ingest_disabled")
    const error = await submitCrashReport(connection, "crash-a", {
      includeMinidump: false,
      includeScreenshot: false,
    }).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(DiagnosticSubmitError)
    expect((error as DiagnosticSubmitError).isIngestDisabled).toBe(true)
    expect((error as DiagnosticSubmitError).isUnavailable).toBe(false)
  })

  it("recognizes an unreachable service so the caller can keep the report", async () => {
    mockedInvoke.mockRejectedValue("network_unavailable")
    const error = (await withdrawSubmission(connection, "crash-a").catch(
      (cause: unknown) => cause
    )) as DiagnosticSubmitError
    expect(error.isUnavailable).toBe(true)
    expect(error.isIngestDisabled).toBe(false)
  })

  it("does not lose a non-string rejection", async () => {
    mockedInvoke.mockRejectedValue(new Error("bridge exploded"))
    await expect(deleteSubmission(connection, "crash-a")).rejects.toMatchObject({
      code: "bridge exploded",
    })
    mockedInvoke.mockRejectedValue({ weird: true })
    await expect(deleteSubmission(connection, "crash-a")).rejects.toMatchObject({
      code: "submission_failed",
    })
  })

  it("swallows a listing failure rather than breaking the report list", async () => {
    mockedInvoke.mockRejectedValue("receipt:io error")
    await expect(listSubmissionRecords()).resolves.toEqual({})
  })

  it("returns the refreshed record so the caller can re-render the lifecycle", async () => {
    mockedInvoke.mockResolvedValue({ ...record, clientState: "accepted" })
    await expect(refreshSubmission(connection, "crash-a")).resolves.toMatchObject({
      clientState: "accepted",
    })
    expect(mockedInvoke).toHaveBeenCalledWith("crash_refresh_submission", {
      connection,
      stem: "crash-a",
    })
  })
})
