// Resolve complete namespaces from split sources; aggregates are rebuilt by the orchestrator.
import externalAgentMessages from "@/i18n/messages/en/externalAgent.json"

/** ExternalAgentSettings — picker onboarding, guarded navigation, and lifecycle wiring. */

import { isTauri } from "@/lib/tauri"
import React from "react"
import {
  render as rtlRender,
  screen,
  within,
  act,
  fireEvent,
  waitFor,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { TooltipProvider } from "@/components/ui/tooltip"
import { ExternalAgentSettings } from "./external-agent-settings"
import type { LifecycleExternalAgentConfig } from "@/stores/agent/external-agent-store"
import type { CreateExternalAgentInput, ExternalAgentConfig } from "@/types/agent/external-agent"

// The app mounts one TooltipProvider at the root; the badges and trait chips
// in the rail and inspector rely on it.
const render = (ui: React.ReactElement) => rtlRender(ui, { wrapper: TooltipProvider })

let mockNativeMobile = false
jest.mock("@/lib/platform/detect", () => ({
  ...jest.requireActual("@/lib/platform/detect"),
  isNativeMobile: () => mockNativeMobile,
}))
let mockListDensity: "split" | "stacked" = "split"
jest.mock("@/hooks/use-element-width", () => ({
  useElementWidth: () => (mockListDensity === "stacked" ? 719 : 720),
}))
jest.mock("@/components/chat/motion/motion-reveal", () => ({
  ...jest.requireActual("@/components/chat/motion/motion-reveal"),
  useFlowMotion: () => ({ reduce: true, durationScale: 1 }),
}))

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
  metadata: { providerUndoWarningAcknowledged: true },
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

// Mutations go through the lifecycle service, not the store: a store write
// persisted the change and left the runtime manager holding the old state, so
// an agent added here was not registered until the next app restart.
// Typed parameters, so `mock.calls[0][0]` is an input rather than an
// element of an empty tuple.
const createConfigMock = jest.fn(async (_input: CreateExternalAgentInput) => "agent-new")
const updateConfigMock = jest.fn(async () => {})
const removeConfigMock = jest.fn(async () => {})
const duplicateConfigMock = jest.fn(async (_id: string, _name: string) => "agent-copy")
const clearCredentialSlotMock = jest.fn(async (_id: string, _slot: string) => {})
const toastSuccess = jest.fn()
const toastError = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
  },
}))
jest.mock("@/components/agent/external-agent/cognia-model-picker", () => ({
  CogniaModelPicker: ({ onChange }: { onChange: (binding: unknown) => void }) => (
    <button
      type="button"
      onClick={() =>
        onChange({
          providerId: "plugin:kimi:subscription",
          modelId: "kimi-for-coding",
          accountId: "account-b",
        })
      }
    >
      Select Cognia fixture
    </button>
  ),
}))

jest.mock("@/lib/ai/agent/external/lifecycle/service", () => ({
  getExternalAgentLifecycleService: async () => ({
    createConfig: createConfigMock,
    updateConfig: updateConfigMock,
    removeConfig: removeConfigMock,
    clearCredentialSlot: clearCredentialSlotMock,
    duplicateConfig: duplicateConfigMock,
  }),
}))
// An agent reconciliation blocked at startup. Before the verdict was rendered
// this looked identical to one the user had simply switched off.
const mockAgentBlocked = {
  ...mockAgentFromPreset,
  id: "agent-4",
  name: "Blocked Agent",
  enabled: false,
  lifecycleStatus: "blocked",
  lifecycleReasonCode: "adapter_unavailable",
  lifecycleReason: 'no protocol adapter is registered for "acp"',
} as unknown as LifecycleExternalAgentConfig

// A Windows agent whose unsandboxed launch has not been approved. The dialog
// and the badge existed with nothing rendering them, so this state used to be
// reported with no way to act on it.
const mockAgentNeedsConsent = {
  ...mockAgentFromPreset,
  id: "agent-5",
  name: "Awaiting Consent",
  enabled: false,
  lifecycleStatus: "needs-consent",
  lifecycleReasonCode: "consent_required",
  runtimeBinding: { runtimeId: "codex-acp", ownership: "system" },
} as unknown as ExternalAgentConfig

const pushMock = jest.fn()
jest.spyOn(jest.requireMock("next/navigation"), "useRouter").mockReturnValue({ push: pushMock })

const connectMock = jest.fn()
const disconnectMock = jest.fn()
const getAgentMock = jest.fn((id: string) =>
  id === "agent-1"
    ? mockAgentFromPreset
    : id === "agent-2"
      ? mockAgentManual
      : id === "agent-3"
        ? mockAgentRich
        : id === "agent-4"
          ? mockAgentBlocked
          : id === "agent-5"
            ? mockAgentNeedsConsent
            : undefined
)

