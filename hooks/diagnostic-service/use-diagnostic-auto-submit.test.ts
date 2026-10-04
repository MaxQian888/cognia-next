/** @jest-environment jsdom */

import { renderHook, waitFor } from "@testing-library/react"

jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: (selector: (state: { unlockedAccountId: string | null }) => unknown) =>
    selector({ unlockedAccountId: "account-a" }),
}))

import type { AutoSubmitIncident, AutoSubmitStoreDeps } from "@/lib/diagnostic-service/auto-submit"
import type { StoredDiagnosticConnection } from "@/lib/diagnostic-service/connection"
import type { SubmitIncidentResult } from "@/lib/diagnostic-service/submit-incident"

import {
  useDiagnosticAutoSubmit,
  type DiagnosticAutoSubmitDeps,
} from "./use-diagnostic-auto-submit"

function memoryStore(): AutoSubmitStoreDeps {
  const map = new Map<string, string>()
  return {
    local: {
      getItem: (key) => map.get(key) ?? null,
      setItem: (key, value) => void map.set(key, value),
      removeItem: (key) => void map.delete(key),
    },
  }
}

const connection: StoredDiagnosticConnection = {
  baseUrl: "https://diag.example.com",
  tenantId: "tenant-1",
  projectId: "project-1",
  installationId: "install-1",
  autoSubmit: true,
  autoSubmitSince: "2026-10-01T00:00:00.000Z",
  lastKnownRole: null,
}

const report: AutoSubmitIncident = {
  id: "crash-1",
  runtime: "desktop",
  source: "panic",
  capturedAt: "2026-10-02T00:00:00.000Z",
  state: "detected",
}

const receipt: SubmitIncidentResult = {
  uploadedParts: 2,
  resumedParts: 0,
  screenshotUnavailable: false,
  supportCode: "SUP-9",
  clientState: "processing",
}

function deps(over: Partial<DiagnosticAutoSubmitDeps> = {}): DiagnosticAutoSubmitDeps {
  return {
    loadConnection: jest.fn(() => connection),
    saveConnection: jest.fn(),
    resolveRuntime: jest.fn(async () => "desktop" as const),
    listIncidents: jest.fn(async () => [report]),
    submit: jest.fn(async () => receipt),
    fetchImpl: jest.fn(),
    store: memoryStore(),
    now: () => new Date("2026-10-03T00:00:00.000Z"),
    ...over,
  }
}

describe("useDiagnosticAutoSubmit", () => {
  it("sends a new report once per launch and hands back its receipt", async () => {
    const onOutcomes = jest.fn()
    const seams = deps()
    const { result } = renderHook(() => useDiagnosticAutoSubmit({ onOutcomes, deps: seams }))
    await waitFor(() => expect(result.current).toBe("done"))
    expect(seams.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "account-a",
        connection,
        incident: report,
        consent: { includeMinidump: false, includeScreenshot: false, description: "" },
      })
    )
    expect(onOutcomes).toHaveBeenCalledWith([{ kind: "submitted", incident: report, receipt }])
  })

  it("does not touch the device when the switch is off", async () => {
    const onOutcomes = jest.fn()
    const seams = deps({ loadConnection: jest.fn(() => ({ ...connection, autoSubmit: false })) })
    const { result } = renderHook(() => useDiagnosticAutoSubmit({ onOutcomes, deps: seams }))
    // Give the effect a chance to run.
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(result.current).toBe("idle")
    expect(seams.resolveRuntime).not.toHaveBeenCalled()
    expect(seams.listIncidents).not.toHaveBeenCalled()
    expect(onOutcomes).not.toHaveBeenCalled()
  })

  it("stops at the runtime probe where nothing can submit (the plain browser)", async () => {
    const onOutcomes = jest.fn()
    const seams = deps({ resolveRuntime: jest.fn(async () => null) })
    const { result } = renderHook(() => useDiagnosticAutoSubmit({ onOutcomes, deps: seams }))
    await waitFor(() => expect(result.current).toBe("done"))
    expect(seams.listIncidents).not.toHaveBeenCalled()
    expect(onOutcomes).not.toHaveBeenCalled()
  })

  it("stays inert without an unlocked account", async () => {
    const seams = deps()
    const { result } = renderHook(() =>
      useDiagnosticAutoSubmit({ onOutcomes: jest.fn(), deps: { ...seams, accountId: null } })
    )
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(result.current).toBe("idle")
    expect(seams.loadConnection).not.toHaveBeenCalled()
  })

  it("settles quietly when the reports cannot be listed", async () => {
    const onOutcomes = jest.fn()
    const seams = deps({
      listIncidents: jest.fn(async () => {
        throw new Error("crash directory unreadable")
      }),
    })
    const { result } = renderHook(() => useDiagnosticAutoSubmit({ onOutcomes, deps: seams }))
    await waitFor(() => expect(result.current).toBe("done"))
    expect(seams.submit).not.toHaveBeenCalled()
    expect(onOutcomes).not.toHaveBeenCalled()
  })

  it("reports nothing when there was nothing new to send", async () => {
    const onOutcomes = jest.fn()
    const seams = deps({ listIncidents: jest.fn(async () => []) })
    const { result } = renderHook(() => useDiagnosticAutoSubmit({ onOutcomes, deps: seams }))
    await waitFor(() => expect(result.current).toBe("done"))
    expect(onOutcomes).not.toHaveBeenCalled()
  })
})
