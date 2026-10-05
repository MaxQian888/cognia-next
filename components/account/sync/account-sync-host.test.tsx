/** @jest-environment jsdom */

jest.mock("next-intl", () => ({
  useTranslations: () => jest.requireActual("./test-intl").echoTranslations(),
}))
jest.mock("@/lib/account-sync/feature-flag", () => ({ accountSyncEnabled: jest.fn(() => false) }))
jest.mock("@/hooks/account-sync/use-account-sync-poller", () => ({
  useAccountSyncPoller: jest.fn(),
}))
jest.mock("./approve-device-dialog", () => ({
  ApproveDeviceDialog: () => <div data-testid="stub-approve-dialog" />,
}))

import { render, screen } from "@testing-library/react"

import { useAccountSyncPoller } from "@/hooks/account-sync/use-account-sync-poller"
import { OPEN_APPROVAL_COMMAND } from "@/lib/account-sync/approval-notifications"
import type { IncomingRequest } from "@/lib/account-sync/enrollment/approve"
import { accountSyncEnabled } from "@/lib/account-sync/feature-flag"
import {
  dispatchNotificationCommand,
  hasNotificationCommand,
} from "@/lib/notifications/action-registry"
import { useAccountSyncStore } from "@/stores/account-sync/account-sync-store"

import { AccountSyncHost } from "./account-sync-host"

beforeEach(() => useAccountSyncStore.getState().reset())

describe("AccountSyncHost", () => {
  it("renders nothing and runs nothing when the build has no account sync", () => {
    const { container } = render(<AccountSyncHost />)
    expect(container).toBeEmptyDOMElement()
    expect(useAccountSyncPoller).not.toHaveBeenCalled()
    expect(hasNotificationCommand(OPEN_APPROVAL_COMMAND)).toBe(false)
  })

  it("runs the poller, opens approvals from notifications and mounts the dialog", async () => {
    jest.mocked(accountSyncEnabled).mockReturnValue(true)
    const { unmount } = render(<AccountSyncHost />)
    expect(screen.getByTestId("stub-approve-dialog")).toBeInTheDocument()
    const options = jest.mocked(useAccountSyncPoller).mock.calls[0]![0]
    expect(options.enabled).toBe(true)
    expect(
      options.notificationText({ displayName: "Pixel", platform: "mobile" } as IncomingRequest)
    ).toEqual({
      title: "notification.title",
      body: "notification.body(Pixel,devices.platform.mobile)",
      open: "notification.open",
    })
    await dispatchNotificationCommand({
      notificationId: "n",
      command: OPEN_APPROVAL_COMMAND,
      args: { requestId: "req_7" },
    })
    expect(useAccountSyncStore.getState().approvalRequestId).toBe("req_7")
    unmount()
    expect(hasNotificationCommand(OPEN_APPROVAL_COMMAND)).toBe(false)
  })
})
