import { act, renderHook, waitFor } from "@testing-library/react"

import {
  loadDiagnosticIncidents,
  useDiagnosticIncidents,
  type DiagnosticIncidentDependencies,
} from "./use-diagnostic-incidents"

function dependencies(): DiagnosticIncidentDependencies {
  return {
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
    readMobile: jest.fn(async () => ({ kind: "ok" as const, value: { payload: "mobile" } })),
    deleteDesktop: jest.fn(async () => true),
    deleteMobile: jest.fn(async () => ({ kind: "ok" as const })),
  }
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

    await expect(result.current.read(result.current.incidents[0])).resolves.toEqual({
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
