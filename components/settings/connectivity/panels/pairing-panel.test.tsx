import { render, screen } from "@testing-library/react"

import { PairingPanel } from "./pairing-panel"

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => [{ deviceId: "a" }, { deviceId: "b" }],
}))
jest.mock("@/lib/db/paired-devices", () => ({ listPairedDevices: async () => [] }))
jest.mock("../blocks/pair-invitation-block", () => ({
  PairInvitationBlock: () => <div data-testid="pair-invitation-block" />,
}))
jest.mock("@/components/settings/companion/browser-companion-card", () => ({
  BrowserCompanionCard: () => <div data-testid="browser-companion-card" />,
}))
jest.mock("@/components/devices/device-console-link", () => ({
  DeviceConsoleLink: ({ surface, count }: { surface: string; count: number }) => (
    <div data-testid={`device-console-link-${surface}`} data-count={count} />
  ),
}))

it("mints invitations above the enrollment and counts the paired devices", () => {
  render(<PairingPanel />)
  expect(screen.getByTestId("pair-invitation-block")).toBeInTheDocument()
  expect(screen.getByTestId("browser-companion-card")).toBeInTheDocument()
  expect(screen.getByTestId("device-console-link-paired")).toHaveAttribute("data-count", "2")
})
