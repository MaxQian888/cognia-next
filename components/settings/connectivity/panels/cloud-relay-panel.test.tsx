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

it("leads with the relay and keeps sign-in above the collaboration server", () => {
  render(<CloudRelayPanel />)
  const relay = screen.getByTestId("webrtc-card")
  const tunnel = screen.getByTestId("tunnel-block")
  const logto = screen.getByTestId("logto-login-card")
  const collab = screen.getByTestId("collaboration-card")
  expect(relay.compareDocumentPosition(tunnel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(logto.compareDocumentPosition(collab) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
})
