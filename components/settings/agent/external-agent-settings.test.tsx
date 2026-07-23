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
import { render, screen, within, act, fireEvent } from "@testing-library/react"
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

// A connected, HTTP-network agent carrying a rich ecosystem snapshot — exercises
// the detail pane's connected/disconnect branch, the network-endpoint row, and
// every optional ecosystem metadata row.
const mockAgentRich: ExternalAgentConfig = {
  id: "agent-3",
  name: "Rich Agent",
  description: "Networked agent",
  protocol: "acp",
  transport: "http",
  enabled: true,
  process: undefined,
  network: { endpoint: "https://api.example.com/agent" },
  defaultPermissionMode: "default",
  tags: [],
  timeout: 300000,
  metadata: undefined,
  validitySnapshot: {
    executable: true,
    checkedAt: new Date(0),
    source: "config",
    sessionExtensions: {
      "session/list": { state: "unknown" },
      "session/fork": { state: "unknown" },
      "session/resume": { state: "unknown" },
    },
    ecosystem: {
      adapterName: "Anthropic",
      surfaceName: "Claude Surface",
      supportTier: "guided",
      prerequisiteStatus: "ready",
      docsUrl: "https://docs.example.com",
      limitationNote: "Beta surface",
      recommendedActions: ["Install CLI", "Authenticate"],
    },
  },
  createdAt: new Date(0),
  updatedAt: new Date(0),
}

const addAgentMock = jest.fn()
const updateAgentMock = jest.fn()
const removeAgentMock = jest.fn()
const connectMock = jest.fn()
const disconnectMock = jest.fn()
const getAgentMock = jest.fn((id: string) =>
  id === "agent-1"
    ? mockAgentFromPreset
    : id === "agent-2"
      ? mockAgentManual
      : id === "agent-3"
        ? mockAgentRich
        : undefined
)

const externalStoreState = {
  getAllAgents: () => [mockAgentFromPreset, mockAgentManual, mockAgentRich],
  getAgent: getAgentMock,
  getConnectionStatus: (id: string) => (id === "agent-3" ? "connected" : "disconnected"),
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
  // Delegation-rules section (Thread B): empty rules + no enabled agents map.
  delegationRules: [] as unknown[],
  agents: {} as Record<string, unknown>,
  addDelegationRule: jest.fn(),
  updateDelegationRule: jest.fn(),
  removeDelegationRule: jest.fn(),
  reorderDelegationRules: jest.fn(),
}
jest.mock("@/stores/agent/external-agent-store", () => ({
  useExternalAgentStore: (selector?: (s: typeof externalStoreState) => unknown) =>
    selector ? selector(externalStoreState) : externalStoreState,
  selectDelegationRules: (s: typeof externalStoreState) => s.delegationRules,
  selectEnabledAgents: (s: typeof externalStoreState) => Object.values(s.agents),
}))

jest.mock("@/hooks/agent/use-external-agent", () => ({
  useExternalAgent: () => ({
    connect: connectMock,
    disconnect: disconnectMock,
  }),
}))

// The native Codex status card makes Tauri invokes; stub it so the detail pane
// renders in jsdom without a backend.
jest.mock("./codex-app-server-status-card", () => ({
  CodexAppServerStatusCard: () => <div data-testid="codex-status-card" />,
}))

// The extra-skill-roots "Browse…" button opens a native Tauri folder picker.
const pickDirectoryMock = jest.fn(async (): Promise<string | null> => null)
jest.mock("@/lib/files/file-bridge", () => ({
  pickDirectory: () => pickDirectoryMock(),
}))

