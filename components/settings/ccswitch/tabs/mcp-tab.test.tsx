/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

const isTauriMock = jest.fn(() => true)
jest.mock("@/lib/tauri", () => ({
  isTauri: () => isTauriMock(),
}))

const useStatusMock = jest.fn()
const useMcpMock = jest.fn()
jest.mock("@/lib/ccswitch/hooks", () => ({
  useCcswitchStatus: (...args: unknown[]) => useStatusMock(...args),
  useCcswitchMcpServers: (...args: unknown[]) => useMcpMock(...args),
}))

const importMock = jest.fn()
jest.mock("@/lib/ccswitch/import", () => ({
  importCcswitchMcp: (...args: unknown[]) => importMock(...args),
}))

import { render, screen, fireEvent, waitFor } from "@testing-library/react"

import { CcswitchMcpTab } from "./mcp-tab"

beforeEach(() => {
  jest.resetAllMocks()
  isTauriMock.mockReturnValue(true)
  useStatusMock.mockReturnValue({
    data: {
      dbPath: "/x",
      exists: true,
      counts: { providers: 0, mcpServers: 1, prompts: 0, skills: 0 },
    },
    loading: false,
    error: undefined,
    refresh: jest.fn(),
  })
  useMcpMock.mockReturnValue({
    data: [{ id: "m1", name: "fetch", transport: "stdio" }],
    loading: false,
    error: undefined,
    refresh: jest.fn(),
  })
  importMock.mockResolvedValue({ imported: 1, updated: 0, skipped: 0, errored: [] })
})

describe("CcswitchMcpTab", () => {
  it("renders the MCP server rows", async () => {
    render(<CcswitchMcpTab />)
    expect(await screen.findByText("fetch")).toBeInTheDocument()
  })

  it("clicking the import button forwards selection + strategy", async () => {
    render(<CcswitchMcpTab />)
    await screen.findByText("fetch")
    const importBtn = screen.getByRole("button", {
      name: /mcp\.importBtn/,
    })
    fireEvent.click(importBtn)
    await waitFor(() => expect(importMock).toHaveBeenCalled())
    const [picks, strategy] = importMock.mock.calls[0]
    expect(picks).toHaveLength(1)
    expect(picks[0].id).toBe("m1")
    expect(strategy).toBe("skip")
  })

  it("hides the import button when no rows are selected", async () => {
    render(<CcswitchMcpTab />)
    await screen.findByText("fetch")
    const checkbox = screen.getAllByRole("checkbox")[0]
    fireEvent.click(checkbox) // deselect
    const importBtn = screen.getByRole("button", { name: /mcp\.importBtn/ })
    expect(importBtn).toBeDisabled()
  })

  it("renders empty state when CCSwitch has no MCP rows", () => {
    useMcpMock.mockReturnValue({ data: [], loading: false, error: undefined, refresh: jest.fn() })
    render(<CcswitchMcpTab />)
    expect(screen.getByText("mcp.emptyTitle")).toBeInTheDocument()
  })

  it("renders not-found state when the DB is missing", () => {
    useStatusMock.mockReturnValue({
      data: {
        dbPath: "/x",
        exists: false,
        counts: { providers: 0, mcpServers: 0, prompts: 0, skills: 0 },
      },
      loading: false,
      error: undefined,
      refresh: jest.fn(),
    })
    useMcpMock.mockReturnValue({
      data: undefined,
      loading: false,
      error: undefined,
      refresh: jest.fn(),
    })
    render(<CcswitchMcpTab />)
    expect(screen.getByText("overview.notFoundTitle")).toBeInTheDocument()
  })
})
