/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

import MobileMcpPage from "./page"
import { useCompanionConfig } from "@/hooks/companion/use-companion-config"
import type { McpServerSummary } from "@cognia/agent-config-types"

jest.mock("@/hooks/companion/use-companion-config")
jest.mock("sonner", () => ({ toast: { error: jest.fn(), success: jest.fn() } }))

// The page reads the synced summaries via `useLiveQuery`. Drive it from a
// single module-level fixture the tests can reassign.
let summaryRows: McpServerSummary[] | undefined = []
let liveQuery: (() => Promise<unknown[]>) | undefined
const rawRows = [
  { id: "z", displayName: "Zulu" },
  { id: "a", displayName: "Alpha" },
]
const toArrayMock = jest.fn(async () => rawRows)
const updateMock = jest.fn<Promise<number>, [string, Record<string, unknown>]>(async () => 1)
const orderByMock = jest.fn(() => {
  throw new Error(
    "SchemaError: KeyPath displayName on object store mcpServerSummaries is not indexed"
  )
})

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: (query: () => Promise<unknown[]>) => {
    liveQuery = query
    return summaryRows
  },
}))

jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({
    mcpServerSummaries: {
      toArray: toArrayMock,
      orderBy: orderByMock,
      update: (id: string, patch: Record<string, unknown>) => updateMock(id, patch),
    },
  }),
}))

const enqueueMock = jest.fn<Promise<void>, [Record<string, unknown>]>(async () => undefined)
jest.mock("@/lib/db/mobile-outbound-queue", () => ({
  enqueue: (job: Record<string, unknown>) => enqueueMock(job),
}))

const mockPaired = (paired: boolean) =>
  (useCompanionConfig as jest.Mock).mockReturnValue({
    config: null,
    paired,
    shortDeviceId: null,
    loading: false,
    reload: jest.fn(),
  })

function summary(partial: Partial<McpServerSummary> & { id: string }): McpServerSummary {
  return {
    displayName: partial.id,
    transport: "stdio",
    enabled: true,
    trustState: "trusted",
    updatedAt: 1,
    ...partial,
  } as McpServerSummary
}

beforeEach(() => {
  jest.clearAllMocks()
  mockPaired(true)
  summaryRows = [
    summary({ id: "fs", displayName: "filesystem", transport: "stdio", enabled: true }),
    summary({ id: "ctx", displayName: "context7", transport: "http", enabled: false }),
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

  it("still points OAuth and definition edits at the desktop", () => {
    render(<MobileMcpPage />)
    expect(screen.queryByTestId("mcp-auth-button")).toBeNull()
    expect(screen.getByTestId("mcp-manage-note")).toBeInTheDocument()
  })

  it("shows the empty state when no servers are synced", () => {
    summaryRows = []
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

  it("writes a server toggle to the mirror and the outbound queue", async () => {
    render(<MobileMcpPage />)
    fireEvent.click(screen.getByLabelText("Turn off filesystem"))
    await waitFor(() => expect(enqueueMock).toHaveBeenCalled())
    expect(updateMock).toHaveBeenCalledWith("fs", expect.objectContaining({ enabled: false }))
    expect(enqueueMock.mock.calls[0][0]).toMatchObject({
      command: "mcp_set_enabled",
      payload: { id: "fs", enabled: false },
    })
  })

  it("hides the tool section for a server the desktop never probed", () => {
    render(<MobileMcpPage />)
    // "No tools" and "not yet asked" are different answers; only the second
    // one applies here, so no empty list is drawn.
    expect(screen.queryByTestId("mcp-tools-toggle-fs")).toBeNull()
  })

  it("lists tools and reports how many are denied", () => {
    summaryRows = [
      summary({
        id: "fs",
        displayName: "filesystem",
        toolNames: ["read_file", "write_file"],
        disallowedTools: ["write_file"],
      }),
    ]
    render(<MobileMcpPage />)
    expect(screen.getByTestId("mcp-row-fs")).toHaveTextContent("2 tools · 1 off")
    fireEvent.click(screen.getByTestId("mcp-tools-toggle-fs"))
    expect(screen.getByTestId("mcp-tools-fs")).toHaveTextContent("read_file")
  })

  it("sends the full deny list rather than a delta when a tool is switched", async () => {
    summaryRows = [
      summary({
        id: "fs",
        displayName: "filesystem",
        toolNames: ["read_file", "write_file"],
        disallowedTools: ["write_file"],
      }),
    ]
    render(<MobileMcpPage />)
    fireEvent.click(screen.getByTestId("mcp-tools-toggle-fs"))
    fireEvent.click(screen.getByLabelText("Deny read_file"))
    await waitFor(() => expect(enqueueMock).toHaveBeenCalled())
    expect(enqueueMock.mock.calls[0][0]).toMatchObject({
      command: "mcp_set_tool_rules",
      payload: { id: "fs", disallowedTools: ["read_file", "write_file"] },
    })
  })

  it("locks a tool a name rule already denies", () => {
    summaryRows = [
      summary({
        id: "fs",
        displayName: "filesystem",
        toolNames: ["write_file"],
        disallowedToolPatterns: ["write_*"],
      }),
    ]
    render(<MobileMcpPage />)
    fireEvent.click(screen.getByTestId("mcp-tools-toggle-fs"))
    // Rules are desktop-edited, so the switch must not pretend to be usable.
    expect(screen.getByLabelText("Allow write_file")).toBeDisabled()
  })
})