// Use the real `presets.ts` module — its registry exposes the four shipping
// presets so the gallery has actual data to render. We only spy on
// `getAvailablePresets` for one test that needs to override the list.
jest.mock("@/lib/ai/agent/external/presets", () => {
  const actual = jest.requireActual("@/lib/ai/agent/external/presets") as Record<string, unknown>
  // Keep the real registry; make the executable-Codex preference deterministic
  // (no real `codex` CLI probe / Tauri invoke during tests).
  return {
    ...actual,
    resolvePreferredCodexExecutablePresetId: jest.fn(async () => "codex-app-server"),
  }
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
    connectMock.mockClear()
    disconnectMock.mockClear()
    pickDirectoryMock.mockReset()
  })

  // Flush the async preferred-Codex-preset effect so its setState lands inside
  // act() instead of leaking across suites.
  afterEach(async () => {
    await act(async () => {
      await Promise.resolve()
    })
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

  it("shows the native Codex app-server preset and marks it Recommended when the codex CLI is detected", async () => {
    render(<ExternalAgentSettings />)
    const gallery = screen.getByTestId("preset-gallery-card")
    expect(within(gallery).getByTestId("preset-card-codex-app-server")).toBeInTheDocument()
    // Detection resolves to the app-server preset → it gets the Recommended badge.
    expect(
      await within(gallery).findByTestId("preset-recommended-codex-app-server")
    ).toBeInTheDocument()
    // The ACP shim preset is still offered, without the badge.
    expect(within(gallery).queryByTestId("preset-recommended-codex")).not.toBeInTheDocument()
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
    // Master/detail: clicking the agent row selects it, revealing the detail
    // pane (with the Edit action) on the right.
    await act(async () => {
      await user.click(screen.getByTestId("agent-row-agent-1"))
    })
    const detail = await screen.findByTestId("agent-detail-agent-1")
    const editButton = within(detail).getByRole("button", { name: /edit/i })
    await act(async () => {
      await user.click(editButton)
    })
    // The preset picker only appears in create mode.
    expect(screen.queryByTestId("preset-picker")).not.toBeInTheDocument()
  })

  it("shows the Codex options section for codex-app-server and saves codexOptions", async () => {
    const user = userEvent.setup()
    render(<ExternalAgentSettings />)
    await act(async () => {
      await user.click(screen.getByTestId("preset-pick-codex-app-server"))
    })
    // The preset prefills protocol codex-app-server → the Codex section renders.
    const section = await screen.findByTestId("codex-options-section")
    expect(section).toBeInTheDocument()
    expect(screen.getByTestId("codex-sandbox-mode")).toBeInTheDocument()
    expect(screen.getByTestId("codex-default-effort")).toBeInTheDocument()

    await act(async () => {
      await user.click(screen.getByRole("button", { name: /^add$/i }))
    })
    expect(addAgentMock).toHaveBeenCalledTimes(1)
    const input = addAgentMock.mock.calls[0][0]
    expect(input.protocol).toBe("codex-app-server")
    // Defaults: workspaceWrite sandbox with network off; no effort/summary
    // overrides until the user picks them.
    expect(input.codexOptions).toEqual({ sandboxMode: "workspaceWrite", networkAccess: false })
  })

  it("saves trimmed, de-duped extra skill roots from the folders textarea", async () => {
    const user = userEvent.setup()
    render(<ExternalAgentSettings />)
    await act(async () => {
      await user.click(screen.getByTestId("preset-pick-codex-app-server"))
    })
    const textarea = await screen.findByTestId("codex-skill-roots")
    await act(async () => {
      fireEvent.change(textarea, {
        target: { value: "/team/skills\n /team/skills \n/opt/more\n\n" },
      })
    })
    await act(async () => {
      await user.click(screen.getByRole("button", { name: /^add$/i }))
    })
    const input = addAgentMock.mock.calls[0][0]
    expect(input.codexOptions.extraSkillRoots).toEqual(["/team/skills", "/opt/more"])
  })

  it("appends a folder chosen via Browse and never duplicates it", async () => {
    const user = userEvent.setup()
    pickDirectoryMock.mockResolvedValue("/picked/skills")
    render(<ExternalAgentSettings />)
    await act(async () => {
      await user.click(screen.getByTestId("preset-pick-codex-app-server"))
    })
    const browse = await screen.findByTestId("codex-skill-roots-browse")
    await act(async () => {
      await user.click(browse)
    })
    await act(async () => {
      await user.click(browse)
    })
    const textarea = (await screen.findByTestId("codex-skill-roots")) as HTMLTextAreaElement
    expect(textarea.value).toBe("/picked/skills")
  })

  it("leaves the skill roots unchanged when the folder picker is cancelled", async () => {
    const user = userEvent.setup()
    pickDirectoryMock.mockResolvedValue(null)
    render(<ExternalAgentSettings />)
    await act(async () => {
      await user.click(screen.getByTestId("preset-pick-codex-app-server"))
    })
    await act(async () => {
      await user.click(await screen.findByTestId("codex-skill-roots-browse"))
    })
    const textarea = (await screen.findByTestId("codex-skill-roots")) as HTMLTextAreaElement
    expect(textarea.value).toBe("")
  })

  it("does not render the Codex options section for non-codex protocols", async () => {
    const user = userEvent.setup()
    render(<ExternalAgentSettings />)
    await act(async () => {
      await user.click(screen.getByTestId("preset-pick-claude-code"))
    })
    expect(await screen.findByTestId("preset-picker")).toBeInTheDocument()
    expect(screen.queryByTestId("codex-options-section")).not.toBeInTheDocument()
  })

  it("shows the quick-start gallery in the detail pane until an agent is selected", () => {
    render(<ExternalAgentSettings />)
    // Nothing selected → the detail pane hosts the gallery, no agent detail.
    expect(screen.getByTestId("preset-gallery-card")).toBeInTheDocument()
    expect(screen.queryByTestId("agent-detail-agent-1")).not.toBeInTheDocument()
  })

  it("renders the selected agent's ecosystem metadata and a disconnect action when connected", async () => {
    const user = userEvent.setup()
    render(<ExternalAgentSettings />)
    await act(async () => {
      await user.click(screen.getByTestId("agent-row-agent-3"))
    })
    const detail = await screen.findByTestId("agent-detail-agent-3")
    // Ecosystem rows + network endpoint are projected from the validity snapshot.
    expect(within(detail).getByText("Anthropic")).toBeInTheDocument()
    expect(within(detail).getByText("Claude Surface")).toBeInTheDocument()
    expect(within(detail).getByText("Beta surface")).toBeInTheDocument()
    expect(within(detail).getByText("https://api.example.com/agent")).toBeInTheDocument()
    expect(within(detail).getByText(/Install CLI \| Authenticate/)).toBeInTheDocument()
    // Selecting the gallery's slot is replaced by the detail pane.
    expect(screen.queryByTestId("preset-gallery-card")).not.toBeInTheDocument()
    // Connected agent → a Disconnect button that calls the hook.
    const disconnect = within(detail).getByRole("button", { name: /disconnect/i })
    await act(async () => {
      await user.click(disconnect)
    })
    expect(disconnectMock).toHaveBeenCalledWith("agent-3")
  })

  it("connects a disconnected agent from the detail pane", async () => {
    const user = userEvent.setup()
    render(<ExternalAgentSettings />)
    await act(async () => {
      await user.click(screen.getByTestId("agent-row-agent-2"))
    })
    const detail = await screen.findByTestId("agent-detail-agent-2")
    const connect = within(detail).getByRole("button", { name: /connect/i })
    await act(async () => {
      await user.click(connect)
    })
    expect(connectMock).toHaveBeenCalledWith("agent-2")
  })

  it("switches the detail pane between the general rail entries", async () => {
    const user = userEvent.setup()
    render(<ExternalAgentSettings />)
    // Landing view is the gallery; global settings and delegation are one click.
    await act(async () => {
      await user.click(screen.getByTestId("nav-global-settings"))
    })
    expect(screen.getByTestId("global-settings-card")).toBeInTheDocument()
    expect(screen.queryByTestId("preset-gallery-card")).not.toBeInTheDocument()

    await act(async () => {
      await user.click(screen.getByTestId("nav-delegation"))
    })
    expect(screen.queryByTestId("global-settings-card")).not.toBeInTheDocument()
    // Both the rail entry and the panel's own card title carry the label.
    expect(screen.getAllByText(/delegation rules/i).length).toBeGreaterThan(1)
  })

  it("returns to the quick-start gallery after an agent has been selected", async () => {
    const user = userEvent.setup()
    render(<ExternalAgentSettings />)
    await act(async () => {
      await user.click(screen.getByTestId("agent-row-agent-1"))
    })
    expect(await screen.findByTestId("agent-detail-agent-1")).toBeInTheDocument()
    // Selecting an agent used to be a one-way door — the rail is the way back.
    await act(async () => {
      await user.click(screen.getByTestId("nav-quick-start"))
    })
    expect(screen.getByTestId("preset-gallery-card")).toBeInTheDocument()
    expect(screen.queryByTestId("agent-detail-agent-1")).not.toBeInTheDocument()
  })

  it("connects and disconnects straight from a list row", async () => {
    const user = userEvent.setup()
    render(<ExternalAgentSettings />)
    await act(async () => {
      await user.click(screen.getByTestId("agent-power-agent-2"))
    })
    expect(connectMock).toHaveBeenCalledWith("agent-2")
    // agent-3 is the connected fixture → its row action disconnects instead.
    await act(async () => {
      await user.click(screen.getByTestId("agent-power-agent-3"))
    })
    expect(disconnectMock).toHaveBeenCalledWith("agent-3")
  })

  it("keeps the timeout & retry fields collapsed until the section is opened", async () => {
    const user = userEvent.setup()
    render(<ExternalAgentSettings />)
    await act(async () => {
      await user.click(screen.getByTestId("preset-pick-codex"))
    })
    const section = await screen.findByTestId("retry-section")
    expect(screen.queryByLabelText(/execution timeout/i)).not.toBeInTheDocument()
    await act(async () => {
      await user.click(within(section).getByText(/timeout & retry/i))
    })
    expect(screen.getByLabelText(/execution timeout/i)).toBeInTheDocument()
  })

  it("offers the Codex app-server protocol in the manual editor and pins its transport", async () => {
    const user = userEvent.setup()
    render(<ExternalAgentSettings />)
    // The app-server preset seeds protocol codex-app-server; the transport
    // picker is then locked to stdio (the backend has no network transport).
    await act(async () => {
      await user.click(screen.getByTestId("preset-pick-codex-app-server"))
    })
    await screen.findByTestId("codex-options-section")
    expect(screen.getByTestId("transport-select")).toBeDisabled()
  })

  it("opens the delete confirmation from the detail pane", async () => {
    const user = userEvent.setup()
    render(<ExternalAgentSettings />)
    await act(async () => {
      await user.click(screen.getByTestId("agent-row-agent-1"))
    })
    const detail = await screen.findByTestId("agent-detail-agent-1")
    await act(async () => {
      await user.click(within(detail).getByRole("button", { name: /delete/i }))
    })
    // The AlertDialog confirmation surfaces (delete title from the messages).
    expect(await screen.findByRole("alertdialog")).toBeInTheDocument()
  })
})
