import { render, screen } from "@testing-library/react"

import { LocalHostPanel } from "./local-host-panel"

jest.mock("@/components/settings/companion/channel-matrix-card", () => ({
  ChannelMatrixCard: () => <div data-testid="channel-matrix-card" />,
}))
jest.mock("@/components/settings/companion/browser-access-card", () => ({
  BrowserAccessCard: () => <div data-testid="browser-access-card" />,
}))
jest.mock("@/components/settings/companion/workspace-roots-card", () => ({
  WorkspaceRootsCard: () => <div data-testid="workspace-roots-card" />,
}))
jest.mock("../blocks/server-block", () => ({
  ServerBlock: () => <div data-testid="server-block" />,
}))
jest.mock("../blocks/mdns-block", () => ({ MdnsBlock: () => <div data-testid="mdns-block" /> }))

it("stacks the local host blocks, channel matrix first", () => {
  render(<LocalHostPanel />)
  const ids = [
    "channel-matrix-card",
    "server-block",
    "mdns-block",
    "browser-access-card",
    "workspace-roots-card",
  ]
  const nodes = ids.map((id) => screen.getByTestId(id))
  for (let i = 1; i < nodes.length; i += 1) {
    expect(
      nodes[i - 1].compareDocumentPosition(nodes[i]) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  }
})
