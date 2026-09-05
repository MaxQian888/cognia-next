import { act, fireEvent, render, screen } from "@testing-library/react"

import { PairInvitationBlock, type OwnerInvitationIssue } from "./pair-invitation-block"

import type { HostAdminReach } from "@/lib/connectivity/host-admin-reach"
import type { PairRelay } from "@/lib/qr/pair-payload"

const reach = jest.fn<HostAdminReach, []>(() => ({ available: true }))
jest.mock("@/hooks/connectivity/use-host-admin-reach", () => ({
  useHostAdminReachForCommand: () => reach(),
}))
jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))
jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: (selector: (s: { unlockedAccountId: string }) => unknown) =>
    selector({ unlockedAccountId: "acct" }),
}))
jest.mock("qrcode.react", () => ({
  QRCodeSVG: ({ value }: { value: string }) => <svg data-testid="qr" data-value={value} />,
}))
jest.mock("@/lib/tauri", () => ({ transport: { call: jest.fn() } }))

const base: OwnerInvitationIssue = {
  invitation: "inv",
  expiresAtMs: Date.now() + 60_000,
  baseUrl: "https://10.0.0.5:27890",
  fingerprint: "ab",
  appVersion: "1.0.0",
  hostId: "host",
  tenantId: "tenant",
}

const relay: PairRelay = {
  url: "wss://signaling.example/signaling",
  room: {
    v: 2,
    roomId: "r",
    roomNonce: "n",
    desktopSigningKey: "d",
    mobileSigningKey: "m",
    notAfter: Date.now() + 60_000,
  },
  mobilePrivateKeyJwk: { kty: "EC", crv: "P-256", d: "d", x: "x", y: "y" },
}

describe("PairInvitationBlock", () => {
  beforeEach(() => reach.mockReturnValue({ available: true }))

  it("mints a direct-only invitation as cgnp3 and says it needs the same network", async () => {
    render(<PairInvitationBlock issue={async () => base} />)
    await act(async () => {
      fireEvent.click(screen.getByRole("button"))
    })
    expect(screen.getByTestId("qr").getAttribute("data-value")).toMatch(/^cgnp3\|/)
    expect(screen.getByTestId("pair-reach-direct")).toBeInTheDocument()
  })

  it("mints a relay invitation as cgnp4 and labels it reachable from anywhere", async () => {
    render(<PairInvitationBlock issue={async () => ({ ...base, relay })} />)
    await act(async () => {
      fireEvent.click(screen.getByRole("button"))
    })
    expect(screen.getByTestId("qr").getAttribute("data-value")).toMatch(/^cgnp4\|/)
    expect(screen.getByTestId("pair-reach-relay")).toBeInTheDocument()
  })

  it("explains the block instead of hiding the button", () => {
    reach.mockReturnValue({ available: false, block: "not-owner" })
    render(<PairInvitationBlock />)
    expect(screen.getByRole("button")).toBeDisabled()
    expect(screen.getByTestId("pair-reach")).toHaveAttribute("data-reach", "not-owner")
  })
})
