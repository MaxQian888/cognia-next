import { act, renderHook, waitFor } from "@testing-library/react"

import type { SubmissionRecord } from "@/lib/native/diagnostic-submit"

import {
  countActionableIncidents,
  isActionableIncident,
  listDiagnosticIncidents,
  loadDiagnosticIncidents,
  useDiagnosticIncidents,
  type DiagnosticIncidentDependencies,
} from "./use-diagnostic-incidents"

function dependencies(): DiagnosticIncidentDependencies {
  return {
    isDesktop: () => true,
    listDesktop: jest.fn(async () => [
      {
        stem: "desktop-panic",
        capturedAt: "2026-08-01T08:00:00.000Z",
        kind: "panic",
        hasTxt: true,
        hasJson: true,
        hasDmp: false,
        sizeBytes: 100,
      },
    ]),
    listMobile: jest.fn(async () => ({
      kind: "ok" as const,
      value: [
        {
          incidentId: "mobile-native",
          source: "ios-kscrash" as const,
          detectedAt: Date.parse("2026-08-01T09:00:00.000Z"),
          state: "accepted",
          receiptCode: "SUP-123",
          sizeBytes: 200,
        },
      ],
    })),
    readDesktop: jest.fn(async () => "desktop report"),
    readMobile: jest.fn(async () => ({
      kind: "ok" as const,
      value: {
        incidentId: "mobile-native",
        source: "ios-kscrash" as const,
        detectedAt: Date.parse("2026-08-01T09:00:00.000Z"),
        state: "accepted",
        receiptCode: "SUP-123",
        sizeBytes: 200,
        schemaVersion: "cognia-mobile-crash-v1" as const,
        redactionVersion: "1",
        payload: "mobile",
      },
    })),
    deleteDesktop: jest.fn(async () => true),
    deleteMobile: jest.fn(async () => ({ kind: "ok" as const })),
    listSubmissions: jest.fn(async () => ({}) as Record<string, SubmissionRecord>),
  }
}

const submission: SubmissionRecord = {
  incidentId: "inc-1",
  supportCode: "DESK-9",
  clientState: "accepted",
  processingState: "accepted",
  serviceUrl: "https://diag.example.com",
  submittedAt: "2026-08-01T10:00:00.000Z",
  includedMinidump: true,
  includedScreenshot: false,
}

describe("loadDiagnosticIncidents", () => {
  it("merges desktop and mobile reports newest first", async () => {
    const incidents = await loadDiagnosticIncidents(dependencies())

    expect(incidents.map((incident) => incident.id)).toEqual(["mobile-native", "desktop-panic"])
    expect(incidents[0]).toMatchObject({
      runtime: "mobile",
      state: "accepted",
      receiptCode: "SUP-123",
      artifacts: ["report"],
    })
    expect(incidents[1]).toMatchObject({
      runtime: "desktop",
      artifacts: ["text", "metadata"],
    })
  })

  it("reports a desktop crash as detected until a receipt says otherwise", async () => {
    // The lifecycle filter offers `queued`/`uploading`/`accepted`, and before
    // submission was wired no desktop report could ever leave `detected`.
    const incidents = await loadDiagnosticIncidents(dependencies())
    const desktop = incidents.find((incident) => incident.runtime === "desktop")
    expect(desktop).toMatchObject({ state: "detected", receiptCode: undefined })
    expect(desktop?.submission).toBeUndefined()
  })

  it("takes the state and receipt code from the submission record once it exists", async () => {
    const deps = dependencies()
    deps.listSubmissions = jest.fn(async () => ({ "desktop-panic": submission }))

    const incidents = await loadDiagnosticIncidents(deps)
    const desktop = incidents.find((incident) => incident.runtime === "desktop")
    expect(desktop).toMatchObject({ state: "accepted", receiptCode: "DESK-9" })
    expect(desktop?.submission?.includedMinidump).toBe(true)
  })

  it("ignores a record whose report is gone and a blank support code", async () => {
    const deps = dependencies()
    deps.listSubmissions = jest.fn(async () => ({
      "desktop-panic": { ...submission, supportCode: "" },
      "already-pruned": submission,
    }))

    const incidents = await loadDiagnosticIncidents(deps)
    // Retention prunes reports; a stranded record must not conjure a row.
    expect(incidents.map((incident) => incident.id)).toEqual(["mobile-native", "desktop-panic"])
    // An empty support code is absent, not an empty badge.
    expect(incidents[1].receiptCode).toBeUndefined()
    expect(incidents[1].state).toBe("accepted")
  })

  it("keeps desktop reports when the mobile bridge is unsupported", async () => {
    const deps = dependencies()
    deps.listMobile = jest.fn(async () => ({ kind: "unsupported" as const }))

    await expect(loadDiagnosticIncidents(deps)).resolves.toHaveLength(1)
  })
})