const externalStoreState = {
  getAllAgents: () => [
    mockAgentFromPreset,
    mockAgentManual,
    mockAgentRich,
    mockAgentBlocked,
    mockAgentNeedsConsent,
  ],
  getAgent: getAgentMock,
  getConnectionStatus: (id: string) => (id === "agent-3" ? "connected" : "disconnected"),
  getAgentValidity: () => undefined,
  agentFailures: {} as Record<
    string,
    import("@/lib/ai/agent/external/agent-failure").ExternalAgentFailure
  >,
  recordAgentFailure: jest.fn(
    (failure: import("@/lib/ai/agent/external/agent-failure").ExternalAgentFailure) => {
      externalStoreState.agentFailures[failure.agentId] = failure
    }
  ),
  clearAgentFailure: jest.fn((id: string) => {
    delete externalStoreState.agentFailures[id]
  }),
  addAgent: addAgentMock,
  updateAgent: updateAgentMock,
  removeAgent: removeAgentMock,
  enabled: true,
  defaultPermissionMode: "default",
  setDefaultPermissionMode: jest.fn(),
  autoConnectOnStartup: false,
  setAutoConnectOnStartup: jest.fn(),
  showConnectionNotifications: true,
  setShowConnectionNotifications: jest.fn(),
  chatFailurePolicy: "fallback",
  setChatFailurePolicy: jest.fn(),
  overviewBannerCollapsed: false,
  setOverviewBannerCollapsed: jest.fn(),
  railGroupBy: "readiness" as "readiness" | "runtime",
  setRailGroupBy: jest.fn(),
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
  selectAgents: (s: typeof externalStoreState) => s.agents,
  selectConnectionStatus: () => ({}),
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

// Use the real `presets.ts` module — its registry exposes the shipping
// presets so the gallery has actual data to render. We only spy on
// `getAvailablePresets` for one test that needs to override the list.
jest.mock("@/lib/ai/agent/external/config/presets", () => {
  const actual = jest.requireActual("@/lib/ai/agent/external/config/presets") as Record<
    string,
    unknown
  >
  // Keep the real registry; make the executable-Codex preference deterministic
  // (no real `codex` CLI probe / Tauri invoke during tests).
  return {
    ...actual,
    resolvePreferredCodexExecutablePresetId: jest.fn(async () => "codex-app-server"),
  }
})

jest.mock("@/lib/ai/agent/external/config/config-normalizer", () => ({
  getExternalAgentEcosystemReadiness: () => undefined,
  getExternalAgentExecutionBlockReason: () => null,
  getExternalAgentExecutionBlock: () => null,
}))

// Platform gate for the mandatory-sandbox banner. jsdom is not Tauri, so the
// default is "desktop shell absent" — which must NOT show the warning.
const isTauriMock = jest.mocked(isTauri)
const platformMock = jest.fn(() => "macos")
jest.mock("@/lib/tauri", () => ({
  ...(jest.requireActual("@/lib/tauri") as Record<string, unknown>),
  isTauri: jest.fn(() => false),
}))
jest.mock("@tauri-apps/plugin-os", () => ({
  platform: () => platformMock(),
}))

// ---- Tests -----------------------------------------------------------------

// The header and rail share the same picker dialog before the create editor.
async function openAddPicker(user: ReturnType<typeof userEvent.setup>) {
  await act(async () => {
    await user.click(screen.getByTestId("add-agent-button"))
  })
}

describe("ExternalAgentSettings — preset onboarding", () => {
  beforeEach(() => {
    mockListDensity = "split"
    externalStoreState.enabled = true
    addAgentMock.mockClear()
    updateAgentMock.mockClear()
    removeAgentMock.mockClear()
    createConfigMock.mockClear()
    updateConfigMock.mockClear()
    removeConfigMock.mockClear()
    connectMock.mockReset()
    externalStoreState.agentFailures = {}
    externalStoreState.recordAgentFailure.mockClear()
    externalStoreState.clearAgentFailure.mockClear()
    disconnectMock.mockClear()
    toastSuccess.mockClear()
    toastError.mockClear()
    pickDirectoryMock.mockReset()
  })

  // Flush the async preferred-Codex-preset effect so its setState lands inside
  // act() instead of leaking across suites.
  afterEach(async () => {
    await act(async () => {
      await Promise.resolve()
    })
  })

  it("keeps inspector Connect available despite a retired global flag", async () => {
    externalStoreState.enabled = false
    render(<ExternalAgentSettings />)
    await userEvent.click(screen.getByTestId("agent-row-agent-1"))
    expect(
      within(screen.getByTestId("agent-detail-agent-1")).getByRole("button", { name: /^connect$/i })
    ).toBeEnabled()
  })

  it("limits the agent rail to 240px while retaining its navigation", () => {
    render(<ExternalAgentSettings />)
    const pane = screen.getByTestId("agents-list-detail")
    const grid = pane.querySelector<HTMLElement>("[style*='--settings-rail-w']")
    expect(grid?.style.getPropertyValue("--settings-rail-w")).toBe("240px")
    expect(screen.getByRole("button", { name: "Host-owned agents" })).toBeVisible()
    expect(screen.getByRole("button", { name: "Runtimes & installs" })).toBeVisible()
    expect(screen.getByRole("textbox", { name: "Search agents…" })).toBeVisible()
  })

  it("opens runtimes from the inspector remedy", async () => {
    const original = mockAgentBlocked.lifecycleReasonCode
    mockAgentBlocked.lifecycleReasonCode = "runtime_missing"
    try {
      render(<ExternalAgentSettings />)
      await userEvent.click(screen.getByTestId("agent-row-agent-4"))
      await userEvent.click(
        screen.getByRole("button", {
          name: externalAgentMessages.settings.remedies["open-runtimes"],
        })
      )
      expect(screen.queryByTestId("agent-detail-agent-4")).not.toBeInTheDocument()
      expect(screen.getByTestId("runtime-governance-panel")).toBeInTheDocument()
    } finally {
      mockAgentBlocked.lifecycleReasonCode = original
    }
  })

  it("shows a hook-recorded connect failure once and clears it on Dismiss", async () => {
    const { describeExternalAgentFailure } = await import("@/lib/ai/agent/external/agent-failure")
    connectMock.mockImplementationOnce(async (id: string) => {
      const error = new Error("Handshake failed", { cause: new Error("Socket closed") })
      externalStoreState.recordAgentFailure(describeExternalAgentFailure(id, "connect", error))
      throw error
    })
    const view = render(<ExternalAgentSettings />)
    await userEvent.click(screen.getByTestId("agent-row-agent-1"))
    await userEvent.click(
      within(screen.getByTestId("agent-detail-agent-1")).getByRole("button", { name: /^connect$/i })
    )
    view.rerender(<ExternalAgentSettings />)
    expect(screen.getByTestId("agent-failure-agent-1")).toHaveTextContent("Socket closed")
    expect(externalStoreState.recordAgentFailure).toHaveBeenCalledTimes(1)
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }))
    view.rerender(<ExternalAgentSettings />)
    expect(externalStoreState.clearAgentFailure).toHaveBeenCalledWith("agent-1")
    expect(screen.queryByTestId("agent-failure-agent-1")).not.toBeInTheDocument()
  })

  it("guards plugin navigation while the inspector has a draft", async () => {
    pushMock.mockClear()
    render(<ExternalAgentSettings />)
    await userEvent.click(screen.getByTestId("agent-row-agent-4"))
    fireEvent.change(screen.getByTestId("inspector-description"), {
      target: { value: "Keep this draft" },
    })
    await userEvent.click(
      screen.getByRole("link", { name: externalAgentMessages.settings.remedies["open-plugins"] })
    )
    expect(pushMock).not.toHaveBeenCalled()
    await userEvent.click(
      screen.getByRole("button", { name: externalAgentMessages.settings.keepEditing })
    )
    expect(screen.getByTestId("inspector-description")).toHaveValue("Keep this draft")
    await userEvent.click(
      screen.getByRole("link", { name: externalAgentMessages.settings.remedies["open-plugins"] })
    )
    await userEvent.click(
      screen.getByRole("button", { name: externalAgentMessages.settings.discardDraft })
    )
    expect(pushMock).toHaveBeenCalledWith("/plugins")
  })

  it("renders the mobile detail without an inspector frame at the stacked tier", async () => {
    mockListDensity = "stacked"
    render(<ExternalAgentSettings />)
    expect(screen.getByTestId("add-agent-button")).toBeInTheDocument()
    await userEvent.click(screen.getByTestId("agent-row-agent-1"))
    expect(screen.getByTestId("agent-mobile-detail-agent-1")).toBeInTheDocument()
    expect(screen.queryByTestId("agent-inspector-frame")).not.toBeInTheDocument()
    expect(screen.queryByTestId("inspector-description")).not.toBeInTheDocument()
    expect(screen.queryByTestId("add-agent-button")).not.toBeInTheDocument()
    expect(
      screen.queryByRole("heading", { name: externalAgentMessages.settings.title })
    ).not.toBeInTheDocument()
    expect(document.getElementById("external-agents-enabled")).not.toBeInTheDocument()
  })

  it("offers agent management without a global switch at the split threshold", async () => {
    render(<ExternalAgentSettings />)
    expect(document.getElementById("external-agents-enabled")).toBeNull()
    expect(
      screen.getAllByRole("button", { name: externalAgentMessages.settings.addAgent })[0]
    ).toBeEnabled()
    await userEvent.click(screen.getByTestId("agent-row-agent-1"))
    expect(screen.getByTestId("agent-inspector-frame")).toHaveClass("border", "rounded-lg")
    expect(screen.getByTestId("inspector-description")).toBeInTheDocument()
    expect(screen.getByTestId("add-agent-button")).toBeInTheDocument()
    expect(screen.queryByTestId("agent-mobile-detail-agent-1")).not.toBeInTheDocument()
  })

  it("renders the Add picker with the available presets", async () => {
    const user = userEvent.setup()
    render(<ExternalAgentSettings />)
    await openAddPicker(user)
    const gallery = screen.getByTestId("preset-picker-list")
    expect(gallery).toBeInTheDocument()
    // Documented-only presets are hidden by default.
    expect(within(gallery).getByTestId("preset-pick-codex")).toBeInTheDocument()
    expect(within(gallery).getByTestId("preset-pick-claude-code")).toBeInTheDocument()
    expect(within(gallery).getByTestId("preset-pick-gemini-cli")).toBeInTheDocument()
    expect(within(gallery).getByTestId("preset-pick-cursor-cli")).toBeInTheDocument()
    expect(within(gallery).getByTestId("preset-pick-opencode-v2-service")).toBeInTheDocument()
  })

  it("renders agent brand icons in picker and configured-agent rows", async () => {
    const user = userEvent.setup()
    render(<ExternalAgentSettings />)
    await openAddPicker(user)

    expect(screen.getByTestId("preset-pick-codex").querySelector("img")).toHaveAttribute(
      "src",
      "/icons/lobe/codex-color.svg"
    )
    expect(screen.getByTestId("preset-pick-claude-code").querySelector("img")).toHaveAttribute(
      "src",
      "/icons/lobe/claudecode-color.svg"
    )
    expect(screen.getByTestId("agent-row-agent-1").querySelector("img")).toHaveAttribute(
      "src",
      "/icons/lobe/codex-color.svg"
    )
  })

  it("shows the native Codex app-server preset and marks it Recommended when the codex CLI is detected", async () => {
    const user = userEvent.setup()
    render(<ExternalAgentSettings />)
    await openAddPicker(user)
    const gallery = screen.getByTestId("preset-picker-list")
    expect(within(gallery).getByTestId("preset-pick-codex-app-server")).toBeInTheDocument()
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

  it("picking a preset opens the seeded editor summary", async () => {
    const user = userEvent.setup()
    render(<ExternalAgentSettings />)
    await openAddPicker(user)
    const codex = screen.getByTestId("preset-pick-codex")
    await act(async () => {
      await user.click(codex)
    })
    // The selected preset is summarized without a second dropdown.
    expect(await screen.findByTestId("preset-summary")).toBeInTheDocument()
  })

  it("opens the Devin preset with a native ACP command and localized description", async () => {
    const user = userEvent.setup()
    render(<ExternalAgentSettings />)
    await openAddPicker(user)
    expect(
      screen.getByText(
        "Run Devin through its native ACP server using your existing CLI login. Select models, including SWE-2, after connecting. Choose Accept Edits (Code) when you want Devin to modify files. Cognia tools are available in each conversation alongside Devin’s native tools."
      )
    ).toBeInTheDocument()
    await act(async () => {
      await user.click(screen.getByTestId("preset-pick-devin"))
    })
    expect(screen.getByDisplayValue("Devin CLI")).toBeInTheDocument()
    expect(screen.getByDisplayValue("devin")).toBeInTheDocument()
    expect(screen.getByDisplayValue("acp")).toBeInTheDocument()
  })

  it("opens a plugin-registered preset whose process config carries no args", async () => {
    // `ExternalAgentProcessConfig.args` is optional and a plugin can register a
    // preset at runtime. Reading `preset.process.args.join(" ")` threw on such
    // a preset and blanked the section instead of opening its editor.
    const { registerPreset, unregisterPreset } = jest.requireActual(
      "@/lib/ai/agent/external/config/presets"
    ) as {
      registerPreset: (id: string, config: unknown) => unknown
      unregisterPreset: (id: string) => boolean
    }
    registerPreset("argless-preset", {
      id: "argless-preset",
      name: "Argless",
      protocol: "acp",
      transport: "process",
      process: { command: "argless" },
      defaultPermissionMode: "default",
    })
    try {
      const user = userEvent.setup()
      render(<ExternalAgentSettings />)
      await openAddPicker(user)
      await act(async () => {
        await user.click(screen.getByTestId("preset-pick-argless-preset"))
      })
      expect(await screen.findByTestId("preset-summary")).toBeInTheDocument()
    } finally {
      unregisterPreset("argless-preset")
    }
  })

  it("the editor dialog hides the preset picker when editing an existing agent", async () => {
    const user = userEvent.setup()
    render(<ExternalAgentSettings />)
    // Master/detail: clicking the agent row selects it, revealing the detail
    // pane (with the Edit action) on the right.
    await act(async () => {
      await user.click(screen.getByTestId("agent-row-agent-1"))
    })
    await screen.findByTestId("agent-detail-agent-1")
    await user.click(screen.getByTestId("inspector-actions-menu"))
    const editButton = screen.getByRole("menuitem", { name: /edit/i })
    await act(async () => {
      await user.click(editButton)
    })
    // The preset picker only appears in create mode.
    expect(screen.queryByTestId("preset-picker")).not.toBeInTheDocument()
  })

  it("shows the Codex options section for codex-app-server and saves codexOptions", async () => {
    const user = userEvent.setup()
    render(<ExternalAgentSettings />)
    await openAddPicker(user)
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
    expect(createConfigMock).toHaveBeenCalledTimes(1)
    const input = createConfigMock.mock.calls[0][0]
    expect(input.protocol).toBe("codex-app-server")
    // Defaults: workspaceWrite sandbox with network off; no effort/summary
    // overrides until the user picks them.
    expect(input.codexOptions).toEqual({ sandboxMode: "workspaceWrite", networkAccess: false })
  })

  it("saves trimmed, de-duped extra skill roots from the folders textarea", async () => {
    const user = userEvent.setup()
    render(<ExternalAgentSettings />)
    await openAddPicker(user)
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
    const input = createConfigMock.mock.calls[0][0]
    expect(input.codexOptions?.extraSkillRoots).toEqual(["/team/skills", "/opt/more"])
  })

  it("appends a folder chosen via Browse and never duplicates it", async () => {
    const user = userEvent.setup()
    // The affordance exists only where a picker does. It used to render on
    // every shell and do nothing at all when clicked.
    isTauriMock.mockReturnValue(true)
    pickDirectoryMock.mockResolvedValue("/picked/skills")
    render(<ExternalAgentSettings />)
    await openAddPicker(user)
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
    isTauriMock.mockReturnValue(true)
    pickDirectoryMock.mockResolvedValue(null)
    render(<ExternalAgentSettings />)
    await openAddPicker(user)
    await act(async () => {
      await user.click(screen.getByTestId("preset-pick-codex-app-server"))
    })
    await act(async () => {
      await user.click(await screen.findByTestId("codex-skill-roots-browse"))
    })
    const textarea = (await screen.findByTestId("codex-skill-roots")) as HTMLTextAreaElement
    expect(textarea.value).toBe("")
  })

  it("shows the Pi runtime section for pi-rpc and saves global extensions by default", async () => {
    const user = userEvent.setup()
    render(<ExternalAgentSettings />)
    await openAddPicker(user)
    await act(async () => {
      await user.click(screen.getByTestId("preset-pick-pi-rpc"))
    })

    expect(await screen.findByTestId("pi-options-section")).toBeInTheDocument()
    expect(screen.getByTestId("pi-extension-policy")).toBeInTheDocument()

    await act(async () => {
      await user.click(screen.getByRole("button", { name: /^add$/i }))
    })
    const input = createConfigMock.mock.calls[0][0]
    expect(input.protocol).toBe("pi-rpc")
    expect(input.process).toMatchObject({ command: "pi" })
    // Isolation is the default, and it has to reach `metadata` — the adapter
    // reads it from there when building spawn args.
    expect(input.metadata?.piExtensionPolicy).toBe("global")
  })

  it("saves the shared Cognia model and account binding from the settings editor", async () => {
    const user = userEvent.setup()
    render(<ExternalAgentSettings />)
    await openAddPicker(user)
    await user.click(screen.getByTestId("preset-pick-pi-rpc"))
    await user.click(await screen.findByRole("button", { name: "Select Cognia fixture" }))
    await user.click(screen.getByRole("button", { name: /^add$/i }))
    expect(createConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cogniaModel: {
          providerId: "plugin:kimi:subscription",
          modelId: "kimi-for-coding",
          accountId: "account-b",
        },
      })
    )
  })

  it("shows the exact isolation flags so the claim is inspectable", async () => {
    const user = userEvent.setup()
    render(<ExternalAgentSettings />)
    await openAddPicker(user)
    await act(async () => {
      await user.click(screen.getByTestId("preset-pick-pi-rpc"))
    })
    const section = await screen.findByTestId("pi-options-section")
    await user.click(screen.getByTestId("pi-extension-policy"))
    await user.click(screen.getByRole("option", { name: /^isolated$/i }))
    // `--no-extensions` alone does NOT isolate Pi; the UI must not imply it does.
    expect(section).toHaveTextContent("--no-extensions --no-skills --no-prompt-templates")
  })

  it("does not render the Pi runtime section for other protocols", async () => {
    const user = userEvent.setup()
    render(<ExternalAgentSettings />)
    await openAddPicker(user)
    await act(async () => {
      await user.click(screen.getByTestId("preset-pick-claude-code"))
    })
    expect(await screen.findByTestId("preset-summary")).toBeInTheDocument()
    expect(screen.queryByTestId("pi-options-section")).not.toBeInTheDocument()
  })

  it("does not render the Codex options section for non-codex protocols", async () => {
    const user = userEvent.setup()
    render(<ExternalAgentSettings />)
    await openAddPicker(user)
    await act(async () => {
      await user.click(screen.getByTestId("preset-pick-claude-code"))
    })
    expect(await screen.findByTestId("preset-summary")).toBeInTheDocument()
    expect(screen.queryByTestId("codex-options-section")).not.toBeInTheDocument()
  })

  it.each(["deepseek-harness-readonly", "deepseek-harness-workspace", "deepseek-harness-acp"])(
    "saves managed %s without a command and passes credentials to lifecycle",
    async (preset) => {
      const user = userEvent.setup()
      render(<ExternalAgentSettings />)
      await openAddPicker(user)
      await user.click(screen.getByTestId(`preset-pick-${preset}`))
      const section = await screen.findByTestId("connection-section")
      expect(within(section).getByLabelText(/^command$/i)).toBeDisabled()
      await user.type(within(section).getByLabelText(/^api key$/i), "deepseek-key-for-keyring")
      await user.type(within(section).getByLabelText(/^working directory$/i), "/workspace")
      await user.click(screen.getByRole("button", { name: /^add$/i }))
      expect(createConfigMock).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ preset, requiresManagedRuntime: true }),
          process: {
            command: "",
            args: [],
            cwd: "/workspace",
            env: { DEEPSEEK_API_KEY: "deepseek-key-for-keyring" },
          },
        })
      )
    }
  )

  it("creates a current OpenCode service configuration using local discovery", async () => {
    const user = userEvent.setup()
    render(<ExternalAgentSettings />)
    await openAddPicker(user)
    await user.click(screen.getByTestId("preset-pick-opencode-v2-service"))
    const section = await screen.findByTestId("opencode-v2-options-section")
    expect(within(section).getByLabelText("Endpoint URL")).toHaveValue("")
    await user.click(screen.getByRole("button", { name: /^add$/i }))
    expect(createConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({
        protocol: "opencode-v2",
        transport: "sse",
        metadata: expect.objectContaining({
          preset: "opencode-v2-service",
          localServiceDiscovery: true,
        }),
      })
    )
    expect(createConfigMock.mock.calls[0][0].network?.endpoint).toBe("")
  })

  it("persists an explicit current OpenCode endpoint, credentials, and workspace", async () => {
    const user = userEvent.setup()
    render(<ExternalAgentSettings />)
    await openAddPicker(user)
    await user.click(screen.getByTestId("preset-pick-opencode-v2-service"))
    const section = await screen.findByTestId("opencode-v2-options-section")
    await user.type(within(section).getByLabelText("Endpoint URL"), "https://opencode.example.test")
    await user.type(within(section).getByLabelText("API Key"), "service-token")
    await user.type(within(section).getByLabelText("Working Directory"), "/workspace/project")
    await user.click(screen.getByRole("button", { name: /^add$/i }))
    expect(createConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({
        protocol: "opencode-v2",
        network: { endpoint: "https://opencode.example.test", apiKey: "service-token" },
        process: { command: "", args: [], cwd: "/workspace/project", env: {} },
      })
    )
  })

  it.each(["file:///tmp/opencode.sock", "ws://localhost:4096", "not-a-url"])(
    "keeps the OpenCode editor open without saving invalid endpoint %s",
    async (endpoint) => {
      const user = userEvent.setup()
      render(<ExternalAgentSettings />)
      await openAddPicker(user)
      await user.click(screen.getByTestId("preset-pick-opencode-v2-service"))
      const section = await screen.findByTestId("opencode-v2-options-section")
      await user.type(within(section).getByLabelText("Endpoint URL"), endpoint)
      await user.click(screen.getByRole("button", { name: /^add$/i }))
      expect(createConfigMock).not.toHaveBeenCalled()
      expect(screen.getByRole("dialog", { name: "Add Agent" })).toBeInTheDocument()
      expect(within(section).getByLabelText("Endpoint URL")).toHaveValue(endpoint)
    }
  )

  it("persists native OpenCode Basic authentication alongside optional proxy credentials", async () => {
    const user = userEvent.setup()
    render(<ExternalAgentSettings />)
    await openAddPicker(user)
    await user.click(screen.getByTestId("preset-pick-opencode-v2-service"))
    const section = await screen.findByTestId("opencode-v2-options-section")
    await user.type(within(section).getByLabelText("Endpoint URL"), "https://opencode.example.test")
    await user.type(within(section).getByLabelText("Server password"), "fixture-password")
    await user.type(within(section).getByLabelText("Server username"), "opencode-user")
    await user.click(screen.getByRole("button", { name: /^add$/i }))
    expect(createConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          serverPassword: "fixture-password",
          serverUsername: "opencode-user",
        }),
      })
    )
  })

  it("clears native OpenCode Basic authentication when editing a saved endpoint", async () => {
    const previous = { ...mockAgentManual }
    Object.assign(mockAgentManual, {
      protocol: "opencode-v2",
      network: { endpoint: "https://opencode.example.test" },
      metadata: { retained: true, serverUsername: "old-user" },
      // The password lives in the keychain; the editor can only say it is saved.
      credentialRefs: { serverPassword: "agent-2:serverPassword" },
    })
    clearCredentialSlotMock.mockClear()
    try {
      const user = userEvent.setup()
      render(<ExternalAgentSettings />)
      await user.click(screen.getByTestId("agent-row-agent-2"))
      await screen.findByTestId("agent-detail-agent-2")
      await user.click(screen.getByTestId("inspector-actions-menu"))
      await user.click(screen.getByRole("menuitem", { name: /edit/i }))
      const section = await screen.findByTestId("opencode-v2-options-section")
      expect(within(section).getByLabelText("Server password")).toHaveValue("")
      expect(within(section).getByTestId("opencode-v2-server-password-saved")).toBeInTheDocument()
      expect(within(section).getByLabelText("Server username")).toHaveValue("old-user")
      await user.click(within(section).getByRole("button", { name: "Remove saved value" }))
      await user.clear(within(section).getByLabelText("Server username"))
      // Nothing is removed until the save lands.
      expect(clearCredentialSlotMock).not.toHaveBeenCalled()
      await user.click(screen.getByRole("button", { name: /^save$/i }))
      expect(updateConfigMock).toHaveBeenCalledWith(
        "agent-2",
        expect.objectContaining({
          metadata: expect.objectContaining({ serverUsername: null }),
        })
      )
      await waitFor(() =>
        expect(clearCredentialSlotMock).toHaveBeenCalledWith("agent-2", "serverPassword")
      )
    } finally {
      Object.assign(mockAgentManual, previous)
      if (!previous.network) delete mockAgentManual.network
      delete (mockAgentManual as { credentialRefs?: unknown }).credentialRefs
    }
  })

  it("clears the saved OpenCode endpoint and workspace when returning to local discovery", async () => {
    const previous = { ...mockAgentManual }
    Object.assign(mockAgentManual, {
      protocol: "opencode-v2",
      transport: "sse",
      network: { endpoint: "https://opencode.example.test" },
      process: { command: "", cwd: "/workspace/old" },
    })
    try {
      const user = userEvent.setup()
      render(<ExternalAgentSettings />)
      await user.click(screen.getByTestId("agent-row-agent-2"))
      await screen.findByTestId("agent-detail-agent-2")
      await user.click(screen.getByTestId("inspector-actions-menu"))
      await user.click(screen.getByRole("menuitem", { name: /edit/i }))
      const section = await screen.findByTestId("opencode-v2-options-section")
      await user.clear(within(section).getByLabelText("Endpoint URL"))
      await user.clear(within(section).getByLabelText("Working Directory"))
      await user.click(screen.getByRole("button", { name: /^save$/i }))
      expect(updateConfigMock).toHaveBeenCalledWith(
        "agent-2",
        expect.objectContaining({
          network: { endpoint: "", apiKey: undefined },
          process: { command: "", args: [], cwd: undefined, env: {} },
        })
      )
    } finally {
      Object.assign(mockAgentManual, previous)
      if (!previous.network) delete mockAgentManual.network
    }
  })

  it("restores the provider undo warning for the selected agent", async () => {
    const user = userEvent.setup()
    render(<ExternalAgentSettings />)
    await act(async () => {
      await user.click(screen.getByTestId("agent-row-agent-2"))
    })
    const detail = await screen.findByTestId("agent-detail-agent-2")
    await act(async () => {
      await user.click(within(detail).getByRole("tab", { name: /advanced/i }))
    })
    await act(async () => {
      await user.click(within(detail).getByTestId("reset-provider-undo-warning"))
    })
    expect(updateConfigMock).toHaveBeenCalledWith("agent-2", {
      metadata: { providerUndoWarningAcknowledged: false },
    })
  })

  it("persists ACP preview capabilities independently in agent metadata", async () => {
    const user = userEvent.setup()
    render(<ExternalAgentSettings />)
    await act(async () => {
      await user.click(screen.getByTestId("agent-row-agent-2"))
    })
    const detail = await screen.findByTestId("agent-detail-agent-2")
    await act(async () => {
      await user.click(within(detail).getByRole("tab", { name: /advanced/i }))
    })
    expect(within(detail).getByTestId("acp-feature-settings")).toBeInTheDocument()
    await act(async () => {
      await user.click(within(detail).getByLabelText(/dynamic mcp/i))
    })
    expect(updateConfigMock).toHaveBeenCalledWith("agent-2", {
      metadata: {
        providerUndoWarningAcknowledged: true,
        acpPreviewFeatures: { dynamicMcp: true },
      },
    })
  })

  // ADR-0182. The header says where the last run actually landed, and says
  // nothing at all for an agent that never asked for a runtime environment.
  describe("the sandbox placement badge", () => {
    afterEach(async () => {
      const { __resetPlacementReportsForTests } = await import("@/lib/sandbox/placement-report")
      __resetPlacementReportsForTests()
    })

    it("shows the Host's placement for the selected agent and nothing for an unplaced one", async () => {
      const { recordPlacementReport } = await import("@/lib/sandbox/placement-report")
      const { TooltipProvider } = await import("@/components/ui/tooltip")
      const user = userEvent.setup()
      // The app mounts the provider in its root layout; a badge rendered
      // alone needs one here.
      render(
        <TooltipProvider>
          <ExternalAgentSettings />
        </TooltipProvider>
      )
      await act(async () => {
        await user.click(screen.getByTestId("agent-row-agent-2"))
      })
      const detail = await screen.findByTestId("agent-detail-agent-2")
      expect(within(detail).queryByTestId("sandbox-placement-sandboxed")).not.toBeInTheDocument()

      act(() => {
        recordPlacementReport({ agentId: "agent-2", kind: "sandbox", tier: "gvisor" })
      })

      // This suite's translator echoes keys; the wording is the badge's own
      // suite's concern. Here: it is mounted, for this agent, once reported.
      expect(await within(detail).findByTestId("sandbox-placement-sandboxed")).toBeInTheDocument()
    })
  })

  it("lands on the All-agents overview until an agent is selected", () => {
    render(<ExternalAgentSettings />)
    // Landing view is the fleet board, not the preset store; no agent detail.
    expect(screen.getByTestId("agent-overview-board")).toBeInTheDocument()
    expect(screen.queryByTestId("agent-detail-agent-1")).not.toBeInTheDocument()
    // Adding stays reachable; the gallery destination has been removed.
    expect(screen.getByTestId("nav-new-agent")).toBeInTheDocument()
    expect(screen.queryByTestId("nav-quick-start")).not.toBeInTheDocument()
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
    // Recommended actions stay collapsed until explicitly requested.
    await user.click(
      within(detail).getByRole("button", { name: /detailsRecommendedActions|Recommended actions/i })
    )
    expect(within(detail).getByText("Install CLI").tagName).toBe("LI")
    expect(within(detail).getByText("Authenticate").tagName).toBe("LI")
    // Selecting the gallery's slot is replaced by the detail pane.
    expect(screen.queryByTestId("preset-picker-list")).not.toBeInTheDocument()
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
    // Landing view is the overview; global settings and delegation are one click.
    await act(async () => {
      await user.click(screen.getByTestId("nav-global-settings"))
    })
    expect(screen.getByTestId("global-settings-card")).toBeInTheDocument()
    expect(screen.queryByTestId("preset-picker-list")).not.toBeInTheDocument()

    await act(async () => {
      await user.click(screen.getByTestId("nav-delegation"))
    })
    expect(screen.queryByTestId("global-settings-card")).not.toBeInTheDocument()
    // Both the rail entry and the panel's own card title carry the label.
    expect(screen.getByRole("heading", { name: "Automatic routing" })).toBeInTheDocument()
  })

  it("says why an agent reconciliation switched off cannot start", async () => {
    // `reviewAll()` has always recorded the verdict and a reason code, and
    // nothing read it back — a blocked agent looked simply disabled.
    const user = userEvent.setup()
    render(<ExternalAgentSettings />)
    await act(async () => {
      await user.click(screen.getByTestId("agent-row-agent-4"))
    })

    const notice = await screen.findByTestId("lifecycle-status-notice")
    expect(notice).toHaveAttribute("data-status", "blocked")
    // The user-facing sentence, never the stored developer string.
    expect(notice).not.toHaveTextContent("no protocol adapter is registered")
  })

  it("offers the way to give consent to an agent that is waiting on one", async () => {
    const user = userEvent.setup()
    render(<ExternalAgentSettings />)
    await act(async () => {
      await user.click(screen.getByTestId("agent-row-agent-5"))
    })

    expect(await screen.findByTestId("lifecycle-status-notice")).toHaveAttribute(
      "data-status",
      "needs-consent"
    )
    // Reporting "needs your permission" with no way to give it is the state
    // this replaces.
    expect(screen.getByTestId("unsandboxed-consent-open")).toBeInTheDocument()
  })

  it("offers no consent action for an agent that is not waiting on one", async () => {
    const user = userEvent.setup()
    render(<ExternalAgentSettings />)
    await act(async () => {
      await user.click(screen.getByTestId("agent-row-agent-4"))
    })
    await screen.findByTestId("lifecycle-status-notice")
    expect(screen.queryByTestId("unsandboxed-consent-open")).not.toBeInTheDocument()
  })

  it("shows no verdict notice for a healthy agent", async () => {
    const user = userEvent.setup()
    render(<ExternalAgentSettings />)
    await act(async () => {
      await user.click(screen.getByTestId("agent-row-agent-1"))
    })
    await screen.findByTestId("agent-detail-agent-1")
    expect(screen.queryByTestId("lifecycle-status-notice")).not.toBeInTheDocument()
  })

  it("keeps runtime governance and DeepSeek Harness together under Runtimes & installs", async () => {
    const user = userEvent.setup()
    render(<ExternalAgentSettings />)
    expect(screen.queryByTestId("deepseek-harness-card")).not.toBeInTheDocument()
    await user.click(screen.getByTestId("nav-runtimes"))
    const detail = screen.getByTestId("agent-detail-slot")
    expect(within(detail).getByTestId("runtime-governance-panel")).toBeInTheDocument()
    expect(within(detail).getByTestId("deepseek-harness-card")).toBeInTheDocument()
    expect(within(detail).getByRole("heading", { name: "Runtimes & installs" })).toBeInTheDocument()
    expect(screen.queryByTestId("nav-quick-start")).not.toBeInTheDocument()
  })

  it("returns to the overview after an agent has been selected", async () => {
    const user = userEvent.setup()
    render(<ExternalAgentSettings />)
    await user.click(screen.getByTestId("agent-row-agent-1"))
    expect(await screen.findByTestId("agent-detail-agent-1")).toBeInTheDocument()
    await user.click(screen.getByTestId("nav-all-agents"))
    expect(screen.getByTestId("agent-overview-board")).toBeInTheDocument()
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
    await openAddPicker(user)
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
    await openAddPicker(user)
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
    await screen.findByTestId("agent-detail-agent-1")
    await act(async () => {
      await user.click(screen.getByTestId("inspector-actions-menu"))
      await user.click(screen.getByRole("menuitem", { name: /delete/i }))
    })
    // The AlertDialog confirmation surfaces (delete title from the messages).
    expect(await screen.findByRole("alertdialog")).toBeInTheDocument()
  })

  it("duplicates the selected agent through a dialog that names the copy and its state", async () => {
    duplicateConfigMock.mockClear()
    const user = userEvent.setup()
    render(<ExternalAgentSettings />)
    await act(async () => {
      await user.click(screen.getByTestId("agent-row-agent-1"))
    })
    await screen.findByTestId("agent-detail-agent-1")
    await act(async () => {
      await user.click(screen.getByTestId("inspector-actions-menu"))
      await user.click(screen.getByRole("menuitem", { name: "Duplicate My Codex" }))
    })
    // Nothing is copied until the user confirms the choices.
    const dialog = await screen.findByTestId("duplicate-agent-dialog")
    expect(duplicateConfigMock).not.toHaveBeenCalled()
    expect(within(dialog).getByTestId("duplicate-agent-name")).toHaveValue("My Codex (copy)")
    await act(async () => {
      await user.click(within(dialog).getByTestId("duplicate-agent-submit"))
    })
    await waitFor(() =>
      expect(duplicateConfigMock).toHaveBeenCalledWith(
        "agent-1",
        expect.objectContaining({ name: "My Codex (copy)", enabled: true })
      )
    )
    expect(toastSuccess).toHaveBeenCalledWith("Agent duplicated")
    // The copy is selected and the dialog is gone.
    await waitFor(() =>
      expect(screen.queryByTestId("duplicate-agent-dialog")).not.toBeInTheDocument()
    )
  })

  it("keeps the duplicate dialog open and says why when the copy is refused", async () => {
    duplicateConfigMock.mockClear()
    duplicateConfigMock.mockRejectedValueOnce(new Error("store locked"))
    const user = userEvent.setup()
    render(<ExternalAgentSettings />)
    await act(async () => {
      await user.click(screen.getByTestId("agent-row-agent-1"))
    })
    await screen.findByTestId("agent-detail-agent-1")
    await act(async () => {
      await user.click(screen.getByTestId("inspector-actions-menu"))
      await user.click(screen.getByRole("menuitem", { name: "Duplicate My Codex" }))
    })
    const dialog = await screen.findByTestId("duplicate-agent-dialog")
    await act(async () => {
      await user.click(within(dialog).getByTestId("duplicate-agent-submit"))
    })
    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(screen.getByTestId("duplicate-agent-dialog")).toBeInTheDocument()
    expect(toastSuccess).not.toHaveBeenCalledWith("Agent duplicated")
  })

  it("confirms the deletion and lands back on the overview", async () => {
    const user = userEvent.setup()
    render(<ExternalAgentSettings />)
    await act(async () => {
      await user.click(screen.getByTestId("agent-row-agent-1"))
    })
    await screen.findByTestId("agent-detail-agent-1")
    await act(async () => {
      await user.click(screen.getByTestId("inspector-actions-menu"))
      await user.click(screen.getByRole("menuitem", { name: /delete/i }))
    })
    const dialog = await screen.findByRole("alertdialog")
    await act(async () => {
      await user.click(within(dialog).getByRole("button", { name: /^delete$/i }))
    })
    await waitFor(() => expect(removeConfigMock).toHaveBeenCalledWith("agent-1"))
    // Deleting the agent under the detail pane must not leave a blank section.
    expect(await screen.findByTestId("agent-overview-board")).toBeInTheDocument()
    expect(screen.queryByTestId("agent-detail-agent-1")).not.toBeInTheDocument()
  })

  it("runs the readiness next action straight from an overview row", async () => {
    const user = userEvent.setup()
    render(<ExternalAgentSettings />)
    const board = screen.getByTestId("agent-overview-board")
    // Blocked-at-startup agent: enabling it goes through the lifecycle service.
    await act(async () => {
      await user.click(within(board).getByTestId("overview-action-agent-4"))
    })
    await waitFor(() => expect(updateConfigMock).toHaveBeenCalledWith("agent-4", { enabled: true }))
    // Off agent: connecting goes through the external-agent hook.
    await act(async () => {
      await user.click(within(board).getByTestId("overview-action-agent-1"))
    })
    await waitFor(() => expect(connectMock).toHaveBeenCalledWith("agent-1"))
  })

  it("routes the add-rule affordance to the delegation panel", async () => {
    const user = userEvent.setup()
    render(<ExternalAgentSettings />)
    // agent-3 is connected but has no routing rule → nextAction "add-rule".
    const board = screen.getByTestId("agent-overview-board")
    await act(async () => {
      await user.click(
        within(within(board).getByTestId("overview-suggestion-agent-3")).getByRole("button", {
          name: "Add routing rule",
        })
      )
    })
    // Board row action → straight to the delegation panel, seeded.
    expect(screen.getByRole("heading", { name: "Automatic routing" })).toBeInTheDocument()
    // The inspector's readiness strip offers the same affordance.
    await act(async () => {
      await user.click(screen.getByTestId("agent-row-agent-3"))
    })
    const detail = await screen.findByTestId("agent-detail-agent-3")
    await act(async () => {
      await user.click(within(detail).getByTestId("inspector-next-action"))
    })
    expect(screen.getByRole("heading", { name: "Automatic routing" })).toBeInTheDocument()
  })

  it("routes a blocked agent's Inspect action to the editor", async () => {
    const blocked = {
      ...mockAgentManual,
      id: "agent-b",
      name: "Blocked Fixture",
      validitySnapshot: { executable: false, blockingReason: "binary missing" },
    } as unknown as ExternalAgentConfig
    const original = externalStoreState.getAllAgents
    externalStoreState.getAllAgents = () => [blocked]
    try {
      const user = userEvent.setup()
      render(<ExternalAgentSettings />)
      const board = screen.getByTestId("agent-overview-board")
      await act(async () => {
        await user.click(within(board).getByTestId("overview-action-agent-b"))
      })
      // Inspect opens the editor in edit mode — the preset picker stays hidden.
      const dialog = await screen.findByRole("dialog")
      expect(within(dialog).getByText("Edit Agent")).toBeInTheDocument()
      expect(within(dialog).queryByTestId("preset-picker")).not.toBeInTheDocument()
    } finally {
      externalStoreState.getAllAgents = original
    }
  })

  it("surfaces a toast when connecting fails", async () => {
    connectMock.mockRejectedValueOnce(new Error("handshake timed out"))
    const user = userEvent.setup()
    render(<ExternalAgentSettings />)
    await act(async () => {
      await user.click(screen.getByTestId("agent-power-agent-1"))
    })
    await waitFor(() => expect(connectMock).toHaveBeenCalledWith("agent-1"))
    // The failure surfaces as a sonner toast with the error's message.
    expect(toastError).toHaveBeenCalledWith(
      "Connection failed",
      expect.objectContaining({ description: "handshake timed out" })
    )
  })

  it("toasts instead of crashing on connect guard, disconnect, delete, and enable failures", async () => {
    const user = userEvent.setup()
    render(<ExternalAgentSettings />)

    // Enable rejection through the readiness action (start on the overview,
    // where the board rows live).
    updateConfigMock.mockRejectedValueOnce(new Error("write conflict"))
    const board = screen.getByTestId("agent-overview-board")
    await act(async () => {
      await user.click(within(board).getByTestId("overview-action-agent-4"))
    })
    await waitFor(() => expect(updateConfigMock).toHaveBeenCalled())
    await waitFor(() => expect(toastError).toHaveBeenCalled())

    // Connect guard: agent vanished between render and click.
    getAgentMock.mockReturnValueOnce(undefined)
    await act(async () => {
      await user.click(screen.getByTestId("agent-power-agent-1"))
    })
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "Connection failed",
        expect.objectContaining({ description: "This agent no longer exists." })
      )
    )

    // Disconnect rejection.
    disconnectMock.mockRejectedValueOnce(new Error("pipe closed"))
    await act(async () => {
      await user.click(screen.getByTestId("agent-power-agent-3"))
    })
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Failed to disconnect"))

    // Delete rejection.
    removeConfigMock.mockRejectedValueOnce(new Error("store locked"))
    await act(async () => {
      await user.click(screen.getByTestId("agent-row-agent-1"))
    })
    await screen.findByTestId("agent-detail-agent-1")
    await act(async () => {
      await user.click(screen.getByTestId("inspector-actions-menu"))
      await user.click(screen.getByRole("menuitem", { name: /delete/i }))
    })
    const dialog = await screen.findByRole("alertdialog")
    await act(async () => {
      await user.click(within(dialog).getByRole("button", { name: /^delete$/i }))
    })
    await waitFor(() => expect(toastError).toHaveBeenCalled())
  })

  it.each(["nav-new-agent", "add-agent-button"])(
    "opens the picker before the editor from %s",
    async (entry) => {
      const user = userEvent.setup()
      render(<ExternalAgentSettings />)
      await user.click(screen.getByTestId(entry))
      const dialog = await screen.findByRole("dialog")
      expect(within(dialog).getByTestId("preset-picker-list")).toBeInTheDocument()
      expect(screen.queryByTestId("agent-editor-fields")).not.toBeInTheDocument()
      await user.click(within(dialog).getByTestId("preset-pick-codex"))
      expect(await screen.findByTestId("preset-summary")).toHaveTextContent("Codex CLI")
      expect(screen.queryByTestId("preset-picker-list")).not.toBeInTheDocument()
    }
  )

  it("keeps a single primary Add action and a seeded inline picker on first run", async () => {
    const original = externalStoreState.getAllAgents
    externalStoreState.getAllAgents = () => []
    try {
      const user = userEvent.setup()
      render(<ExternalAgentSettings />)
      const board = screen.getByTestId("agent-overview-board")
      expect(
        within(board).getByRole("heading", { name: "Add your first agent" })
      ).toBeInTheDocument()
      expect(within(board).queryByRole("button", { name: "Add Agent" })).not.toBeInTheDocument()
      await user.click(screen.getByTestId("add-agent-button"))
      expect(
        within(await screen.findByRole("dialog")).getByTestId("preset-picker-list")
      ).toBeInTheDocument()
      await user.keyboard("{Escape}")
      await user.click(within(board).getByTestId("preset-pick-codex"))
      expect(await screen.findByTestId("preset-summary")).toHaveTextContent("Codex CLI")
    } finally {
      externalStoreState.getAllAgents = original
    }
  })

  it.each(["split", "stacked"] as const)(
    "frames overview and configuration panes only at the split tier (%s)",
    async (density) => {
      mockListDensity = density
      try {
        render(<ExternalAgentSettings />)
        await userEvent.click(screen.getByTestId("nav-all-agents"))
        const overview = screen.getByTestId("agent-overview-board").parentElement!
        if (density === "split") {
          expect(overview).toHaveClass("border", "rounded-lg", "p-4")
        } else {
          expect(overview).not.toHaveClass("border")
          await userEvent.click(screen.getByTestId("external-agent-rail-back"))
        }
        await userEvent.click(screen.getByTestId("nav-global-settings"))
        const globalSettings = screen.getByTestId("global-settings-card").parentElement!
        if (density === "split") {
          expect(globalSettings).toHaveClass("border", "rounded-lg", "p-4")
        } else {
          expect(globalSettings).not.toHaveClass("border")
        }
      } finally {
        mockListDensity = "split"
      }
    }
  )

  it("changes a selected preset through the same picker and supports custom configuration", async () => {
    const user = userEvent.setup()
    render(<ExternalAgentSettings />)
    await openAddPicker(user)
    await user.click(screen.getByTestId("preset-pick-codex"))
    expect(screen.getByTestId("preset-summary")).toHaveTextContent("Codex CLI")
    await user.click(
      within(screen.getByTestId("preset-summary")).getByRole("button", { name: "Change" })
    )
    expect(screen.queryByTestId("agent-editor-fields")).not.toBeInTheDocument()
    await user.click(screen.getByTestId("preset-pick-custom"))
    expect(screen.getByTestId("preset-summary")).toHaveTextContent("Custom configuration")
    expect(screen.queryByTestId("preset-picker")).not.toBeInTheDocument()
    expect(screen.getByLabelText(/^agent name$/i)).toHaveValue("")
  })

  it.each([true, false])(
    "keeps shared preferences labelled and available with retired flag %s",
    async (enabled) => {
      externalStoreState.enabled = enabled
      render(<ExternalAgentSettings />)
      await userEvent.click(screen.getByTestId("nav-global-settings"))
      const page = screen.getByTestId("global-settings-card")
      expect(page.querySelector('[data-slot="card"]')).toBeNull()
      expect(
        within(page).getByRole("heading", {
          name: externalAgentMessages.settings.sectionConnection,
        })
      ).toBeInTheDocument()
      expect(
        within(page).getByRole("heading", { name: externalAgentMessages.settings.sectionDefaults })
      ).toBeInTheDocument()
      const fields = [
        within(page).getByRole("switch", { name: externalAgentMessages.settings.autoConnect }),
        within(page).getByRole("switch", {
          name: externalAgentMessages.settings.showNotifications,
        }),
        within(page).getByRole("combobox", {
          name: externalAgentMessages.settings.defaultPermissionMode,
        }),
        within(page).getByRole("combobox", {
          name: externalAgentMessages.settings.chatFailurePolicy,
        }),
      ]
      for (const field of fields) {
        expect(field).toHaveAccessibleDescription()
        expect(field).toBeEnabled()
      }
    }
  )

  it("opens the preset picker from routing when no agents are configured", async () => {
    render(<ExternalAgentSettings />)
    await userEvent.click(screen.getByTestId("nav-delegation"))
    await userEvent.click(
      within(screen.getByTestId("delegation-rules-section")).getByRole("button", {
        name: "Add agent",
      })
    )
    expect(await screen.findByTestId("preset-picker-list")).toBeInTheDocument()
  })

  it("opens a disabled target from routing through the existing destination navigation", async () => {
    externalStoreState.agents = { [mockAgentBlocked.id]: mockAgentBlocked }
    try {
      render(<ExternalAgentSettings />)
      await userEvent.click(screen.getByTestId("nav-delegation"))
      await userEvent.click(
        within(screen.getByTestId("delegation-rules-section")).getByRole("button", {
          name: `Open ${mockAgentBlocked.name}`,
        })
      )
      expect(screen.getByTestId(`agent-detail-${mockAgentBlocked.id}`)).toBeInTheDocument()
    } finally {
      externalStoreState.agents = {}
    }
  })

  it("persists the global settings selects through the store setters", async () => {
    const user = userEvent.setup()
    render(<ExternalAgentSettings />)
    await act(async () => {
      await user.click(screen.getByTestId("nav-global-settings"))
    })
    const card = await screen.findByTestId("global-settings-card")
    const selects = within(card).getAllByRole("combobox")
    // Permission mode → plan; failure policy → strict.
    await act(async () => {
      await user.click(selects[0])
    })
    await act(async () => {
      await user.click(await screen.findByRole("option", { name: /plan/i }))
    })
    expect(externalStoreState.setDefaultPermissionMode).toHaveBeenCalledWith("plan")
    await act(async () => {
      await user.click(selects[1])
    })
    await act(async () => {
      await user.click(await screen.findByRole("option", { name: /strict/i }))
    })
    expect(externalStoreState.setChatFailurePolicy).toHaveBeenCalledWith("strict")
  })
})

