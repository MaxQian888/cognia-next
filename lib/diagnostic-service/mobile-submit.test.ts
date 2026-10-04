/** @jest-environment jsdom */

import type { StoredDiagnosticConnection } from "./connection"
import type { InstallationIdentity } from "./installation-identity"
import {
  sha256Hex,
  submitMobileCrashReport,
  SubmissionCodeError,
  type MobileSubmitDeps,
} from "./mobile-submit"

const connection: StoredDiagnosticConnection = {
  baseUrl: "https://diag.example.com",
  tenantId: "tenant-1",
  projectId: "project-1",
  installationId: "install-1",
  autoSubmit: false,
  lastKnownRole: null,
}

const identity: InstallationIdentity = {
  installationId: "inst_abc",
  publicKeyBase64: "cHVibGlj",
  sign: () => Promise.resolve("c2ln"),
}

function harness(overrides: Partial<MobileSubmitDeps> = {}) {
  const responses: Response[] = [
    new Response(JSON.stringify({ incident: { id: "inc-m" }, created: true }), { status: 201 }),
    new Response(JSON.stringify({ partNumber: 1 }), { status: 201 }),
    new Response(JSON.stringify({ partNumber: 2 }), { status: 201 }),
    new Response(JSON.stringify({ supportCode: "MOB-1", clientState: "processing" }), {
      status: 200,
    }),
  ]
  const fetchImpl = jest.fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>(async (input) =>
    // The description part is optional, so the third canned answer is only
    // consumed by a second upload; completion answers whichever comes next.
    String(input).endsWith("/complete")
      ? responses[responses.length - 1]!
      : (responses.shift() ?? new Response("{}", { status: 200 }))
  )
  const deps: MobileSubmitDeps = {
    digest: () => Promise.resolve("a".repeat(64)),
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
  }
  return { fetchImpl, deps }
}

function input(fetchImpl: jest.Mock, description = "") {
  return {
    connection,
    accountId: "account-a",
    incidentId: "crash-mobile",
    exception: "ios-kscrash",
    description,
    fetchImpl,
  }
}

describe("submitMobileCrashReport", () => {
  it("uploads the redacted report as an events part and records the receipt", async () => {
    const { fetchImpl, deps } = harness()
    const result = await submitMobileCrashReport(input(fetchImpl), deps)
    expect(result).toEqual({
      uploadedParts: 1,
      resumedParts: 0,
      screenshotUnavailable: false,
      supportCode: "MOB-1",
      clientState: "processing",
    })
    const part = fetchImpl.mock.calls.find(([url]) => String(url).includes("/parts/1"))
    expect(new Headers(part![1]!.headers).get("x-artifact-kind")).toBe("events")
    expect(deps.recordMobileReceipt).toHaveBeenCalledWith("crash-mobile", "MOB-1", "processing")
  })

  it("adds a trimmed description as a second attachment part", async () => {
    const { fetchImpl, deps } = harness()
    const result = await submitMobileCrashReport(input(fetchImpl, "  closed while syncing "), deps)
    expect(result.uploadedParts).toBe(2)
    const second = fetchImpl.mock.calls.find(([url]) => String(url).includes("/parts/2"))
    expect(new Headers(second![1]!.headers).get("x-artifact-kind")).toBe("attachment")
  })

  it("refuses with a translatable code when the WebView cannot sign", async () => {
    const { fetchImpl, deps } = harness({ loadIdentity: jest.fn(async () => null) })
    await expect(submitMobileCrashReport(input(fetchImpl), deps)).rejects.toMatchObject({
      code: "installation_proof_unsupported",
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("stops before creating an incident when the plugin cannot read the report", async () => {
    const { fetchImpl, deps } = harness({
      readMobile: jest.fn(async () => ({ kind: "unsupported" as const })),
    })
    const failure = submitMobileCrashReport(input(fetchImpl), deps)
    await expect(failure).rejects.toBeInstanceOf(SubmissionCodeError)
    await expect(failure).rejects.toMatchObject({ code: "report_not_found" })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe("sha256Hex", () => {
  it("hashes bytes to lowercase hex", async () => {
    const subtle = { digest: jest.fn(async () => new Uint8Array([0, 15, 255]).buffer) }
    const original = globalThis.crypto
    Object.defineProperty(globalThis, "crypto", { value: { subtle }, configurable: true })
    try {
      await expect(sha256Hex(new Uint8Array([1]))).resolves.toBe("000fff")
    } finally {
      Object.defineProperty(globalThis, "crypto", { value: original, configurable: true })
    }
  })
})
