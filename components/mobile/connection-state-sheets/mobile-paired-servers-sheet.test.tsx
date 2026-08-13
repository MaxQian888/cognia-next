/** @jest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

import type { CompanionHostRecord } from "@/lib/companion/credential-book"
import { mobileHostEntries, MobilePairedServersSheet } from "./mobile-paired-servers-sheet"

const push = jest.fn()
const replace = jest.fn()
jest.mock("next/navigation", () => ({ useRouter: () => ({ push, replace }) }))
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    key === "removeTitle" ? `Remove ${vars?.name ?? ""}` : key,
}))
jest.mock("sonner", () => ({ toast: { success: jest.fn() } }))
jest.mock("@/lib/capacitor/haptics", () => ({ impact: jest.fn() }))
jest.mock("@/hooks/ui/use-back-dismiss", () => ({ useBackDismiss: jest.fn() }))
jest.mock("@/hooks/use-biometric-guard", () => ({
  useBiometricGuard: () => async (_request: unknown, action: () => Promise<void>) => {
    await action()
    return { kind: "ran" }
  },
}))
jest.mock("@/lib/accounts/active-account-id", () => ({ DEFAULT_LOCAL_ACCOUNT_ID: "local_acct_a" }))

const switchHost = jest.fn().mockResolvedValue(undefined)
const removeHost = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/companion/host-orchestration", () => ({
  switchCompanionHost: (...args: unknown[]) => switchHost(...args),
}))
jest.mock("@/lib/companion/host-removal", () => ({
  removeCompanionHost: (...args: unknown[]) => removeHost(...args),
}))

let records: CompanionHostRecord[] = []
let active: CompanionHostRecord | null = null
jest.mock("@/lib/companion/credential-book", () => ({
  companionCredentialBook: () => ({
    list: async () => records,
    getActive: async () => active,
  }),
}))

function host(hostId: string, label = hostId): CompanionHostRecord {
  return {
    hostId,
    accountNamespace: "local_acct_a",
    label,
    endpoints: { baseUrl: `https://${hostId}.local:7890` },
    tlsPin: `pin-${hostId}`,
    cursorNamespace: `local_acct_a:${hostId}`,
    deviceId: `device-${hostId}`,
    deviceKeyThumbprint: `thumb-${hostId}`,
    serverVersion: "1.0.0",
    connection: { status: "online", generation: 0, lastOkAt: 100, lastErrorAt: null, lastError: null },
    createdAt: 1,
    updatedAt: 1,
  }
}

beforeEach(() => {
  records = []
  active = null
  push.mockClear()
  replace.mockClear()
  switchHost.mockClear()
  removeHost.mockClear()
})

it("builds the canonical list from Credential Book records with the active Host first", () => {
  expect(mobileHostEntries([host("host-b", "B"), host("host-a", "A")], "host-b")).toEqual([
    expect.objectContaining({ hostId: "host-b", active: true }),
    expect.objectContaining({ hostId: "host-a", active: false }),
  ])
})

it("adds and directly switches stable Host ids through production actions", async () => {
  records = [host("host-a", "A"), host("host-b", "B")]
  active = records[0]
  render(<MobilePairedServersSheet open onOpenChange={jest.fn()} />)
  await screen.findByTestId("mobile-paired-row-host-b")

  fireEvent.click(screen.getByText("addHost"))
  expect(push).toHaveBeenCalledWith("/pair?mode=add")
  fireEvent.click(screen.getByTestId("mobile-paired-row-host-b"))
  await waitFor(() => expect(switchHost).toHaveBeenCalledWith({ accountId: "local_acct_a", hostId: "host-b", platform: "mobile" }))
})

it("requires destructive confirmation and passes the selected fallback", async () => {
  records = [host("host-a", "A"), host("host-b", "B")]
  active = records[0]
  render(<MobilePairedServersSheet open onOpenChange={jest.fn()} />)
  await screen.findByTestId("mobile-paired-remove-host-a")

  fireEvent.click(screen.getByTestId("mobile-paired-remove-host-a"))
  expect(screen.getByText("Remove A")).toBeInTheDocument()
  fireEvent.click(screen.getByText("confirmRemove"))
  await waitFor(() => expect(removeHost).toHaveBeenCalledWith({
    accountId: "local_acct_a",
    hostId: "host-a",
    fallbackHostId: "host-b",
    platform: "mobile",
  }))
})

it("shows localized failure state without dropping the Host", async () => {
  records = [host("host-a", "A"), host("host-b", "B")]
  active = records[0]
  switchHost.mockRejectedValueOnce(new Error("offline failure"))
  render(<MobilePairedServersSheet open onOpenChange={jest.fn()} />)
  await screen.findByTestId("mobile-paired-row-host-b")
  fireEvent.click(screen.getByTestId("mobile-paired-row-host-b"))
  expect(await screen.findByRole("alert")).toHaveTextContent("offline failure")
  expect(screen.getByTestId("mobile-paired-row-host-a")).toBeInTheDocument()
})

it("enters the unpaired flow after the sole Host is removed", async () => {
  records = [host("host-a", "A")]
  active = records[0]
  render(<MobilePairedServersSheet open onOpenChange={jest.fn()} />)
  await screen.findByTestId("mobile-paired-remove-host-a")

  fireEvent.click(screen.getByTestId("mobile-paired-remove-host-a"))
  fireEvent.click(screen.getByText("confirmRemove"))

  await waitFor(() => expect(replace).toHaveBeenCalledWith("/pair"))
})
