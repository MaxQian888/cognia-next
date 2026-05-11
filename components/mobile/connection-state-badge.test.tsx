/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"

import { ConnectionStateBadge } from "./connection-state-badge"
import type { ConnectionState } from "@/lib/tauri/transport-companion"

jest.mock("@/hooks/companion/use-connection-state", () => ({
  useConnectionState: jest.fn(),
}))

import { useConnectionState } from "@/hooks/companion/use-connection-state"
const mockedUse = useConnectionState as jest.MockedFunction<typeof useConnectionState>

describe("ConnectionStateBadge", () => {
  afterEach(() => {
    jest.clearAllMocks()
  })

  it("renders nothing when the transport hasn't reported a state", () => {
    mockedUse.mockReturnValue(null)
    const { container } = render(<ConnectionStateBadge />)
    expect(container.firstChild).toBeNull()
  })

  it.each<[ConnectionState, string]>([
    ["connected", "Live"],
    ["reconnecting", "Reconnecting"],
    ["offline", "Offline"],
    ["unauthenticated", "Re-pair needed"],
  ])("renders the %s state with label %s", (state, label) => {
    mockedUse.mockReturnValue(state)
    render(<ConnectionStateBadge />)
    const badge = screen.getByTestId("connection-state-badge")
    expect(badge.dataset.state).toBe(state)
    expect(badge.textContent).toContain(label)
  })
})
