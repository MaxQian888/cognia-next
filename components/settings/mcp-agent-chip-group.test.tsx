/** @jest-environment jsdom */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn(), warning: jest.fn() },
}))

jest.mock("@/lib/tauri", () => ({ isTauri: () => true }))

const updateMcpServer = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/db/mcp-servers", () => ({
  updateMcpServer: (...args: unknown[]) => updateMcpServer(...args),
}))

jest.mock("@/hooks/agent", () => ({
  refreshAgentStatuses: jest.fn(),
}))

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { toast } from "sonner"
import type { McpServer } from "@cognia/agent-config-types"
import type { AgentStatus } from "@/hooks/agent/use-agent-status"

import { McpAgentChipGroup } from "./mcp-agent-chip-group"

const server = {
  id: "mcp-a",
  name: "alpha",
  transport: "stdio",
  config: { command: "alpha" },
  enabled: true,
  appsEnabled: {},
  createdAt: 1,
  updatedAt: 1,
} satisfies McpServer

const status = {
  agent: {
    id: "claude-code",
    displayName: "Claude Code",
    writable: true,
    format: "json",
    parse: () => [],
    project: () => ({}),
  },
  path: "/tmp/settings.json",
  exists: true,
  inFileCount: 0,
  inFileNames: new Set<string>(),
} satisfies AgentStatus

beforeEach(() => updateMcpServer.mockClear())

describe("McpAgentChipGroup", () => {
  it("renders only the supplied catalog snapshot", () => {
    render(<McpAgentChipGroup server={server} statuses={[status]} />)
    expect(screen.getByRole("button", { name: "Claude Code" })).toBeInTheDocument()
  })

  it("updates the selected Agent projection without loading its own snapshot", async () => {
    render(<McpAgentChipGroup server={server} statuses={[status]} />)
    fireEvent.click(screen.getByRole("button", { name: "Claude Code" }))
    await waitFor(() =>
      expect(updateMcpServer).toHaveBeenCalledWith("mcp-a", {
        appsEnabled: { "claude-code": true },
      })
    )
  })

  it("warns when projection must resolve a credential into the Agent's plaintext file", async () => {
    render(
      <McpAgentChipGroup
        server={{
          ...server,
          config: {
            command: "alpha",
            env: { API_TOKEN: { secretRef: "mcp/mcp-a/env/API_TOKEN" } },
          },
        }}
        statuses={[status]}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "Claude Code" }))

    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith("plaintextCredentialWarning"))
  })
})
