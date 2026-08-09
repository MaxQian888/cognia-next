/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

jest.mock("./mcp-server-card", () => ({
  McpServerCard: ({ server, variant }: { server: { name: string }; variant?: string }) => (
    <div data-testid="card" data-variant={variant}>
      {server.name}
    </div>
  ),
}))

import { render, screen } from "@testing-library/react"
import { McpServerList } from "./mcp-server-list"
import type { McpServer } from "@cognia/agent-config-types"

const servers: McpServer[] = [
  {
    id: "a",
    name: "alpha",
    transport: "stdio",
    config: {},
    enabled: true,
    appsEnabled: {},
    createdAt: 0,
    updatedAt: 0,
  } as McpServer,
  {
    id: "b",
    name: "bravo",
    transport: "http",
    config: {},
    enabled: false,
    appsEnabled: {},
    createdAt: 0,
    updatedAt: 0,
  } as McpServer,
]

const handlers = {
  onToggleSelect: jest.fn(),
  onToggleFavorite: jest.fn(),
  onToggle: jest.fn(),
  onEdit: jest.fn(),
  onClone: jest.fn(),
  onDelete: jest.fn(),
}

describe("McpServerList", () => {
  it("renders one card per server with no group header in 'none' mode", () => {
    render(
      <McpServerList
        servers={servers}
        view="grid"
        groupBy="none"
        selection={new Set()}
        agentStatuses={[]}
        agentStatusesLoading={false}
        isFavorite={() => false}
        {...handlers}
      />
    )
    expect(screen.getAllByTestId("card")).toHaveLength(2)
    // grid view → card variant
    expect(screen.getAllByTestId("card")[0]).toHaveAttribute("data-variant", "card")
  })

  it("renders transport group headers", () => {
    render(
      <McpServerList
        servers={servers}
        view="list"
        groupBy="transport"
        selection={new Set()}
        agentStatuses={[]}
        agentStatusesLoading={false}
        isFavorite={() => false}
        {...handlers}
      />
    )
    // Headers show the transport literal + count.
    expect(screen.getByText("stdio")).toBeInTheDocument()
    expect(screen.getByText("http")).toBeInTheDocument()
    // list view → row variant
    expect(screen.getAllByTestId("card")[0]).toHaveAttribute("data-variant", "row")
  })

  it("renders status group headers via i18n keys", () => {
    render(
      <McpServerList
        servers={servers}
        view="grid"
        groupBy="status"
        selection={new Set()}
        agentStatuses={[]}
        agentStatusesLoading={false}
        isFavorite={() => false}
        {...handlers}
      />
    )
    expect(screen.getByText("enabled")).toBeInTheDocument()
    expect(screen.getByText("disabled")).toBeInTheDocument()
  })
})