describe("ExternalAgentSettings — overview board", () => {
  it("renders one readiness row per agent with its state pill and next action", () => {
    render(<ExternalAgentSettings />)
    const board = screen.getByTestId("agent-overview-board")
    // Five fixture agents: agent-3 is connected, agent-4/-5 are disabled.
    expect(within(board).getByTestId("overview-row-agent-1")).toBeInTheDocument()
    expect(within(board).getByTestId("overview-row-agent-5")).toBeInTheDocument()
    // agent-1 is enabled + disconnected → the model offers Connect.
    expect(within(board).getByTestId("overview-action-agent-1")).toHaveTextContent("Connect")
    // agent-4 is deliberately off → the action is Enable, not a fake failure.
    expect(within(board).getByTestId("overview-action-agent-4")).toHaveTextContent("Enable")
  })

  it("opens the agent inspector from an overview row", async () => {
    const user = userEvent.setup()
    render(<ExternalAgentSettings />)
    await act(async () => {
      await user.click(screen.getByTestId("overview-open-agent-1"))
    })
    expect(await screen.findByTestId("agent-detail-agent-1")).toBeInTheDocument()
    expect(screen.getByTestId("inspector-readiness")).toBeInTheDocument()
    // And back — the overview stays one click away in the rail.
    await act(async () => {
      await user.click(screen.getByTestId("nav-all-agents"))
    })
    expect(screen.getByTestId("agent-overview-board")).toBeInTheDocument()
  })

  it("filters the rail from the summary and clears the filter chip", async () => {
    const user = userEvent.setup()
    render(<ExternalAgentSettings />)
    const filter = screen.getByTestId("overview-filter-connected")
    await user.click(filter)
    expect(filter).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByTestId("agent-row-agent-3")).toBeInTheDocument()
    expect(screen.queryByTestId("agent-row-agent-1")).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Clear state filter" }))
    expect(filter).toHaveAttribute("aria-pressed", "false")
    expect(screen.getByTestId("agent-row-agent-1")).toBeInTheDocument()
    expect(screen.queryByTestId("fleet-banner-expanded")).not.toBeInTheDocument()
  })
})

