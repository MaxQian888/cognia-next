import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { CloudIcon } from "lucide-react"
import type { TransportHealthSnapshot } from "@cognia/logging/types/transport"

import { TransportRow } from "./transport-row"

function health(overrides: Partial<TransportHealthSnapshot> = {}): TransportHealthSnapshot {
  return {
    transport: "remote",
    status: "healthy",
    queueDepth: 0,
    retryCount: 0,
    droppedEntries: 0,
    updatedAt: "2026-08-19T00:00:00.000Z",
    ...overrides,
  }
}

function renderRow(overrides: Partial<React.ComponentProps<typeof TransportRow>> = {}) {
  const onEnabledChange = jest.fn()
  const onOpenChange = jest.fn()
  const props: React.ComponentProps<typeof TransportRow> = {
    id: "remote",
    icon: CloudIcon,
    title: "Remote Transport",
    description: "Ship logs to a remote endpoint with retry batching.",
    enabled: true,
    onEnabledChange,
    open: true,
    onOpenChange,
    children: <p>Endpoint configuration</p>,
    ...overrides,
  }
  render(<TransportRow {...props} />)
  return { onEnabledChange, onOpenChange }
}

describe("TransportRow", () => {
  it("labels its switch with the transport name", () => {
    renderRow()
    expect(screen.getByRole("switch", { name: "Remote Transport" })).toBeChecked()
  })

  it("toggles the transport without touching the disclosure", () => {
    const { onEnabledChange, onOpenChange } = renderRow()

    screen.getByRole("switch", { name: "Remote Transport" }).click()

    expect(onEnabledChange).toHaveBeenCalledWith(false)
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it("opens and closes the configuration from the header", async () => {
    const user = userEvent.setup()
    const { onOpenChange } = renderRow()

    await user.click(screen.getByRole("button", { name: /Show Remote Transport configuration/i }))

    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("keeps the configuration out of view while collapsed", () => {
    // This Collapsible unmounts its children when closed (the content node is
    // rendered empty and `hidden`), so the body is genuinely absent.
    renderRow({ open: false })
    expect(screen.queryByText("Endpoint configuration")).not.toBeInTheDocument()
  })

  it("shows the live health status when the logger reports one", () => {
    renderRow({ health: health({ status: "degraded" }) })
    expect(screen.getByTestId("logs-transport-health-badge-remote")).toHaveTextContent("degraded")
  })

  it("shows no badge for a transport the logger has not registered", () => {
    // The remote transport is not attached until it has an endpoint — an
    // invented badge would claim a health the logger never reported.
    renderRow()
    expect(screen.queryByTestId("logs-transport-health-badge-remote")).not.toBeInTheDocument()
  })

  it("marks the row's enabled state for styling and assertions", () => {
    renderRow({ enabled: false })
    expect(screen.getByTestId("logs-transport-remote")).toHaveAttribute("data-enabled", "false")
  })
})
