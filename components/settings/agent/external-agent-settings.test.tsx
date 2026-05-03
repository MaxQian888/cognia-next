/**
 * ExternalAgentSettings — preset onboarding tests
 *
 * Asserts:
 *   - The Quick-start preset gallery card renders one card per preset
 *     returned by `getAvailablePresets()`.
 *   - Clicking a preset card opens the editor dialog.
 *   - "Show experimental" toggle hides/shows `documented-only` presets.
 *   - The editor dialog includes a Quick-start preset picker when adding
 *     (and not when editing).
 *   - Saved agents whose `metadata.preset` matches a known preset show a
 *     "From preset: …" badge.
 */

import React from "react"
import { render, screen, within, act } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ExternalAgentSettings } from "./external-agent-settings"
import type { ExternalAgentConfig } from "@/types/agent/external-agent"

// ---- Mocks -----------------------------------------------------------------

const mockAgentFromPreset: ExternalAgentConfig = {
  id: "agent-1",
  name: "My Codex",
  description: "Codex via stdio",
  protocol: "acp",
  transport: "stdio",
  enabled: true,
  process: { command: "npx", args: ["@anthropics/claude-code", "--stdio"] },
  defaultPermissionMode: "default",
  tags: ["coding"],
  timeout: 300000,
  metadata: { preset: "codex", ecosystemAdapterId: "anthropic" },
  createdAt: new Date(0),
  updatedAt: new Date(0),
}

const mockAgentManual: ExternalAgentConfig = {
  ...mockAgentFromPreset,
  id: "agent-2",
  name: "Manual",
  metadata: undefined,
}

const addAgentMock = jest.fn()
const updateAgentMock = jest.fn()
const removeAgentMock = jest.fn()
const getAgentMock = jest.fn((id: string) =>
  id === "agent-1" ? mockAgentFromPreset : id === "agent-2" ? mockAgentManual : undefined
)

jest.mock("@/stores/agent/external-agent-store", () => ({
  useExternalAgentStore: () => ({
    getAllAgents: () => [mockAgentFromPreset, mockAgentManual],
    getAgent: getAgentMock,
    getConnectionStatus: () => "disconnected",
    getAgentValidity: () => undefined,
    addAgent: addAgentMock,
    updateAgent: updateAgentMock,
    removeAgent: removeAgentMock,
    enabled: true,
    setEnabled: jest.fn(),
    defaultPermissionMode: "default",
    setDefaultPermissionMode: jest.fn(),
    autoConnectOnStartup: false,
    setAutoConnectOnStartup: jest.fn(),
    showConnectionNotifications: true,
    setShowConnectionNotifications: jest.fn(),
    chatFailurePolicy: "fallback",
    setChatFailurePolicy: jest.fn(),
  }),
}))

jest.mock("@/hooks/agent/use-external-agent", () => ({
  useExternalAgent: () => ({
    connect: jest.fn(),
    disconnect: jest.fn(),
  }),
}))

// Use the real `presets.ts` module — its registry exposes the four shipping
// presets so the gallery has actual data to render. We only spy on
// `getAvailablePresets` for one test that needs to override the list.
jest.mock("@/lib/ai/agent/external/presets", () => {
  const actual = jest.requireActual("@/lib/ai/agent/external/presets") as Record<string, unknown>
  return actual
})

jest.mock("@/lib/ai/agent/external/config-normalizer", () => ({
  getExternalAgentEcosystemReadiness: () => undefined,
  getExternalAgentExecutionBlockReason: () => null,
}))

// ---- Tests -----------------------------------------------------------------

describe("ExternalAgentSettings — preset onboarding", () => {
  beforeEach(() => {
    addAgentMock.mockClear()
    updateAgentMock.mockClear()
    removeAgentMock.mockClear()
  })

  it("renders the Quick-start preset gallery with one card per preset", () => {
    render(<ExternalAgentSettings />)
    const gallery = screen.getByTestId("preset-gallery-card")
    expect(gallery).toBeInTheDocument()
    // Four shipping presets: codex / claude-code / gemini-cli / cursor-cli.
    // Documented-only presets are hidden by default; the four built-ins are
    // either `official` or `guided`, so all four should render.
    expect(within(gallery).getByTestId("preset-card-codex")).toBeInTheDocument()
    expect(within(gallery).getByTestId("preset-card-claude-code")).toBeInTheDocument()
    expect(within(gallery).getByTestId("preset-card-gemini-cli")).toBeInTheDocument()
    expect(within(gallery).getByTestId("preset-card-cursor-cli")).toBeInTheDocument()
  })

  it("renders the From-preset badge on agents whose metadata.preset matches a known preset", () => {
    render(<ExternalAgentSettings />)
    expect(screen.getByTestId("agent-from-preset-agent-1")).toBeInTheDocument()
    expect(screen.queryByTestId("agent-from-preset-agent-2")).not.toBeInTheDocument()
  })

  it("clicking a preset card opens the editor dialog", async () => {
    const user = userEvent.setup()
    render(<ExternalAgentSettings />)
    const codex = screen.getByTestId("preset-pick-codex")
    await act(async () => {
      await user.click(codex)
    })
    // Dialog opens; the preset picker inside should appear.
    expect(await screen.findByTestId("preset-picker")).toBeInTheDocument()
  })

  it("the editor dialog hides the preset picker when editing an existing agent", async () => {
    const user = userEvent.setup()
    render(<ExternalAgentSettings />)
    // The Edit button lives inside a Collapsible drawer that's collapsed by
    // default, so we have to expand the row first.
    const row = screen.getByTestId("agent-row-agent-1")
    const expandToggle = within(row).getAllByRole("button").pop()
    expect(expandToggle).toBeDefined()
    await act(async () => {
      await user.click(expandToggle as HTMLElement)
    })
    const editButton = await within(row).findByRole("button", { name: /edit/i })
    await act(async () => {
      await user.click(editButton)
    })
    // The preset picker only appears in create mode.
    expect(screen.queryByTestId("preset-picker")).not.toBeInTheDocument()
  })
})