describe("ExternalAgentSettings — mandatory sandbox platform gate", () => {
  afterEach(() => {
    isTauriMock.mockReturnValue(false)
    platformMock.mockReturnValue("macos")
  })

  it("says nothing in a browser shell, which has no spawn path to sandbox", () => {
    isTauriMock.mockReturnValue(false)
    platformMock.mockReturnValue("windows")
    render(<ExternalAgentSettings />)
    expect(screen.queryByTestId("external-agent-sandbox-unavailable")).not.toBeInTheDocument()
  })

  it("says nothing on a platform that can sandbox", () => {
    isTauriMock.mockReturnValue(true)
    platformMock.mockReturnValue("macos")
    render(<ExternalAgentSettings />)
    expect(screen.queryByTestId("external-agent-sandbox-unavailable")).not.toBeInTheDocument()
  })

  it("stays silent when the OS plugin itself is unavailable", () => {
    // Older shells lack the os plugin — refusing here would banner users we
    // know nothing about, so the gate fails open.
    isTauriMock.mockReturnValue(true)
    platformMock.mockImplementationOnce(() => {
      throw new Error("plugin:os not registered")
    })
    render(<ExternalAgentSettings />)
    expect(screen.queryByTestId("external-agent-sandbox-unavailable")).not.toBeInTheDocument()
  })

  it("warns on Windows BEFORE the user configures an agent", () => {
    // The only thing that knew this before was a throw inside the CLI's
    // launcher, so a Windows user could configure an agent, save it, connect
    // it, and only then find out it could never have run.
    isTauriMock.mockReturnValue(true)
    platformMock.mockReturnValue("windows")
    render(<ExternalAgentSettings />)
    expect(screen.getByTestId("external-agent-sandbox-unavailable")).toHaveTextContent(
      /mandatory sandbox/i
    )
  })

  it("offers no directory affordance where no picker exists", async () => {
    // `pickDirectory` resolves null off Tauri, so both of these buttons used to
    // be present-and-inert: a click did nothing and nothing said why. The
    // textarea and the working-directory input are the controls there.
    const user = userEvent.setup()
    isTauriMock.mockReturnValue(false)
    render(<ExternalAgentSettings />)
    await openAddPicker(user)
    await act(async () => {
      await user.click(screen.getByTestId("preset-pick-codex-app-server"))
    })

    expect(await screen.findByTestId("codex-skill-roots")).toBeInTheDocument()
    expect(screen.queryByTestId("codex-skill-roots-browse")).not.toBeInTheDocument()
    expect(screen.queryByTestId("cwd-browse")).not.toBeInTheDocument()
    expect(pickDirectoryMock).not.toHaveBeenCalled()
  })
})

