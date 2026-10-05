/** @jest-environment jsdom */

jest.mock("next-intl", () => ({
  useTranslations: () => jest.requireActual("./test-intl").echoTranslations(),
}))
jest.mock("@/lib/account-sync/feature-flag", () => ({ accountSyncEnabled: jest.fn(() => true) }))
jest.mock("./first-device-setup", () => ({
  FirstDeviceSetup: () => <div data-testid="stub-first-device" />,
}))
jest.mock("./join-request-panel", () => ({
  JoinRequestPanel: () => <div data-testid="stub-join" />,
}))
jest.mock("./recovery-key-form", () => ({
  RecoveryKeyForm: ({ onBack }: { onBack: () => void }) => (
    <button data-testid="stub-recover" onClick={onBack}>
      back
    </button>
  ),
}))
jest.mock("./account-sync-data-panel", () => ({
  AccountSyncDataPanel: () => <div data-testid="stub-data-panel" />,
}))
jest.mock("./sync-device-list", () => ({
  SyncDeviceList: () => <div data-testid="stub-device-list" />,
}))

import { fireEvent, render, screen } from "@testing-library/react"

import type { AccountSyncContext } from "@/lib/account-sync/enrollment/context"
import type { IncomingRequest } from "@/lib/account-sync/enrollment/approve"
import { accountSyncEnabled } from "@/lib/account-sync/feature-flag"
import type { AccountSyncView } from "@/lib/account-sync/poll"
import { useAccountSyncStore } from "@/stores/account-sync/account-sync-store"

import { AccountSyncSection } from "./account-sync-section"

const context = {} as AccountSyncContext

function show(
  view: AccountSyncView,
  extra: Partial<ReturnType<typeof useAccountSyncStore.getState>> = {}
) {
  useAccountSyncStore.setState({ view, context, ...extra })
  return render(<AccountSyncSection account="ada" />)
}

beforeEach(() => useAccountSyncStore.getState().reset())

describe("AccountSyncSection", () => {
  it("is absent when the build has no account sync", () => {
    jest.mocked(accountSyncEnabled).mockReturnValueOnce(false)
    const { container } = show({ kind: "signed-out" })
    expect(container).toBeEmptyDOMElement()
  })

  it("labels the feature as a preview", () => {
    show({ kind: "idle" })
    expect(screen.getByTestId("account-sync-preview-badge")).toHaveTextContent("section.preview")
    expect(screen.getByRole("status")).toHaveTextContent("section.loading")
  })

  it.each([
    [{ kind: "signed-out" }, "section.signedOut"],
    [{ kind: "locked" }, "section.locked"],
    [{ kind: "integrity", reason: "fork" }, "section.integrity"],
  ] as const)("explains %p", (view, text) => {
    show(view as AccountSyncView)
    expect(screen.getByTestId("account-sync-section")).toHaveTextContent(text)
  })

  it("offers the first device setup for an empty space", () => {
    show({ kind: "not-enrolled", space: "empty", registry: null })
    expect(screen.getByTestId("stub-first-device")).toBeInTheDocument()
  })

  it("offers approval or the recovery key when the space exists", () => {
    show({ kind: "not-enrolled", space: "ready", registry: null })
    fireEvent.click(screen.getByTestId("account-sync-choose-approval"))
    expect(screen.getByTestId("stub-join")).toBeInTheDocument()
  })

  it("can go back from the recovery key form", () => {
    show({ kind: "not-enrolled", space: "ready", registry: null })
    fireEvent.click(screen.getByTestId("account-sync-choose-recovery"))
    fireEvent.click(screen.getByTestId("stub-recover"))
    expect(screen.getByTestId("account-sync-join-choose")).toBeInTheDocument()
  })

  it("shows a removed device how to join again", () => {
    show({ kind: "removed", removal: { at: 1, seq: 2, by: "dev_X" } })
    fireEvent.click(screen.getByTestId("account-sync-rejoin"))
    expect(screen.getByTestId("account-sync-join-choose")).toBeInTheDocument()
  })

  it("shows the data panel, the device list and the waiting devices for an enrolled device", () => {
    show(
      { kind: "enrolled", device: {} as never, registry: {} as never },
      { incoming: [{ requestId: "req_9" }] as IncomingRequest[] }
    )
    expect(screen.getByTestId("stub-data-panel")).toBeInTheDocument()
    expect(screen.getByTestId("stub-device-list")).toBeInTheDocument()
    expect(screen.getByTestId("account-sync-waiting")).toHaveTextContent("devices.waiting(1)")
    fireEvent.click(screen.getByTestId("account-sync-review"))
    expect(useAccountSyncStore.getState().approvalRequestId).toBe("req_9")
  })

  it("reports a failed look and retries", () => {
    show({ kind: "signed-out" }, { error: { message: "offline", failures: 2 } })
    expect(screen.getByRole("alert")).toHaveTextContent("section.pollError(offline)")
    fireEvent.click(screen.getByTestId("account-sync-retry"))
    expect(useAccountSyncStore.getState().refreshNonce).toBe(1)
  })
})
