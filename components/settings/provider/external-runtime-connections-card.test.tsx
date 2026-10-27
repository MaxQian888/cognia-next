/**
 * @jest-environment jsdom
 */

import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import {
  EXTERNAL_AGENTS_SETTINGS_HREF,
  ExternalRuntimeConnectionsCard,
} from "./external-runtime-connections-card"
import type {
  ExternalRuntimeConnection,
  ExternalRuntimeConnections,
} from "./use-external-runtime-connections"

// No local next-intl mock: the global one resolves against the real English
// catalog, so these assert on the words the user reads.

const row = (overrides: Partial<ExternalRuntimeConnection>): ExternalRuntimeConnection => ({
  key: "external:pi",
  name: "Pi",
  placement: "local",
  localAgentId: "pi",
  state: "connected",
  detail: null,
  ...overrides,
})

const connections = (
  overrides: Partial<ExternalRuntimeConnections>
): ExternalRuntimeConnections => ({
  configuredCount: 0,
  rows: [],
  workingCount: 0,
  ...overrides,
})

describe("ExternalRuntimeConnectionsCard", () => {
  beforeEach(() => window.localStorage.clear())
  afterEach(() => window.localStorage.clear())

  it("renders nothing when no external agent is configured", () => {
    const { container } = render(<ExternalRuntimeConnectionsCard connections={connections({})} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("summarizes model access without displaying individual agents", () => {
    render(
      <ExternalRuntimeConnectionsCard
        connections={connections({
          configuredCount: 1,
          rows: [row({ protocolLabel: "PI-RPC" })],
          workingCount: 1,
        })}
      />
    )
    const card = screen.getByRole("region", { name: "Agents with their own model access" })
    expect(
      within(card).getByRole("heading", { name: "Agents with their own model access" })
    ).toBeInTheDocument()
    expect(card).toHaveTextContent("Their credentials are managed in External Agents")
    expect(screen.getByTestId("external-runtime-summary")).toHaveTextContent("1 of 1 ready")
    expect(within(card).queryByRole("list")).not.toBeInTheDocument()
    expect(within(card).queryByText("Pi")).not.toBeInTheDocument()
    expect(within(card).queryByText("PI-RPC")).not.toBeInTheDocument()
  })

  it("points at the External Agents settings section", () => {
    render(
      <ExternalRuntimeConnectionsCard
        connections={connections({ configuredCount: 1, rows: [row({})], workingCount: 1 })}
      />
    )
    expect(screen.getByRole("link", { name: "Manage in External Agents" })).toHaveAttribute(
      "href",
      EXTERNAL_AGENTS_SETTINGS_HREF
    )
    expect(EXTERNAL_AGENTS_SETTINGS_HREF).toBe("/settings?section=agents")
  })

  it("summarizes local and host agents without exposing row details", () => {
    render(
      <ExternalRuntimeConnectionsCard
        connections={connections({
          configuredCount: 1,
          rows: [
            row({
              key: "external:codex",
              name: "Codex",
              localAgentId: "codex",
              state: "blocked",
              detail: "codex binary not found",
            }),
            row({
              key: "host:h1",
              name: "Host Claude",
              placement: "host",
              localAgentId: null,
              state: "ready",
            }),
          ],
          workingCount: 1,
        })}
      />
    )
    expect(screen.queryByText("codex binary not found")).not.toBeInTheDocument()
    expect(screen.queryByText("Host Claude")).not.toBeInTheDocument()
    expect(screen.queryByRole("list")).not.toBeInTheDocument()
    expect(screen.getByTestId("external-runtime-summary")).toHaveTextContent("1 of 2 ready")
  })

  it("dismisses the notice and keeps it hidden after revisiting the page", async () => {
    const user = userEvent.setup()
    const props = connections({ configuredCount: 1, rows: [row({})], workingCount: 1 })
    const { unmount } = render(<ExternalRuntimeConnectionsCard connections={props} />)
    await user.click(screen.getByRole("button", { name: "Dismiss" }))
    expect(screen.queryByRole("region")).not.toBeInTheDocument()
    unmount()
    render(<ExternalRuntimeConnectionsCard connections={props} />)
    expect(screen.queryByRole("region")).not.toBeInTheDocument()
  })

  it("does not present a global-off state for an empty runtime catalog", () => {
    const { container } = render(
      <ExternalRuntimeConnectionsCard connections={connections({ configuredCount: 2 })} />
    )
    expect(container).toBeEmptyDOMElement()
  })
})
