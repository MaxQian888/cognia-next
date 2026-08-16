/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

import MobileMcpPage from "./page"
import { useCompanionConfig } from "@/hooks/companion/use-companion-config"
import type { McpServer } from "@cognia/agent-config-types"

jest.mock("@/hooks/companion/use-companion-config")

// The page reads the synced server list via `useLiveQuery(() => listMcpServers())`.
// Drive it from a single module-level fixture the tests can reassign.
let serverRows: McpServer[] | undefined = []
let liveQuery: (() => Promise<unknown[]>) | undefined
const summaryRows = [
  { id: "z", displayName: "Zulu" },
  { id: "a", displayName: "Alpha" },
]
const toArrayMock = jest.fn(async () => summaryRows)
const orderByMock = jest.fn(() => {
  throw new Error(
    "SchemaError: KeyPath displayName on object store mcpServerSummaries is not indexed"
  )
})

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: (query: () => Promise<unknown[]>) => {
    liveQuery = query
    return serverRows
  },
}))

jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({
    mcpServerSummaries: { toArray: toArrayMock, orderBy: orderByMock },
  }),
}))

const mockPaired = (paired: boolean) =>
  (useCompanionConfig as jest.Mock).mockReturnValue({
    config: null,
    paired,
    shortDeviceId: null,
    loading: false,
    reload: jest.fn(),
  })

function server(partial: Partial<McpServer> & { id: string }): McpServer {
  return {
    name: partial.id,
    transport: "stdio",
    config: {},
    enabled: true,
    createdAt: 0,
    updatedAt: 1,
    ...partial,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockPaired(true)
  serverRows = [
    server({ id: "fs", name: "filesystem", transport: "stdio", enabled: true }),
    server({ id: "ctx", name: "context7", transport: "http", enabled: false }),
  ]
})

describe("MobileMcpPage", () => {
  it("shows the paired placeholder when unpaired", () => {
    mockPaired(false)
    render(<MobileMcpPage />)
    expect(screen.getByTestId("paired-only-placeholder")).toBeInTheDocument()
    expect(screen.queryByTestId("mcp-row-fs")).toBeNull()
  })

  it("lists each synced server with its transport and enabled state", () => {
    render(<MobileMcpPage />)
    expect(screen.getByTestId("mcp-row-fs")).toBeInTheDocument()
    expect(screen.getByTestId("mcp-row-ctx")).toBeInTheDocument()
    expect(screen.getByTestId("mcp-state-fs")).toHaveTextContent(/on/i)
    expect(screen.getByTestId("mcp-state-ctx")).toHaveTextContent(/off/i)
    // The remote (http) server surfaces the "authenticate on desktop" note.
    expect(screen.getByTestId("mcp-row-ctx")).toHaveTextContent(/authenticate on desktop/i)
  })

  it("never renders a desktop OAuth authenticate action (read-only) but shows the manage-on-desktop note", () => {
    render(<MobileMcpPage />)
    expect(screen.queryByTestId("mcp-auth-button")).toBeNull()
    expect(screen.getByTestId("mcp-manage-note")).toBeInTheDocument()
  })

  it("shows the empty state when no servers are synced", () => {
    serverRows = []
    render(<MobileMcpPage />)
    expect(screen.getByTestId("mcp-empty")).toBeInTheDocument()
    expect(screen.queryByTestId("mcp-row-fs")).toBeNull()
  })

  it("sorts summaries after reading the unindexed table", async () => {
    render(<MobileMcpPage />)
    await expect(liveQuery?.()).resolves.toEqual([
      { id: "a", displayName: "Alpha" },
      { id: "z", displayName: "Zulu" },
    ])
    expect(toArrayMock).toHaveBeenCalled()
    expect(orderByMock).not.toHaveBeenCalled()
  })
})