describe("useDiagnosticIncidents", () => {
  it("loads, previews, deletes, and refreshes reports through their owning runtime", async () => {
    const deps = dependencies()
    const { result } = renderHook(() => useDiagnosticIncidents(deps))

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.incidents).toHaveLength(2)

    await expect(result.current.read(result.current.incidents[0])).resolves.toMatchObject({
      incidentId: "mobile-native",
      schemaVersion: "cognia-mobile-crash-v1",
      payload: "mobile",
    })
    await expect(result.current.read(result.current.incidents[1])).resolves.toBe("desktop report")

    await act(async () => {
      await result.current.remove(result.current.incidents[0])
    })
    expect(deps.deleteMobile).toHaveBeenCalledWith("mobile-native")
    expect(deps.listDesktop).toHaveBeenCalledTimes(2)
  })
})

describe("normalization onto the service vocabulary", () => {
  it("carries a mobile receipt and its state, and rewrites a camelCase state", async () => {
    const deps = dependencies()
    deps.listDesktop = jest.fn(async () => [])
    deps.listMobile = jest.fn(async () => ({
      kind: "ok" as const,
      value: [
        {
          incidentId: "m-sent",
          source: "android-acra" as const,
          detectedAt: Date.parse("2026-08-02T00:00:00.000Z"),
          state: "processing",
          receiptCode: " MOB-7 ",
          sizeBytes: 10,
        },
        {
          incidentId: "m-legacy",
          source: "android-acra" as const,
          detectedAt: Date.parse("2026-08-01T00:00:00.000Z"),
          state: "awaitingConsent",
          sizeBytes: 10,
        },
      ],
    }))
    const incidents = await loadDiagnosticIncidents(deps)
    expect(incidents[0]).toMatchObject({ id: "m-sent", state: "processing", receiptCode: "MOB-7" })
    expect(incidents[1]).toMatchObject({ id: "m-legacy", state: "awaiting_consent" })
  })

  it("reads an unknown state with a receipt as sent, and without one as detected", async () => {
    const deps = dependencies()
    deps.listDesktop = jest.fn(async () => [])
    deps.listMobile = jest.fn(async () => ({
      kind: "ok" as const,
      value: [
        {
          incidentId: "with-receipt",
          source: "ios-kscrash" as const,
          detectedAt: 2,
          state: "something_newer",
          receiptCode: "SUP-1",
          sizeBytes: 1,
        },
        {
          incidentId: "without",
          source: "ios-kscrash" as const,
          detectedAt: 1,
          state: "something_newer",
          sizeBytes: 1,
        },
      ],
    }))
    const incidents = await loadDiagnosticIncidents(deps)
    expect(incidents.find((incident) => incident.id === "with-receipt")?.state).toBe("processing")
    expect(incidents.find((incident) => incident.id === "without")?.state).toBe("detected")
  })
})

describe("runtimes", () => {
  it("names the desktop under Tauri and mobile only when the plugin answered", async () => {
    const desktopOnly = dependencies()
    desktopOnly.listMobile = jest.fn(async () => ({ kind: "unsupported" as const }))
    await expect(listDiagnosticIncidents(desktopOnly)).resolves.toMatchObject({
      runtimes: ["desktop"],
    })

    const mobileOnly = dependencies()
    mobileOnly.isDesktop = () => false
    mobileOnly.listDesktop = jest.fn(async () => [])
    await expect(listDiagnosticIncidents(mobileOnly)).resolves.toMatchObject({
      runtimes: ["mobile"],
    })

    // The plain browser: no crash handler at all.
    const browser = dependencies()
    browser.isDesktop = () => false
    browser.listDesktop = jest.fn(async () => [])
    browser.listMobile = jest.fn(async () => ({ kind: "unsupported" as const }))
    await expect(listDiagnosticIncidents(browser)).resolves.toEqual({ incidents: [], runtimes: [] })
  })

  it("exposes them from the hook", async () => {
    const deps = dependencies()
    const { result } = renderHook(() => useDiagnosticIncidents(deps))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.runtimes).toEqual(["desktop", "mobile"])
  })
})

describe("an unreadable crash directory", () => {
  it("surfaces as the hook's error instead of an empty, healthy list", async () => {
    const deps = dependencies()
    deps.listDesktop = jest.fn(async () => {
      throw new Error("permission denied")
    })
    const { result } = renderHook(() => useDiagnosticIncidents(deps))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error?.message).toBe("permission denied")
    expect(result.current.incidents).toEqual([])
  })
})

describe("countActionableIncidents", () => {
  it("counts only reports still waiting on the user", () => {
    expect(
      countActionableIncidents([
        { state: "detected" },
        { state: "packaged" },
        { state: "awaiting_consent" },
        { state: "processing" },
        { state: "accepted" },
        { state: "rejected" },
      ])
    ).toBe(3)
    expect(countActionableIncidents([])).toBe(0)
    expect(isActionableIncident({ state: "queued" })).toBe(false)
  })
})
