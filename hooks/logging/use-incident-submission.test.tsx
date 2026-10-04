import { act, renderHook, waitFor } from "@testing-library/react"

import type { StoredDiagnosticConnection } from "@/lib/diagnostic-service/connection"
import type { InstallationIdentity } from "@/lib/diagnostic-service/installation-identity"

import type { DiagnosticIncidentSummary } from "./use-diagnostic-incidents"
import {
  useIncidentSubmission,
  type IncidentSubmissionDeps,
  type UseIncidentSubmissionOptions,
} from "./use-incident-submission"

const connection: StoredDiagnosticConnection = {
  baseUrl: "https://diag.example.com",
  tenantId: "tenant-1",
  projectId: "project-1",
  installationId: "install-1",
  autoSubmit: false,
  lastKnownRole: null,
}

const desktopIncident: DiagnosticIncidentSummary = {
  id: "crash-desktop",
  runtime: "desktop",
  source: "panic",
  capturedAt: "2026-08-20T00:00:00.000Z",
  state: "detected",
  sizeBytes: 100,
  artifacts: ["text", "metadata", "minidump"],
}

const mobileIncident: DiagnosticIncidentSummary = {
  id: "crash-mobile",
  runtime: "mobile",
  source: "ios-kscrash",
  capturedAt: "2026-08-20T00:00:00.000Z",
  state: "detected",
  sizeBytes: 200,
  artifacts: ["report"],
}

const identity: InstallationIdentity = {
  installationId: "inst_abc",
  publicKeyBase64: "cHVibGlj",
  sign: () => Promise.resolve("c2ln"),
}

function setup(overrides: {
  deps?: IncidentSubmissionDeps
  connection?: StoredDiagnosticConnection | null
}) {
  const onChanged = jest.fn(() => Promise.resolve())
  const onConfigure = jest.fn()
  const options: UseIncidentSubmissionOptions = {
    connection: overrides.connection === undefined ? connection : overrides.connection,
    accountId: "account-a",
    onChanged,
    onConfigure,
    deps: {
      desktopSupported: () => true,
      digest: () => Promise.resolve("a".repeat(64)),
      ...overrides.deps,
    },
  }
  const view = renderHook(() => useIncidentSubmission(options))
  return { ...view, onChanged, onConfigure }
}

