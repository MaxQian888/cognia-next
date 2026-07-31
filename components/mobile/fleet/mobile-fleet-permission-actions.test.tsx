/** @jest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

import { MobileFleetPermissionActions } from "./mobile-fleet-permission-actions"
import { nowTickerStore } from "@/lib/fleet/now-ticker-store"
import { FLEET_PERMISSION_WAIT_MS, type PendingPermission } from "@/lib/fleet/types"

const respondMock = jest.fn()
jest.mock("@/lib/fleet/fleet-remote-actions", () => ({
  fleetRemotePermissionRespond: (...a: unknown[]) => respondMock(...a),
  isControlForbidden: (err: unknown) =>
    (err as { code?: string } | null)?.code === "remote_control_forbidden",
}))
const toastErrorMock = jest.fn()
jest.mock("sonner", () => ({ toast: { error: (...a: unknown[]) => toastErrorMock(...a) } }))

function pending(over: Partial<PendingPermission> = {}): PendingPermission {
  return { requestId: "req-1", toolName: "Bash", detail: "rm -rf x", requestedAt: Date.now(), ...over }
}

describe("MobileFleetPermissionActions", () => {
  beforeEach(() => {
    respondMock.mockReset()
    toastErrorMock.mockReset()
    nowTickerStore.resetForTests()
  })

  it("approves with the request id and shows the answered state", async () => {
    respondMock.mockResolvedValue(true)
    render(<MobileFleetPermissionActions pending={pending()} />)
    fireEvent.click(screen.getByTestId("mobile-permission-allow"))
    await waitFor(() => expect(respondMock).toHaveBeenCalledWith("req-1", "allow"))
    expect(await screen.findByTestId("mobile-permission-answered")).toBeInTheDocument()
  })

  it("renders a generic request (no tool name / detail) with a live countdown", () => {
    render(<MobileFleetPermissionActions pending={pending({ toolName: null, detail: null })} />)
    expect(screen.getByTestId("mobile-permission-countdown")).toBeInTheDocument()
    expect(screen.getByTestId("mobile-permission-allow")).toBeInTheDocument()
  })

  it("shows expired (no buttons) once the answer window has lapsed", () => {
    render(
      <MobileFleetPermissionActions
        pending={pending({ requestedAt: Date.now() - FLEET_PERMISSION_WAIT_MS - 5_000 })}
      />
    )
    expect(screen.getByTestId("mobile-permission-expired")).toBeInTheDocument()
    expect(screen.queryByTestId("mobile-permission-allow")).toBeNull()
  })

  it("toasts control-lost on a forbidden (403) rejection", async () => {
    respondMock.mockRejectedValue({ code: "remote_control_forbidden" })
    render(<MobileFleetPermissionActions pending={pending()} />)
    fireEvent.click(screen.getByTestId("mobile-permission-deny"))
    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledTimes(1))
  })

  it("toasts (and does not mark answered) when the desktop already resolved it", async () => {
    respondMock.mockResolvedValue(false)
    render(<MobileFleetPermissionActions pending={pending()} />)
    fireEvent.click(screen.getByTestId("mobile-permission-allow"))
    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId("mobile-permission-answered")).toBeNull()
  })
})
