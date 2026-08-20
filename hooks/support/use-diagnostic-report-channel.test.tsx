import { renderHook } from "@testing-library/react"

import type { DiagnosticServiceClient } from "@/lib/diagnostic-service/client"

const register = jest.fn<() => void, [unknown]>()
jest.mock("@/lib/support-report/channels", () => ({
  registerSupportReportChannel: (spec: unknown) => register(spec),
}))

let client: DiagnosticServiceClient | null = null
jest.mock("@/hooks/diagnostic-service/use-diagnostic-connection", () => ({
  useDiagnosticConnection: () => ({ client }),
}))

import { useDiagnosticReportChannel } from "./use-diagnostic-report-channel"

const unregister = jest.fn()

beforeEach(() => {
  client = null
  register.mockReset()
  register.mockReturnValue(unregister)
  unregister.mockReset()
})

describe("useDiagnosticReportChannel", () => {
  it("registers nothing while no service is configured", () => {
    renderHook(() => useDiagnosticReportChannel())
    // A button that cannot deliver is worse than an absent one.
    expect(register).not.toHaveBeenCalled()
  })

  it("registers a channel bound to the connected client", () => {
    client = {} as DiagnosticServiceClient
    renderHook(() => useDiagnosticReportChannel())
    expect(register).toHaveBeenCalledTimes(1)
    expect(register.mock.calls[0][0]).toMatchObject({ id: "diagnostic-service" })
  })

  it("unregisters on unmount so a closed dialog leaves no channel behind", () => {
    client = {} as DiagnosticServiceClient
    const { unmount } = renderHook(() => useDiagnosticReportChannel())
    unmount()
    expect(unregister).toHaveBeenCalledTimes(1)
  })

  it("survives a duplicate registration instead of taking the dialog down", () => {
    client = {} as DiagnosticServiceClient
    register.mockImplementation(() => {
      throw new Error('Support report channel "diagnostic-service" is already registered.')
    })
    // Two mounts of the report dialog race; the loser must not throw during
    // render, and must not remove the winner's registration on unmount.
    expect(() => {
      const { unmount } = renderHook(() => useDiagnosticReportChannel())
      unmount()
    }).not.toThrow()
    expect(unregister).not.toHaveBeenCalled()
  })
})
