/**
 * @jest-environment jsdom
 */

import { render, screen, within } from "@testing-library/react"

// The Pi credential probe spawns processes; its own suite covers it. Here it
// only has to show which agent it was asked about.
jest.mock("@/components/agent/external-agent/credential-status-badge", () => ({
  AgentCredentialBadge: ({ agentId }: { agentId: string }) => (
    <span data-testid={`credential-${agentId}`} />
  ),
}))

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
  externalEnabled: true,
  configuredCount: 0,
  rows: [],
  workingCount: 0,
  ...overrides,
})

describe("ExternalRuntimeConnectionsCard", () => {
  it("renders nothing when no external agent is configured", () => {
    const { container } = render(<ExternalRuntimeConnectionsCard connections={connections({})} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("lists working agents and says their credentials live elsewhere", () => {
    render(
      <ExternalRuntimeConnectionsCard
        connections={connections({
          configuredCount: 1,
          rows: [row({ protocolLabel: "PI-RPC" })],
          workingCount: 1,
        })}
      />
    )
    const card = screen.getByTestId("external-runtime-connections")
    expect(
      within(card).getByRole("heading", { name: "Agents with their own model access" })
    ).toBeInTheDocument()
    expect(card).toHaveTextContent("Their credentials are managed in External Agents")
    expect(screen.getByTestId("external-runtime-summary")).toHaveTextContent("1 of 1 ready")
    const item = screen.getByTestId("external-runtime-row-external:pi")
    expect(item).toHaveTextContent("Pi")
    expect(item).toHaveTextContent("PI-RPC")
    expect(screen.getByTestId("external-runtime-state-external:pi")).toHaveTextContent("Connected")
    expect(screen.getByTestId("credential-pi")).toBeInTheDocument()
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

  it("shows a block reason and marks host-run rows", () => {
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
    expect(screen.getByTestId("external-runtime-row-external:codex")).toHaveTextContent(
      "codex binary not found"
    )
    expect(screen.getByTestId("external-runtime-state-external:codex")).toHaveTextContent("Blocked")
    const host = screen.getByTestId("external-runtime-row-host:h1")
    expect(host).toHaveTextContent("Runs on the paired host")
    expect(screen.getByTestId("external-runtime-state-host:h1")).toHaveTextContent("Ready")
    // No local agent, so no credential probe to ask.
    expect(within(host).queryByTestId(/^credential-/)).toBeNull()
    expect(screen.getByTestId("external-runtime-summary")).toHaveTextContent("1 of 2 ready")
  })

  it("says configured agents are switched off rather than hiding them", () => {
    render(
      <ExternalRuntimeConnectionsCard
        connections={connections({ externalEnabled: false, configuredCount: 2 })}
      />
    )
    expect(screen.getByTestId("external-runtime-switched-off")).toHaveTextContent(
      "External agents are switched off, so the 2 configured here will not run"
    )
    expect(screen.queryByTestId("external-runtime-summary")).toBeNull()
    expect(screen.getByRole("link", { name: "Manage in External Agents" })).toBeInTheDocument()
  })
})