describe("dirty inspector navigation", () => {
  beforeEach(() => {
    mockListDensity = "split"
    removeConfigMock.mockReset().mockResolvedValue(undefined)
  })
  afterEach(() => {
    mockListDensity = "split"
  })

  async function editInspector() {
    await act(async () => fireEvent.click(screen.getByTestId("agent-row-agent-1")))
    fireEvent.change(screen.getByTestId("inspector-description"), {
      target: { value: "Unsaved description" },
    })
  }

  it.each(["agent", "destination"] as const)(
    "keeps editing on cancelled %s navigation",
    async (destination) => {
      render(<ExternalAgentSettings />)
      await editInspector()
      await act(async () =>
        fireEvent.click(
          screen.getByTestId(destination === "agent" ? "agent-row-agent-2" : "nav-runtimes")
        )
      )
      const dialog = screen.getByRole("alertdialog")
      expect(dialog).toHaveTextContent(externalAgentMessages.settings.discardDraftDescription)
      fireEvent.click(
        within(dialog).getByRole("button", { name: externalAgentMessages.settings.keepEditing })
      )
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
      expect(screen.getByTestId("agent-detail-agent-1")).toBeInTheDocument()
      expect(screen.getByTestId("inspector-description")).toHaveValue("Unsaved description")
    }
  )

  it.each(["agent", "destination"] as const)(
    "discards and completes pending %s navigation",
    async (destination) => {
      render(<ExternalAgentSettings />)
      await editInspector()
      await act(async () =>
        fireEvent.click(
          screen.getByTestId(destination === "agent" ? "agent-row-agent-2" : "nav-runtimes")
        )
      )
      await act(async () =>
        fireEvent.click(
          within(screen.getByRole("alertdialog")).getByRole("button", {
            name: externalAgentMessages.settings.discardDraft,
          })
        )
      )
      expect(screen.queryByTestId("agent-detail-agent-1")).not.toBeInTheDocument()
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
      if (destination === "agent")
        expect(screen.getByTestId("agent-detail-agent-2")).toBeInTheDocument()
      if (destination === "destination")
        expect(screen.getByTestId("runtime-governance-panel")).toBeInTheDocument()
    }
  )

  it("does not guard reselecting the same agent and clears the guard after discarding the draft", async () => {
    render(<ExternalAgentSettings />)
    await editInspector()
    fireEvent.click(screen.getByTestId("agent-row-agent-1"))
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId("unsaved-bar-discard"))
    await act(async () => fireEvent.click(screen.getByTestId("agent-row-agent-2")))
    expect(screen.getByTestId("agent-detail-agent-2")).toBeInTheDocument()
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
  })

  it("clears dirty when the inspected agent is deleted", async () => {
    render(<ExternalAgentSettings />)
    await editInspector()
    await userEvent.click(screen.getByTestId("inspector-actions-menu"))
    await userEvent.click(screen.getByRole("menuitem", { name: /delete/i }))
    await act(async () =>
      fireEvent.click(
        within(screen.getByRole("alertdialog")).getByRole("button", { name: /^delete$/i })
      )
    )
    expect(removeConfigMock).toHaveBeenCalledWith("agent-1")
    expect(screen.getByTestId("agent-overview-board")).toBeInTheDocument()
    await act(async () => fireEvent.click(screen.getByTestId("agent-row-agent-2")))
    expect(screen.getByTestId("agent-detail-agent-2")).toBeInTheDocument()
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
  })
})