describe("useIncidentSubmission", () => {
  it("reports itself unconfigured until a connection exists", () => {
    const { result } = setup({ connection: null })
    expect(result.current.configured).toBe(false)
    expect(result.current.supported).toBe(true)
  })

  it("reports itself unsupported on a shell with no submission path", async () => {
    const { result } = setup({
      deps: { desktopSupported: () => false, resolveRuntime: async () => null },
    })
    expect(result.current.checkingSupport).toBe(true)
    await waitFor(() => expect(result.current.checkingSupport).toBe(false))
    expect(result.current.supported).toBe(false)
  })

  it("is supported on a phone whose crash plugin answers the capability probe", async () => {
    const { result } = setup({
      deps: { desktopSupported: () => false, resolveRuntime: async () => "mobile" },
    })
    // Used to be `isTauri()`, which told every phone to go find a desktop.
    await waitFor(() => expect(result.current.supported).toBe(true))
  })

  it("passes the consent decisions to the native packager and refreshes after", async () => {
    const submitDesktop = jest.fn<
      ReturnType<NonNullable<IncidentSubmissionDeps["submitDesktop"]>>,
      Parameters<NonNullable<IncidentSubmissionDeps["submitDesktop"]>>
    >(async () => ({
      incidentId: "inc-1",
      supportCode: "ABC123",
      clientState: "processing",
      processingState: "received",
      serviceUrl: connection.baseUrl,
      submittedAt: "2026-08-20T00:00:00Z",
      includedMinidump: true,
      includedScreenshot: false,
      uploadedParts: 4,
      resumedParts: 0,
      screenshotUnavailable: true,
    }))
    const { result, onChanged } = setup({ deps: { submitDesktop } })

    act(() =>
      result.current.onSubmit(desktopIncident, {
        includeMinidump: true,
        includeScreenshot: true,
        description: "  I was exporting  ",
      })
    )
    await waitFor(() => expect(result.current.stateFor(desktopIncident).busy).toBe(false))

    expect(submitDesktop).toHaveBeenCalledWith(
      { baseUrl: connection.baseUrl, tenantId: "tenant-1", projectId: "project-1" },
      "crash-desktop",
      {
        includeMinidump: true,
        includeScreenshot: true,
        // Trimmed, and absent rather than an empty attachment when blank.
        description: "I was exporting",
      }
    )
    expect(result.current.stateFor(desktopIncident).lastOutcome).toEqual({
      uploadedParts: 4,
      resumedParts: 0,
      screenshotUnavailable: true,
    })
    expect(onChanged).toHaveBeenCalled()
    expect(result.current.stateFor(desktopIncident).errorCode).toBeNull()
  })

  it("omits a whitespace-only description entirely", async () => {
    const submitDesktop = jest.fn<
      ReturnType<NonNullable<IncidentSubmissionDeps["submitDesktop"]>>,
      Parameters<NonNullable<IncidentSubmissionDeps["submitDesktop"]>>
    >(async () => ({
      incidentId: "inc-1",
      supportCode: "",
      clientState: "processing",
      processingState: "received",
      serviceUrl: connection.baseUrl,
      submittedAt: "2026-08-20T00:00:00Z",
      includedMinidump: false,
      includedScreenshot: false,
      uploadedParts: 2,
      resumedParts: 0,
      screenshotUnavailable: false,
    }))
    const { result } = setup({ deps: { submitDesktop } })
    act(() =>
      result.current.onSubmit(desktopIncident, {
        includeMinidump: false,
        includeScreenshot: false,
        description: "   ",
      })
    )
    await waitFor(() => expect(result.current.stateFor(desktopIncident).busy).toBe(false))
    expect(submitDesktop.mock.calls[0]![2].description).toBeUndefined()
  })

  it("surfaces the failure code and leaves the list untouched", async () => {
    const submitDesktop = jest.fn(() => Promise.reject({ code: "ingest_disabled" }))
    const { result, onChanged } = setup({ deps: { submitDesktop } })
    act(() =>
      result.current.onSubmit(desktopIncident, {
        includeMinidump: false,
        includeScreenshot: false,
        description: "",
      })
    )
    await waitFor(() =>
      expect(result.current.stateFor(desktopIncident).errorCode).toBe("ingest_disabled")
    )
    // Nothing changed, so nothing to re-read — and the panel keeps the report.
    expect(onChanged).not.toHaveBeenCalled()
  })

  it("refuses to act at all without a connection", async () => {
    const submitDesktop = jest.fn()
    const { result } = setup({ connection: null, deps: { submitDesktop } })
    act(() =>
      result.current.onSubmit(desktopIncident, {
        includeMinidump: false,
        includeScreenshot: false,
        description: "",
      })
    )
    await waitFor(() =>
      expect(result.current.stateFor(desktopIncident).errorCode).toBe("not_configured")
    )
    expect(submitDesktop).not.toHaveBeenCalled()
  })

  it("routes withdraw, delete and refresh through the native commands", async () => {
    const withdrawDesktop = jest.fn(async () => ({}) as never)
    const deleteDesktop = jest.fn(async () => undefined)
    const refreshDesktop = jest.fn(async () => ({}) as never)
    const { result, onChanged } = setup({
      deps: { withdrawDesktop, deleteDesktop, refreshDesktop },
    })

    act(() => result.current.onWithdraw(desktopIncident))
    await waitFor(() => expect(withdrawDesktop).toHaveBeenCalled())
    act(() => result.current.onDeleteRemote(desktopIncident))
    await waitFor(() => expect(deleteDesktop).toHaveBeenCalled())
    act(() => result.current.onRefresh(desktopIncident))
    await waitFor(() => expect(refreshDesktop).toHaveBeenCalled())
    expect(onChanged).toHaveBeenCalledTimes(3)
  })

  it("refuses remote actions for a phone's report, which has no service incident id", async () => {
    const withdrawDesktop = jest.fn(async () => ({}) as never)
    const deleteDesktop = jest.fn(async () => undefined)
    const refreshDesktop = jest.fn(async () => ({}) as never)
    const { result, onChanged } = setup({
      deps: { withdrawDesktop, deleteDesktop, refreshDesktop },
    })
    act(() => result.current.onWithdraw(mobileIncident))
    await waitFor(() =>
      expect(result.current.stateFor(mobileIncident).errorCode).toBe("desktop_only")
    )
    act(() => result.current.onDeleteRemote(mobileIncident))
    act(() => result.current.onRefresh(mobileIncident))
    await waitFor(() => expect(result.current.stateFor(mobileIncident).busy).toBe(false))
    expect(withdrawDesktop).not.toHaveBeenCalled()
    expect(deleteDesktop).not.toHaveBeenCalled()
    expect(refreshDesktop).not.toHaveBeenCalled()
    expect(onChanged).not.toHaveBeenCalled()
  })

  it("keeps each incident's busy flag, failure and outcome to itself", async () => {
    let release: (() => void) | null = null
    const submitDesktop = jest.fn(
      () =>
        new Promise<never>((_resolve, reject) => {
          release = () => reject({ code: "ingest_disabled" })
        })
    )
    const other: DiagnosticIncidentSummary = { ...desktopIncident, id: "crash-other" }
    const { result } = setup({ deps: { submitDesktop } })
    act(() =>
      result.current.onSubmit(desktopIncident, {
        includeMinidump: false,
        includeScreenshot: false,
        description: "",
      })
    )
    await waitFor(() => expect(result.current.stateFor(desktopIncident).busy).toBe(true))
    // B never inherits A's in-flight state…
    expect(result.current.stateFor(other)).toEqual({
      busy: false,
      errorCode: null,
      lastOutcome: null,
    })
    act(() => release?.())
    await waitFor(() =>
      expect(result.current.stateFor(desktopIncident).errorCode).toBe("ingest_disabled")
    )
    // …nor A's failure.
    expect(result.current.stateFor(other).errorCode).toBeNull()
    // A mobile incident with the same id is a different key.
    expect(
      result.current.stateFor({ id: desktopIncident.id, runtime: "mobile" }).errorCode
    ).toBeNull()
  })

  it("keeps the last outcome when a later status refresh succeeds", async () => {
    const submitDesktop = jest.fn(async () => ({
      incidentId: "inc-1",
      supportCode: "ABC123",
      clientState: "processing",
      processingState: "received",
      serviceUrl: connection.baseUrl,
      submittedAt: "2026-08-20T00:00:00Z",
      includedMinidump: false,
      includedScreenshot: false,
      uploadedParts: 3,
      resumedParts: 1,
      screenshotUnavailable: false,
    }))
    const refreshDesktop = jest.fn(async () => ({}) as never)
    const { result } = setup({ deps: { submitDesktop, refreshDesktop } })
    act(() =>
      result.current.onSubmit(desktopIncident, {
        includeMinidump: false,
        includeScreenshot: false,
        description: "",
      })
    )
    await waitFor(() =>
      expect(result.current.stateFor(desktopIncident).lastOutcome?.uploadedParts).toBe(3)
    )
    act(() => result.current.onRefresh(desktopIncident))
    await waitFor(() => expect(refreshDesktop).toHaveBeenCalled())
    await waitFor(() => expect(result.current.stateFor(desktopIncident).busy).toBe(false))
    expect(result.current.stateFor(desktopIncident).lastOutcome?.uploadedParts).toBe(3)
  })

  describe("mobile", () => {
    function mobileDeps(overrides: Partial<IncidentSubmissionDeps> = {}) {
      const responses: Response[] = [
        new Response(JSON.stringify({ incident: { id: "inc-m" }, created: true }), { status: 201 }),
        new Response(JSON.stringify({ partNumber: 1 }), { status: 201 }),
        new Response(JSON.stringify({ supportCode: "MOB-1", clientState: "processing" }), {
          status: 200,
        }),
      ]
      const fetchImpl = jest.fn<
        Promise<Response>,
        Parameters<NonNullable<IncidentSubmissionDeps["fetchImpl"]>>
      >(async () => responses.shift() ?? new Response("{}", { status: 200 }))
      return {
        fetchImpl,
        deps: {
          fetchImpl,
          loadIdentity: jest.fn(async () => identity),
          exchangeGrant: jest.fn(async () => ({
            grant: "g",
            role: "uploader" as const,
            expiresInSeconds: 900,
          })),
          readMobile: jest.fn(async () => ({
            kind: "ok" as const,
            value: {
              incidentId: "crash-mobile",
              source: "ios-kscrash" as const,
              detectedAt: 0,
              state: "detected",
              sizeBytes: 200,
              schemaVersion: "cognia-mobile-crash-v1" as const,
              redactionVersion: "1",
              payload: { stackFrames: ["a"] },
            },
          })),
          recordMobileReceipt: jest.fn(async () => ({ kind: "ok" as const })),
          ...overrides,
        } satisfies IncidentSubmissionDeps,
      }
    }

    it("uploads the redacted report and writes the receipt back to the plugin", async () => {
      const { deps } = mobileDeps()
      const { result, onChanged } = setup({ deps })

      act(() =>
        result.current.onSubmit(mobileIncident, {
          includeMinidump: false,
          includeScreenshot: false,
          description: "",
        })
      )
      await waitFor(() => expect(result.current.stateFor(mobileIncident).busy).toBe(false))

      expect(result.current.stateFor(mobileIncident).errorCode).toBeNull()
      // `markReceipt` had no production caller before this: the mobile
      // lifecycle could never advance past `detected` either.
      expect(deps.recordMobileReceipt).toHaveBeenCalledWith("crash-mobile", "MOB-1", "processing")
      expect(result.current.stateFor(mobileIncident).lastOutcome).toEqual({
        uploadedParts: 1,
        resumedParts: 0,
        screenshotUnavailable: false,
      })
      expect(onChanged).toHaveBeenCalled()
    })

    it("sends a typed description as a second scannable part", async () => {
      const { deps, fetchImpl } = mobileDeps()
      const { result } = setup({ deps })
      act(() =>
        result.current.onSubmit(mobileIncident, {
          includeMinidump: false,
          includeScreenshot: false,
          description: "the app closed while syncing",
        })
      )
      await waitFor(() => expect(result.current.stateFor(mobileIncident).busy).toBe(false))
      const parts = fetchImpl.mock.calls.filter(([url]) => String(url).includes("/parts/"))
      expect(parts).toHaveLength(2)
      expect(String(parts[1]![0])).toContain("/parts/2")
    })

    it("reports an unsupported WebView instead of an opaque signature failure", async () => {
      const { deps } = mobileDeps({ loadIdentity: jest.fn(async () => null) })
      const { result } = setup({ deps })
      act(() =>
        result.current.onSubmit(mobileIncident, {
          includeMinidump: false,
          includeScreenshot: false,
          description: "",
        })
      )
      await waitFor(() =>
        expect(result.current.stateFor(mobileIncident).errorCode).toBe(
          "installation_proof_unsupported"
        )
      )
    })

    it("stops before uploading when the plugin cannot read the report", async () => {
      const { deps, fetchImpl } = mobileDeps({
        readMobile: jest.fn(async () => ({ kind: "unsupported" as const })),
      })
      const { result } = setup({ deps })
      act(() =>
        result.current.onSubmit(mobileIncident, {
          includeMinidump: false,
          includeScreenshot: false,
          description: "",
        })
      )
      await waitFor(() =>
        expect(result.current.stateFor(mobileIncident).errorCode).toBe("report_not_found")
      )
      expect(fetchImpl).not.toHaveBeenCalled()
    })
  })
})
