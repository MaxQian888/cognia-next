import { render, screen } from "@testing-library/react"

import { CloudRelayPanel } from "./cloud-relay-panel"

jest.mock("@/components/settings/companion/webrtc-card", () => ({
  WebRtcCard: () => <div data-testid="webrtc-card" />,
}))
jest.mock("@/components/settings/companion/remote-browser-card", () => ({
  RemoteBrowserCard: () => <div data-testid="remote-browser-card" />,
}))
jest.mock("@/components/settings/companion/logto-login-card", () => ({
  LogtoLoginCard: () => <div data-testid="logto-login-card" />,
}))
jest.mock("@/components/settings/companion/collaboration-card", () => ({
  CollaborationCard: () => <div data-testid="collaboration-card" />,
}))
jest.mock("../blocks/tunnel-block", () => ({
  TunnelBlock: () => <div data-testid="tunnel-block" />,
}))
jest.mock("../blocks/mesh-block", () => ({
  MeshBlock: () => <div data-testid="mesh-block" />,
}))
jest.mock("../blocks/relay-check-block", () => ({
  RelayCheckBlock: ({ relay }: { relay: { route: string } }) => (
    <div data-testid="relay-check-block" data-route={relay.route} />
  ),
}))
jest.mock("../blocks/remote-access-summary", () => ({
  RemoteAccessSummary: ({ relay }: { relay: string }) => (
    <div data-testid="remote-access-summary" data-relay={relay} />
  ),
}))
jest.mock("@/hooks/connectivity/use-remote-access", () => ({
  useRemoteAccess: () => ({
    isHost: true,
    relay: { route: "unchecked" },
    tunnel: { available: true, publicUrl: null, localUrl: null },
    mesh: { available: true, status: null, refresh: async () => {} },
  }),
}))

it("leads with the verdict and the relay proof, then the relay, tunnel and overlay, and keeps sign-in above the collaboration server", () => {
  render(<CloudRelayPanel />)
  const summary = screen.getByTestId("remote-access-summary")
  const check = screen.getByTestId("relay-check-block")
  const relay = screen.getByTestId("webrtc-card")
  const tunnel = screen.getByTestId("tunnel-block")
  const mesh = screen.getByTestId("mesh-block")
  const logto = screen.getByTestId("logto-login-card")
  const collab = screen.getByTestId("collaboration-card")
  const follows = (a: Element, b: Element) =>
    Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
  expect(follows(summary, check)).toBe(true)
  expect(follows(check, relay)).toBe(true)
  expect(follows(relay, tunnel)).toBe(true)
  expect(follows(tunnel, mesh)).toBe(true)
  expect(follows(logto, collab)).toBe(true)
  // One read feeds both the banner and the proof block.
  expect(summary).toHaveAttribute("data-relay", "unchecked")
  expect(check).toHaveAttribute("data-route", "unchecked")
})