describe("stacked detail focus", () => {
  beforeEach(() => {
    mockListDensity = "stacked"
  })
  afterEach(() => {
    mockListDensity = "split"
  })

  it.each([
    "agent-row-agent-1",
    "nav-all-agents",
    "nav-global-settings",
    "nav-delegation",
    "nav-runtimes",
    "nav-host-configs",
  ])("focuses the detail heading and returns to %s on Back", async (item) => {
    render(<ExternalAgentSettings />)
    await userEvent.click(screen.getByTestId(item))
    expect(screen.queryByTestId("add-agent-button")).not.toBeInTheDocument()
    expect(
      screen.queryByRole("heading", { name: externalAgentMessages.settings.title })
    ).not.toBeInTheDocument()
    expect(document.getElementById("external-agents-enabled")).not.toBeInTheDocument()
    const detail = screen.getByTestId("agent-detail-slot")
    const heading = detail.querySelector<HTMLElement>("[data-detail-heading]")!
    expect(heading).not.toBeNull()
    expect(heading.tagName).toMatch(/^H[1-6]$/)
    expect(heading).toHaveAttribute("tabindex", "-1")
    await waitFor(() => expect(heading).toHaveFocus())
    await userEvent.click(screen.getByTestId("external-agent-rail-back"))
    await waitFor(() => expect(screen.getByTestId(item)).toHaveFocus())
    expect(screen.getByTestId("add-agent-button")).toBeInTheDocument()
  })

  it("keeps the mobile host notice while the page header is hidden", async () => {
    mockNativeMobile = true
    try {
      render(<ExternalAgentSettings />)
      await userEvent.click(screen.getByTestId("nav-global-settings"))
      expect(screen.queryByTestId("add-agent-button")).not.toBeInTheDocument()
      expect(screen.getByTestId("external-agent-mobile-notice")).toBeInTheDocument()
    } finally {
      mockNativeMobile = false
    }
  })

  it("keeps the sandbox notice while the page header is hidden", async () => {
    isTauriMock.mockReturnValue(true)
    platformMock.mockReturnValue("windows")
    try {
      render(<ExternalAgentSettings />)
      await userEvent.click(screen.getByTestId("nav-global-settings"))
      expect(screen.queryByTestId("add-agent-button")).not.toBeInTheDocument()
      expect(screen.getByTestId("external-agent-sandbox-unavailable")).toBeInTheDocument()
    } finally {
      isTauriMock.mockReturnValue(false)
      platformMock.mockReturnValue("macos")
    }
  })

  it("returns from mobile detail without an inspector dirty guard", async () => {
    render(<ExternalAgentSettings />)
    await userEvent.click(screen.getByTestId("agent-row-agent-1"))
    await waitFor(() => expect(screen.getByRole("heading", { name: "My Codex" })).toHaveFocus())
    await userEvent.click(screen.getByTestId("external-agent-rail-back"))
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId("agent-row-agent-1")).toHaveFocus())
  })

  it("clears a pending discard prompt when stacked and keeps it cleared after widening", async () => {
    mockListDensity = "split"
    const view = render(<ExternalAgentSettings />)
    await userEvent.click(screen.getByTestId("agent-row-agent-1"))
    fireEvent.change(screen.getByTestId("inspector-description"), { target: { value: "Draft" } })
    await userEvent.click(screen.getByTestId("agent-row-agent-2"))
    expect(screen.getByRole("alertdialog")).toBeInTheDocument()
    mockListDensity = "stacked"
    view.rerender(<ExternalAgentSettings />)
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
    expect(screen.getByTestId("agent-mobile-detail-agent-1")).toBeInTheDocument()
    mockListDensity = "split"
    view.rerender(<ExternalAgentSettings />)
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
    expect(screen.getByTestId("agent-detail-agent-1")).toBeInTheDocument()
    await userEvent.click(screen.getByTestId("agent-row-agent-2"))
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
    expect(screen.getByTestId("agent-detail-agent-2")).toBeInTheDocument()
  })

  it("drops the wide inspector guard when the pane becomes stacked", async () => {
    mockListDensity = "split"
    const view = render(<ExternalAgentSettings />)
    await userEvent.click(screen.getByTestId("agent-row-agent-1"))
    fireEvent.change(screen.getByTestId("inspector-description"), { target: { value: "Draft" } })
    mockListDensity = "stacked"
    view.rerender(<ExternalAgentSettings />)
    expect(screen.getByTestId("agent-mobile-detail-agent-1")).toBeInTheDocument()
    await userEvent.click(screen.getByTestId("external-agent-rail-back"))
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
    expect(screen.getByTestId("agent-row-agent-1")).toBeInTheDocument()
    mockListDensity = "split"
    view.rerender(<ExternalAgentSettings />)
    await userEvent.click(screen.getByTestId("agent-row-agent-2"))
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
    expect(screen.getByTestId("agent-detail-agent-2")).toBeInTheDocument()
  })
})

it("makes managed terminal agents reachable from agent settings", () => {
  render(<ExternalAgentSettings />)
  expect(
    screen.getByRole("button", {
      name: `${externalAgentMessages.manager.terminalAgents.title} ${externalAgentMessages.manager.terminalAgents.terminalOnly}`,
    })
  ).toBeInTheDocument()
})
