/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string, vals?: Record<string, unknown>) =>
    vals ? `${ns}.${key}:${JSON.stringify(vals)}` : `${ns}.${key}`,
}))
jest.mock("@/components/mobile/pair/pair-api", () => ({ registerPairPayload: jest.fn() }))
jest.mock("./tabs/lan-discovery-panel", () => ({
  LanDiscoveryPanel: () => <div data-testid="lan-discovery-panel" />,
}))
jest.mock("./loopback-discovery-panel", () => ({
  LoopbackDiscoveryPanel: () => <div data-testid="loopback-discovery-panel" />,
}))

import { AddHostForm } from "./add-host-form"

/**
 * The discovery gate is per-shell, not per-section. mDNS needs a multicast
 * socket the browser does not have, so pinning the whole Remote hosts surface
 * to the desktop over it was the bug this split fixes.
 */
it("uses the mDNS sweep on the desktop", () => {
  render(<AddHostForm discoveryLane="mdns" />)
  expect(screen.getByTestId("lan-discovery-panel")).toBeInTheDocument()
  expect(screen.queryByTestId("loopback-discovery-panel")).toBeNull()
})

it("falls back to the loopback probe in a browser", () => {
  render(<AddHostForm discoveryLane="loopback" />)
  expect(screen.getByTestId("loopback-discovery-panel")).toBeInTheDocument()
  expect(screen.queryByTestId("lan-discovery-panel")).toBeNull()
})

/**
 * A seeded URL is a hint, never a second way to name a host: the one-shot
 * invitation still has to be pasted, so the field must stay empty.
 */
it("shows a seeded base URL without pre-filling the payload", () => {
  render(<AddHostForm discoveryLane="loopback" initialBaseUrl="https://box.example:27890" />)
  expect(screen.getByTestId("add-host-seeded-url")).toHaveTextContent("https://box.example:27890")
  expect(screen.getByLabelText("settings.remoteHosts.add.payloadLabel")).toHaveValue("")
})
