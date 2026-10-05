/** @jest-environment jsdom */

jest.mock("next-intl", () => ({
  useTranslations: () => jest.requireActual("./test-intl").echoTranslations(),
}))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))
jest.mock("@/lib/account-sync/enrollment/approve", () => ({
  beginApproval: jest.fn(),
  pollApproval: jest.fn(),
  confirmApproval: jest.fn(async () => {}),
  denyRequest: jest.fn(async () => {}),
}))

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { toast } from "sonner"

import type { DeviceKeys } from "@/lib/account-sync/crypto"
import {
  beginApproval,
  confirmApproval,
  denyRequest,
  pollApproval,
  type IncomingRequest,
} from "@/lib/account-sync/enrollment/approve"
import type { AccountSyncContext } from "@/lib/account-sync/enrollment/context"
import { EnrollmentError } from "@/lib/account-sync/enrollment/errors"
import { useAccountSyncStore } from "@/stores/account-sync/account-sync-store"

import { APPROVAL_POLL_MS, ApproveDeviceDialog } from "./approve-device-dialog"

const context = {} as AccountSyncContext
const device = { deviceId: "dev_A" } as DeviceKeys
const request = {
  requestId: "req_1",
  deviceId: "dev_R",
  platform: "mobile",
  displayName: "Pixel",
  expiresAt: Date.now() + 10 * 60_000,
} as IncomingRequest
const approval = { request: { requestId: "req_1" } }

async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function open() {
  useAccountSyncStore.setState({
    approvalRequestId: "req_1",
    incoming: [request],
    context,
    view: { kind: "enrolled", device, registry: {} as never },
  })
  render(<ApproveDeviceDialog />)
}

beforeEach(() => {
  jest.useFakeTimers()
  useAccountSyncStore.getState().reset()
  jest.mocked(beginApproval).mockResolvedValue(approval as never)
})
afterEach(async () => {
  // Let a poll that was in flight when the dialog closed settle inside act.
  await flush()
  jest.useRealTimers()
})

async function toCode() {
  jest
    .mocked(pollApproval)
    .mockResolvedValueOnce({ phase: "waiting-reveal" })
    .mockResolvedValue({ phase: "code", code: "654 321" })
  open()
  await act(async () => fireEvent.click(screen.getByTestId("approve-device-continue")))
  await flush()
  await act(async () => {
    jest.advanceTimersByTime(APPROVAL_POLL_MS)
  })
  await flush()
}

describe("ApproveDeviceDialog", () => {
  it("is closed without a request", () => {
    render(<ApproveDeviceDialog />)
    expect(screen.queryByTestId("approve-device-dialog")).toBeNull()
  })

  it("names the device, then shows the code after the reveal", async () => {
    await toCode()
    expect(beginApproval).toHaveBeenCalledWith(context, device, request)
    expect(screen.getByTestId("approve-device-code")).toHaveTextContent("654 321")
    expect(
      screen.getByText("approve.description(Pixel,devices.platform.mobile)")
    ).toBeInTheDocument()
  })

  it("adds the device when the codes match", async () => {
    await toCode()
    await act(async () => fireEvent.click(screen.getByTestId("approve-device-match")))
    expect(confirmApproval).toHaveBeenCalledWith(context, device, approval)
    expect(toast.success).toHaveBeenCalledWith("approve.added(Pixel)")
    expect(useAccountSyncStore.getState().approvalRequestId).toBeNull()
    expect(useAccountSyncStore.getState().refreshNonce).toBe(1)
  })

  it("turns it down when the codes differ, or before any code", async () => {
    await toCode()
    await act(async () => fireEvent.click(screen.getByTestId("approve-device-mismatch")))
    expect(denyRequest).toHaveBeenCalledWith(context, device, "req_1", "mismatch", approval)
    cleanup()
    useAccountSyncStore.getState().reset()
    jest.mocked(denyRequest).mockClear()
    open()
    await act(async () => fireEvent.click(screen.getAllByTestId("approve-device-deny")[0]!))
    expect(denyRequest).toHaveBeenCalledWith(context, device, "req_1", "denied", undefined)
  })

  it("ends when the new device's nonce breaks its commitment", async () => {
    jest.mocked(pollApproval).mockRejectedValue(new EnrollmentError("commit-mismatch", "x"))
    open()
    await act(async () => fireEvent.click(screen.getByTestId("approve-device-continue")))
    await flush()
    expect(screen.getByTestId("approve-device-ended")).toHaveTextContent("approve.commitMismatch")
  })

  it("says when the request is no longer waiting", () => {
    useAccountSyncStore.setState({
      approvalRequestId: "req_gone",
      context,
      view: { kind: "enrolled", device, registry: {} as never },
    })
    render(<ApproveDeviceDialog />)
    expect(screen.getByTestId("approve-device-not-found")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("approve-device-close"))
    expect(useAccountSyncStore.getState().approvalRequestId).toBeNull()
  })
})
