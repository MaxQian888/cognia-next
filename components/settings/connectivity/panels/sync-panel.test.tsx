import { render, screen } from "@testing-library/react"

import { SyncPanel } from "./sync-panel"

jest.mock("@/components/settings/companion/sync-status-card", () => ({
  SyncStatusCard: () => <div data-testid="sync-status-card" />,
}))

it("mounts the sync status card", () => {
  render(<SyncPanel />)
  expect(screen.getByTestId("sync-status-card")).toBeInTheDocument()
})
