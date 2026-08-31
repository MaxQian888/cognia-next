/** @jest-environment jsdom */

import { render, waitFor } from "@testing-library/react"

const startAutomationAuditMirror = jest.fn()

jest.mock("@/lib/automation/audit", () => ({
  startAutomationAuditMirror: (...args: unknown[]) => startAutomationAuditMirror(...args),
}))

import { AutomationAuditMirrorInitializer } from "./automation-audit-mirror-initializer"

afterEach(() => {
  jest.clearAllMocks()
})

describe("AutomationAuditMirrorInitializer", () => {
  it("starts the mirror on mount", async () => {
    startAutomationAuditMirror.mockResolvedValue(() => {})
    render(<AutomationAuditMirrorInitializer />)
    await waitFor(() => expect(startAutomationAuditMirror).toHaveBeenCalledTimes(1))
  })

  it("unsubscribes on unmount", async () => {
    const unsubscribe = jest.fn()
    startAutomationAuditMirror.mockResolvedValue(unsubscribe)
    const { unmount } = render(<AutomationAuditMirrorInitializer />)
    await waitFor(() => expect(startAutomationAuditMirror).toHaveBeenCalled())
    unmount()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it("releases a listener that resolves after unmount", async () => {
    // The listener is registered asynchronously, so a fast unmount would
    // otherwise leak a subscription that outlives the component.
    let resolve: (handle: () => void) => void = () => {}
    startAutomationAuditMirror.mockReturnValue(
      new Promise<() => void>((r) => {
        resolve = r
      })
    )
    const unsubscribe = jest.fn()
    const { unmount } = render(<AutomationAuditMirrorInitializer />)
    unmount()
    resolve(unsubscribe)
    await waitFor(() => expect(unsubscribe).toHaveBeenCalledTimes(1))
  })

  it("survives a mirror that fails to start", async () => {
    // A missing mirror must never block boot.
    startAutomationAuditMirror.mockRejectedValue(new Error("no tauri"))
    expect(() => render(<AutomationAuditMirrorInitializer />)).not.toThrow()
    await waitFor(() => expect(startAutomationAuditMirror).toHaveBeenCalled())
  })
})
