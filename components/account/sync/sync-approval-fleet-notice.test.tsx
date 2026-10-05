/** @jest-environment jsdom */

jest.mock("next-intl", () => ({
  useTranslations: () => jest.requireActual("./test-intl").echoTranslations(),
}))
jest.mock("@/lib/account-sync/feature-flag", () => ({ accountSyncEnabled: jest.fn(() => true) }))

import { fireEvent, render, screen } from "@testing-library/react"

import { accountSyncEnabled } from "@/lib/account-sync/feature-flag"
import type { IncomingRequest } from "@/lib/account-sync/enrollment/approve"
import { useAccountSyncStore } from "@/stores/account-sync/account-sync-store"

import { SyncApprovalFleetNotice } from "./sync-approval-fleet-notice"

const waiting = [{ requestId: "req_1" }, { requestId: "req_2" }] as IncomingRequest[]

beforeEach(() => useAccountSyncStore.getState().reset())

describe("SyncApprovalFleetNotice", () => {
  it("is empty without waiting devices", () => {
    const { container } = render(<SyncApprovalFleetNotice />)
    expect(container).toBeEmptyDOMElement()
  })

  it("names the waiting devices and opens the first", () => {
    useAccountSyncStore.setState({ incoming: waiting })
    render(<SyncApprovalFleetNotice />)
    expect(screen.getByTestId("sync-approval-fleet-notice")).toHaveTextContent("waitingBody(2)")
    fireEvent.click(screen.getByRole("button", { name: "review" }))
    expect(useAccountSyncStore.getState().approvalRequestId).toBe("req_1")
  })

  it("stays dormant when the build has no account sync", () => {
    jest.mocked(accountSyncEnabled).mockReturnValue(false)
    useAccountSyncStore.setState({ incoming: waiting })
    const { container } = render(<SyncApprovalFleetNotice />)
    expect(container).toBeEmptyDOMElement()
  })
})
