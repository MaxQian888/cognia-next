/**
 * AgentEditorDialog — extracted from the settings shell; the deep editor.
 * Verifies the dialog opens in create vs edit mode, runs preset seeding,
 * and produces a CreateExternalAgentInput on save.
 */

import { render, screen, act, within, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { AgentEditorDialog, isApprovalEntryValid } from "./agent-editor-dialog"
import { __resetRoutingForTests, setActiveRemoteTransport } from "@/lib/tauri/transport-routing"
import type { Transport } from "@/lib/tauri/transport-types"
import type { ExternalAgentConfig } from "@/types/agent/external-agent"

// The routing plane is real: the dialog subscribes to it, so a test can attach
// a remote Host under an open dialog and watch the picker follow.
const remoteTransport: Transport = {
  call: jest.fn(async () => undefined) as Transport["call"],
  subscribe: jest.fn(() => () => undefined) as unknown as Transport["subscribe"],
}
afterEach(() => __resetRoutingForTests())
jest.mock("@/hooks/files/use-directory-picker", () => ({
  useDirectoryPicker: () => ({ available: true, busy: false, browse: jest.fn() }),
}))

const existingAgent: ExternalAgentConfig = {
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
  metadata: { preset: "codex" },
  createdAt: new Date(0),
  updatedAt: new Date(0),
}

jest.mock("@/stores/agent/external-agent-store", () => ({
  useExternalAgentStore: (sel?: (s: Record<string, unknown>) => unknown) => {
    const s = { getAgent: (id: string) => (id === "agent-1" ? existingAgent : undefined) }
    return sel ? sel(s) : s
  },
}))

jest.mock("@/components/agent/external-agent/cognia-model-picker", () => ({
  CogniaModelPicker: () => <div data-testid="cognia-model-picker" />,
}))

jest.mock("@/lib/files/file-bridge", () => ({
  pickDirectory: () => Promise.resolve(null),
}))

jest.mock("@/components/ui/sonner", () => ({
  toast: { error: jest.fn(), success: jest.fn() },
}))

jest.mock("@/hooks/ui/use-mobile", () => ({ useIsMobile: jest.fn(() => false) }))

jest.mock("@/lib/platform/detect", () => ({
  ...jest.requireActual("@/lib/platform/detect"),
  isTauri: jest.fn(() => false),
}))

jest.mock("@/lib/subscription/core/hooks", () => ({
  useAccounts: jest.fn(() => ({
    accounts: [],
    activeAccountId: null,
    loading: false,
    error: null,
  })),
}))

jest.mock("@/lib/ai/agent/external/lifecycle/service", () => {
  const clearCredentialSlot = jest.fn(async () => undefined)
  return {
    __clearCredentialSlot: clearCredentialSlot,
    getExternalAgentLifecycleService: jest.fn(async () => ({ clearCredentialSlot })),
  }
})

import { toast } from "@/components/ui/sonner"
import { useIsMobile } from "@/hooks/ui/use-mobile"
import { isTauri } from "@/lib/platform/detect"
import { useAccounts } from "@/lib/subscription/core/hooks"
import * as lifecycleModule from "@/lib/ai/agent/external/lifecycle/service"

const clearCredentialSlotMock = (lifecycleModule as unknown as { __clearCredentialSlot: jest.Mock })
  .__clearCredentialSlot
const useIsMobileMock = useIsMobile as jest.Mock
const isTauriMock = isTauri as jest.Mock
const useAccountsMock = useAccounts as jest.Mock
const toastErrorMock = toast.error as jest.Mock

beforeEach(() => {
  clearCredentialSlotMock.mockClear()
  toastErrorMock.mockClear()
  useIsMobileMock.mockReturnValue(false)
  isTauriMock.mockReturnValue(false)
  useAccountsMock.mockReturnValue({
    accounts: [],
    activeAccountId: null,
    loading: false,
    error: null,
  })
})

/** Run `body` with the fixture agent temporarily changed, restoring it after. */
async function withAgent(patch: Record<string, unknown>, body: () => Promise<void> | void) {
  const original = { ...existingAgent }
  Object.assign(existingAgent, patch)
  try {
    await body()
  } finally {
    for (const key of Object.keys(existingAgent)) {
      delete (existingAgent as unknown as Record<string, unknown>)[key]
    }
    Object.assign(existingAgent, original)
  }
}

describe("AgentEditorDialog", () => {
  it("seeds Kimi subscription ACP and saves isolated state through the masked env editor", async () => {
    const onSave = jest.fn().mockResolvedValue(true)
    render(<AgentEditorDialog open onOpenChange={jest.fn()} initialPreset="kimi" onSave={onSave} />)
    expect(screen.getByLabelText(/^command$/i)).toHaveValue("kimi")
    expect(screen.getByText(/kimi login/)).toBeInTheDocument()
    const editor = screen
      .getByText("Kimi Code authentication and configuration")
      .closest('[data-slot="ai-environment-variables"]') as HTMLElement
    await userEvent.click(within(editor).getByRole("button", { name: /^add$/i }))
    await userEvent.type(screen.getByPlaceholderText("Variable name"), "KIMI_CODE_HOME")
    const value = screen.getByPlaceholderText("Variable value")
    expect(value).toHaveAttribute("type", "password")
    await userEvent.type(value, "/workspace/kimi-state")
    await userEvent.click(screen.getAllByRole("button", { name: /^add$/i }).at(-1)!)
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        protocol: "acp",
        metadata: expect.objectContaining({
          preset: "kimi",
          acpPreviewFeatures: { sessionFork: true },
        }),
        process: expect.objectContaining({
          command: "kimi",
          args: ["acp"],
          env: { KIMI_CODE_HOME: "/workspace/kimi-state" },
        }),
      })
    )
  })

  it("round-trips custom argument boundaries and environment when only the name changes", async () => {
    const original = existingAgent.process
    existingAgent.process = {
      command: "/opt/agents/custom-agent",
      args: [
        "--config",
        "/workspace/my project/config.json",
        "",
        '{"persona":"review code"}',
        "it's literal",
        "C:\\agents\\config",
      ],
      env: { AGENT_CONFIG: "/workspace/config.json", CUSTOM_SETTING: "keep me" },
    }
    try {
      const onSave = jest.fn().mockResolvedValue(true)
      render(
        <AgentEditorDialog open editingAgentId="agent-1" onOpenChange={jest.fn()} onSave={onSave} />
      )
      await userEvent.type(screen.getByLabelText(/agent name/i), " renamed")
      await userEvent.click(screen.getByRole("button", { name: /^save$/i }))
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({ process: expect.objectContaining(existingAgent.process) })
      )
    } finally {
      existingAgent.process = original
    }
  })

  it("rejects incomplete quoted arguments instead of saving a broken launch", async () => {
    const onSave = jest.fn().mockResolvedValue(true)
    render(
      <AgentEditorDialog open editingAgentId="agent-1" onOpenChange={jest.fn()} onSave={onSave} />
    )
    await userEvent.clear(screen.getByLabelText(/^arguments$/i))
    await userEvent.type(screen.getByLabelText(/^arguments$/i), '--config "unfinished path')
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }))
    expect(onSave).not.toHaveBeenCalled()
  })

  it("saves environment customization for a generic ACP Agent", async () => {
    const onSave = jest.fn().mockResolvedValue(true)
    render(
      <AgentEditorDialog open editingAgentId="agent-1" onOpenChange={jest.fn()} onSave={onSave} />
    )
    await userEvent.click(screen.getByRole("button", { name: /process environment variables/i }))
    const section = screen.getByTestId("process-environment-section")
    await userEvent.click(within(section).getByRole("button", { name: /^add$/i }))
    await userEvent.type(screen.getByPlaceholderText("Variable name"), "AGENT_PERSONA")
    const value = screen.getByPlaceholderText("Variable value")
    expect(value).toHaveAttribute("type", "password")
    await userEvent.type(value, "code reviewer")
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }))
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        process: expect.objectContaining({ env: { AGENT_PERSONA: "code reviewer" } }),
      })
    )
  })

  it("does not browse this computer for paths belonging to a remote execution Host", () => {
    setActiveRemoteTransport(remoteTransport)
    render(
      <AgentEditorDialog
        open
        editingAgentId="agent-1"
        onOpenChange={jest.fn()}
        onSave={jest.fn()}
      />
    )
    expect(screen.queryByTestId("cwd-browse")).not.toBeInTheDocument()
    expect(screen.getByLabelText(/working directory/i)).toBeInTheDocument()
  })

  it("follows a Host switch while the dialog stays open", () => {
    render(
      <AgentEditorDialog
        open
        editingAgentId="agent-1"
        onOpenChange={jest.fn()}
        onSave={jest.fn()}
      />
    )
    expect(screen.getByTestId("cwd-browse")).toBeInTheDocument()

    // No prop changes: only the desktop attaching to a remote Host.
    act(() => setActiveRemoteTransport(remoteTransport))
    expect(screen.queryByTestId("cwd-browse")).not.toBeInTheDocument()

    act(() => setActiveRemoteTransport(null))
    expect(screen.getByTestId("cwd-browse")).toBeInTheDocument()
  })

  it("seeds Cline's documented ACP launch and saves a masked API key and custom config root", async () => {
    const onSave = jest.fn().mockResolvedValue(true)
    render(
      <AgentEditorDialog open onOpenChange={jest.fn()} initialPreset="cline" onSave={onSave} />
    )
    expect(screen.getByLabelText(/^command$/i)).toHaveValue("cline")
    expect(screen.getByText(/cline auth/)).toBeInTheDocument()
    const editor = screen
      .getByText("Cline authentication and configuration")
      .closest('[data-slot="ai-environment-variables"]') as HTMLElement
    await userEvent.click(within(editor).getByRole("button", { name: /^add$/i }))
    await userEvent.type(screen.getByPlaceholderText("Variable name"), "CLINE_API_KEY")
    const value = screen.getByPlaceholderText("Variable value")
    expect(value).toHaveAttribute("type", "password")
    await userEvent.type(value, "synthetic-cline-pat")
    await userEvent.click(screen.getAllByRole("button", { name: /^add$/i }).at(-1)!)
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        protocol: "acp",
        metadata: expect.objectContaining({ preset: "cline" }),
        process: expect.objectContaining({
          command: "cline",
          args: expect.arrayContaining(["--acp", "--auto-approve", "false"]),
          env: { CLINE_API_KEY: "synthetic-cline-pat" },
        }),
      })
    )
  })

  it("seeds Qoder's documented ACP launch and saves a masked PAT and custom config root", async () => {
    const onSave = jest.fn().mockResolvedValue(true)
    render(
      <AgentEditorDialog open onOpenChange={jest.fn()} initialPreset="qoder" onSave={onSave} />
    )
    expect(screen.getByLabelText(/^command$/i)).toHaveValue("qoder")
    expect(screen.getByText(/qoder login/)).toBeInTheDocument()
    const editor = screen
      .getByText("Qoder authentication and configuration")
      .closest('[data-slot="ai-environment-variables"]') as HTMLElement
    await userEvent.click(within(editor).getByRole("button", { name: /^add$/i }))
    await userEvent.type(
      screen.getByPlaceholderText("Variable name"),
      "QODER_PERSONAL_ACCESS_TOKEN"
    )
    const value = screen.getByPlaceholderText("Variable value")
    expect(value).toHaveAttribute("type", "password")
    await userEvent.type(value, "synthetic-qoder-pat")
    await userEvent.click(screen.getAllByRole("button", { name: /^add$/i }).at(-1)!)
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        protocol: "acp",
        metadata: expect.objectContaining({ preset: "qoder" }),
        process: expect.objectContaining({
          command: "qoder",
          args: expect.arrayContaining([
            "--acp",
            "--strict-mcp-config",
            '{"general":{"enableAutoUpdate":false}}',
          ]),
          env: { QODER_PERSONAL_ACCESS_TOKEN: "synthetic-qoder-pat" },
        }),
      })
    )
  })

  it("saves Aider provider environment values through the existing masked key/value editor", async () => {
    const onSave = jest.fn().mockResolvedValue(true)
    render(
      <AgentEditorDialog open onOpenChange={jest.fn()} initialPreset="aider" onSave={onSave} />
    )
    await userEvent.click(
      within(
        screen
          .getByText("Provider environment variables")
          .closest('[data-slot="ai-environment-variables"]') as HTMLElement
      ).getByRole("button", { name: /^add$/i })
    )
    await userEvent.type(screen.getByPlaceholderText("Variable name"), "DEEPSEEK_API_KEY")
    const value = screen.getByPlaceholderText("Variable value")
    expect(value).toHaveAttribute("type", "password")
    await userEvent.type(value, "fixture-provider-key")
    await userEvent.click(screen.getAllByRole("button", { name: /^add$/i }).at(-1)!)
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        process: expect.objectContaining({
          env: { DEEPSEEK_API_KEY: "fixture-provider-key" },
        }),
      })
    )
  })
  it("seeds Aider's official CLI launch and saves it through the existing configuration flow", async () => {
    const onSave = jest.fn().mockResolvedValue(true)
    render(
      <AgentEditorDialog open onOpenChange={jest.fn()} initialPreset="aider" onSave={onSave} />
    )
    expect(screen.getByLabelText(/^command$/i)).toHaveValue("aider")
    expect(screen.getByText(/uv tool install/)).toBeInTheDocument()
    await act(async () => {
      await userEvent.click(screen.getAllByRole("button", { name: /^add$/i }).at(-1)!)
    })
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        protocol: "aider-cli",
        transport: "stdio",
        process: expect.objectContaining({
          command: "aider",
          args: [],
        }),
        metadata: expect.objectContaining({ preset: "aider" }),
      })
    )
  })

  it("seeds Goose's native launch and saves it through the existing configuration flow", async () => {
    const onSave = jest.fn().mockResolvedValue(true)
    render(
      <AgentEditorDialog open onOpenChange={jest.fn()} initialPreset="goose" onSave={onSave} />
    )
    expect(screen.getByLabelText(/^command$/i)).toHaveValue("goose")
    expect(screen.getByDisplayValue("acp --with-builtin developer")).toBeInTheDocument()
    expect(screen.getByText(/brew install block-goose-cli/)).toBeInTheDocument()
    await act(async () => {
      await userEvent.click(screen.getByRole("button", { name: /^add$/i }))
    })
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        protocol: "acp",
        transport: "stdio",
        process: expect.objectContaining({
          command: "goose",
          args: ["acp", "--with-builtin", "developer"],
        }),
        metadata: expect.objectContaining({ preset: "goose" }),
      })
    )
  })

  it("opts a pi-rpc agent into plugin Pi packages and keeps an unavailable saved reference", async () => {
    const { registerContributedPiPackage, __resetContributedPiPackagesForTesting } =
      jest.requireActual<typeof import("@/lib/plugin/pi-packages/registry")>(
        "@/lib/plugin/pi-packages/registry"
      )
    registerContributedPiPackage(
      {
        id: "latex",
        name: "LaTeX workbench",
        path: "pi",
        hostedSession: { extensions: ["pi/latex.ts"], tools: ["latex_compile"] },
      },
      { pluginId: "latex-workbench", installRoot: "/p/latex-workbench" }
    )
    const original = { ...existingAgent }
    existingAgent.protocol = "pi-rpc"
    existingAgent.process = { command: "pi", args: ["--mode", "rpc"] }
    existingAgent.metadata = { piExtensionPolicy: "isolated", piPackages: ["gone/pkg"] }
    try {
      const onSave = jest.fn().mockResolvedValue(true)
      render(
        <AgentEditorDialog open editingAgentId="agent-1" onOpenChange={jest.fn()} onSave={onSave} />
      )
      expect(screen.getByTestId("pi-plugin-packages-unavailable")).toHaveTextContent("gone/pkg")
      await userEvent.click(
        within(screen.getByTestId("pi-plugin-package-latex-workbench-latex")).getByRole("checkbox")
      )
      await userEvent.click(screen.getByRole("button", { name: /^save$/i }))
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            piExtensionPolicy: "isolated",
            piPackages: ["gone/pkg", "latex-workbench/latex"],
          }),
        })
      )
    } finally {
      Object.assign(existingAgent, original)
      __resetContributedPiPackagesForTesting()
    }
  })

  it("opens in create mode with the preset picker and blank name", () => {
    render(<AgentEditorDialog open onOpenChange={jest.fn()} onSave={jest.fn()} />)
    expect(screen.getByTestId("preset-picker")).toBeInTheDocument()
    expect(screen.getByLabelText(/agent name/i)).toHaveValue("")
  })

  it("opens in edit mode seeded from the stored agent, without the preset picker", () => {
    render(
      <AgentEditorDialog
        open
        onOpenChange={jest.fn()}
        editingAgentId="agent-1"
        onSave={jest.fn()}
      />
    )
    expect(screen.queryByTestId("preset-picker")).not.toBeInTheDocument()
    expect(screen.getByDisplayValue("My Codex")).toBeInTheDocument()
    expect(screen.getByDisplayValue("npx")).toBeInTheDocument()
  })

  it("validates the name and produces a create input on save", async () => {
    const user = userEvent.setup()
    const onSave = jest.fn().mockResolvedValue(true)
    render(<AgentEditorDialog open onOpenChange={jest.fn()} onSave={onSave} />)

    await act(async () => {
      await user.click(screen.getByRole("button", { name: /^add$/i }))
    })
    expect(onSave).not.toHaveBeenCalled()

    await user.type(screen.getByLabelText(/agent name/i), "Local Claude")
    await user.type(screen.getByLabelText(/^command$/i), "claude")
    await act(async () => {
      await user.click(screen.getByRole("button", { name: /^add$/i }))
    })
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Local Claude",
        protocol: "acp",
        process: expect.objectContaining({ command: "claude" }),
      })
    )
  })

  it("seeds fields from a preset id", () => {
    render(
      <AgentEditorDialog open onOpenChange={jest.fn()} initialPreset="devin" onSave={jest.fn()} />
    )
    expect(screen.getByDisplayValue("Devin CLI")).toBeInTheDocument()
  })

  describe("awaited save", () => {
    it("shows a saving state, freezes the form, and closes itself once saved", async () => {
      let resolveSave: (saved: boolean) => void = () => undefined
      const onSave = jest.fn(
        () =>
          new Promise<boolean>((resolve) => {
            resolveSave = resolve
          })
      )
      const onOpenChange = jest.fn()
      render(
        <AgentEditorDialog
          open
          editingAgentId="agent-1"
          onOpenChange={onOpenChange}
          onSave={onSave}
        />
      )
      await userEvent.click(screen.getByRole("button", { name: /^save$/i }))
      expect(onSave).toHaveBeenCalledTimes(1)
      expect(screen.getByRole("button", { name: /saving/i })).toBeDisabled()
      expect(screen.getByRole("button", { name: /^cancel$/i })).toBeDisabled()
      expect(screen.getByLabelText(/agent name/i)).toBeDisabled()
      // Escape while saving must not drop the dialog.
      await userEvent.keyboard("{Escape}")
      expect(onOpenChange).not.toHaveBeenCalledWith(false)

      await act(async () => resolveSave(true))
      expect(onOpenChange).toHaveBeenCalledWith(false)
    })

    it("keeps the dialog open with the user's input when the save fails", async () => {
      const onSave = jest.fn().mockResolvedValue(false)
      const onOpenChange = jest.fn()
      render(
        <AgentEditorDialog
          open
          editingAgentId="agent-1"
          onOpenChange={onOpenChange}
          onSave={onSave}
        />
      )
      const name = screen.getByLabelText(/agent name/i)
      await userEvent.clear(name)
      await userEvent.type(name, "Renamed Codex")
      await userEvent.click(screen.getByRole("button", { name: /^save$/i }))
      await waitFor(() => expect(screen.getByRole("button", { name: /^save$/i })).toBeEnabled())
      expect(onOpenChange).not.toHaveBeenCalledWith(false)
      expect(screen.getByLabelText(/agent name/i)).toHaveValue("Renamed Codex")
      expect(screen.getByLabelText(/agent name/i)).toBeEnabled()
    })

    it("treats a rejected save as a failure and says so", async () => {
      const onSave = jest.fn().mockRejectedValue(new Error("disk full"))
      const onOpenChange = jest.fn()
      render(
        <AgentEditorDialog
          open
          editingAgentId="agent-1"
          onOpenChange={onOpenChange}
          onSave={onSave}
        />
      )
      await userEvent.click(screen.getByRole("button", { name: /^save$/i }))
      await waitFor(() =>
        expect(toastErrorMock).toHaveBeenCalledWith(expect.stringMatching(/disk full/))
      )
      expect(onOpenChange).not.toHaveBeenCalledWith(false)
      expect(screen.getByRole("button", { name: /^save$/i })).toBeEnabled()
    })
  })

  describe("labels and ids", () => {
    it("associates every label with a control through instance-scoped ids", () => {
      render(
        <AgentEditorDialog
          open
          editingAgentId="agent-1"
          onOpenChange={jest.fn()}
          onSave={jest.fn()}
        />
      )
      const dialog = screen.getByRole("dialog")
      const labels = Array.from(dialog.querySelectorAll("label[for]"))
      expect(labels.length).toBeGreaterThan(5)
      for (const label of labels) {
        const id = label.getAttribute("for")!
        expect(document.getElementById(id)).not.toBeNull()
      }
      // No bare global ids left to collide with another form on the page.
      for (const bare of ["name", "command", "args", "cwd", "endpoint", "apiKey"]) {
        expect(document.getElementById(bare)).toBeNull()
      }
      expect(screen.getByLabelText(/^protocol$/i)).toBeInTheDocument()
      expect(screen.getByLabelText(/^transport$/i)).toBeInTheDocument()
      expect(screen.getByLabelText(/default permission mode/i)).toBeInTheDocument()
    })

    it("gives two open editors distinct control ids", () => {
      render(
        <>
          <AgentEditorDialog open onOpenChange={jest.fn()} onSave={jest.fn()} />
          <AgentEditorDialog
            open
            editingAgentId="agent-1"
            onOpenChange={jest.fn()}
            onSave={jest.fn()}
          />
        </>
      )
      const names = screen.getAllByLabelText(/agent name/i)
      expect(names).toHaveLength(2)
      expect(names[0].id).not.toBe(names[1].id)
    })
  })

  it("edits and saves the description", async () => {
    const onSave = jest.fn().mockResolvedValue(true)
    render(
      <AgentEditorDialog open editingAgentId="agent-1" onOpenChange={jest.fn()} onSave={onSave} />
    )
    const description = screen.getByLabelText(/^description$/i)
    expect(description).toHaveValue("Codex via stdio")
    await userEvent.clear(description)
    await userEvent.type(description, "Read-only reviews")
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }))
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ description: "Read-only reviews" })
    )
  })

  it("renders as a bottom drawer on a phone", () => {
    useIsMobileMock.mockReturnValue(true)
    render(<AgentEditorDialog open onOpenChange={jest.fn()} onSave={jest.fn()} />)
    expect(screen.getByTestId("agent-editor-drawer")).toBeInTheDocument()
    expect(screen.queryByTestId("agent-editor-dialog")).toBeNull()
  })

  describe("state isolation", () => {
    it("warns about signing in again when moving a shared configuration to its own state", async () => {
      const onSave = jest.fn().mockResolvedValue(true)
      render(
        <AgentEditorDialog open editingAgentId="agent-1" onOpenChange={jest.fn()} onSave={onSave} />
      )
      // Saved before ADR-0216: absent reads as shared.
      expect(screen.getByTestId("state-isolation-shared")).toHaveAttribute("data-state", "checked")
      expect(screen.queryByTestId("state-isolation-sign-in-warning")).toBeNull()
      await userEvent.click(screen.getByTestId("state-isolation-isolated"))
      expect(screen.getByTestId("state-isolation-sign-in-warning")).toBeInTheDocument()
      await userEvent.click(screen.getByRole("button", { name: /^save$/i }))
      expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ stateIsolation: "isolated" }))
    })

    it("defaults a new configuration to its own state where the runtime allows it", async () => {
      const onSave = jest.fn().mockResolvedValue(true)
      render(
        <AgentEditorDialog open onOpenChange={jest.fn()} initialPreset="kimi" onSave={onSave} />
      )
      expect(screen.getByTestId("state-isolation-isolated")).toHaveAttribute(
        "data-state",
        "checked"
      )
      expect(screen.queryByTestId("state-isolation-sign-in-warning")).toBeNull()
      await userEvent.click(screen.getAllByRole("button", { name: /^add$/i }).at(-1)!)
      expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ stateIsolation: "isolated" }))
    })

    it("explains and saves the shared state for a runtime that cannot be isolated", async () => {
      const onSave = jest.fn().mockResolvedValue(true)
      render(
        <AgentEditorDialog open onOpenChange={jest.fn()} initialPreset="goose" onSave={onSave} />
      )
      expect(screen.getByTestId("state-isolation-unsupported")).toBeInTheDocument()
      expect(screen.getByTestId("state-isolation-isolated")).toBeDisabled()
      await userEvent.click(screen.getAllByRole("button", { name: /^add$/i }).at(-1)!)
      expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ stateIsolation: "shared" }))
    })

    it("says there is nothing to isolate for a network agent", async () => {
      await withAgent(
        { transport: "http", process: undefined, network: { endpoint: "https://agent.example" } },
        () => {
          render(
            <AgentEditorDialog
              open
              editingAgentId="agent-1"
              onOpenChange={jest.fn()}
              onSave={jest.fn()}
            />
          )
          expect(screen.getByTestId("state-isolation-not-applicable")).toBeInTheDocument()
        }
      )
    })
  })

  describe("approval rules", () => {
    it("persists both lists and rejects a malformed entry", async () => {
      const onSave = jest.fn().mockResolvedValue(true)
      render(
        <AgentEditorDialog open editingAgentId="agent-1" onOpenChange={jest.fn()} onSave={onSave} />
      )
      await userEvent.click(screen.getByRole("button", { name: /approval rules/i }))
      expect(screen.getByTestId("approval-syntax")).toHaveTextContent("Tool(pattern)")

      const ask = screen.getByRole("textbox", { name: "Always ask for" })
      await userEvent.type(ask, "Bash(rm *{Enter}")
      expect(screen.getByRole("alert")).toHaveTextContent(/closing parenthesis/i)
      await userEvent.type(ask, "){Enter}")

      const auto = screen.getByRole("textbox", { name: "Approve without asking" })
      await userEvent.type(auto, "Read{Enter}")

      await userEvent.click(screen.getByRole("button", { name: /^save$/i }))
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({
          requireApprovalFor: ["Bash(rm *)"],
          autoApprovePatterns: ["Read"],
        })
      )
    })

    it("reads saved lists back and saves an emptied list as the clear", async () => {
      await withAgent({ requireApprovalFor: ["Edit"], autoApprovePatterns: [] }, async () => {
        const onSave = jest.fn().mockResolvedValue(true)
        render(
          <AgentEditorDialog
            open
            editingAgentId="agent-1"
            onOpenChange={jest.fn()}
            onSave={onSave}
          />
        )
        await userEvent.click(screen.getByRole("button", { name: /approval rules/i }))
        await userEvent.click(screen.getByRole("button", { name: "Remove Edit" }))
        await userEvent.click(screen.getByRole("button", { name: /^save$/i }))
        expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ requireApprovalFor: [] }))
      })
    })

    it("notes that Bypass mode leaves some runtimes nothing to ask", async () => {
      await withAgent({ defaultPermissionMode: "bypassPermissions" }, async () => {
        render(
          <AgentEditorDialog
            open
            editingAgentId="agent-1"
            onOpenChange={jest.fn()}
            onSave={jest.fn()}
          />
        )
        await userEvent.click(screen.getByRole("button", { name: /approval rules/i }))
        expect(screen.getByTestId("approval-bypass-note")).toBeInTheDocument()
      })
    })

    it.each([
      ["Read", true],
      ["Bash(git *)", true],
      ["mcp__server__*", true],
      ["Bash(git *", false],
      ["(x)", false],
      ["Bash)", false],
    ])("validates %s as %s", (entry, valid) => {
      expect(isApprovalEntryValid(entry)).toBe(valid)
    })
  })

  describe("session limits", () => {
    it("saves a session limit and an idle timeout", async () => {
      const onSave = jest.fn().mockResolvedValue(true)
      render(
        <AgentEditorDialog open editingAgentId="agent-1" onOpenChange={jest.fn()} onSave={onSave} />
      )
      await userEvent.click(screen.getByRole("button", { name: /^sessions/i }))
      expect(screen.getByLabelText(/maximum open sessions/i)).toHaveAttribute(
        "placeholder",
        "Unlimited"
      )
      await userEvent.type(screen.getByLabelText(/maximum open sessions/i), "2")
      await userEvent.type(screen.getByLabelText(/idle timeout/i), "60000")
      await userEvent.click(screen.getByRole("button", { name: /^save$/i }))
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({ maxConcurrentSessions: 2, sessionIdleTimeout: 60000 })
      )
    })

    it("clears a saved limit with null when the field is emptied", async () => {
      await withAgent({ maxConcurrentSessions: 3, sessionIdleTimeout: 600000 }, async () => {
        const onSave = jest.fn().mockResolvedValue(true)
        render(
          <AgentEditorDialog
            open
            editingAgentId="agent-1"
            onOpenChange={jest.fn()}
            onSave={onSave}
          />
        )
        await userEvent.click(screen.getByRole("button", { name: /^sessions/i }))
        expect(screen.getByLabelText(/maximum open sessions/i)).toHaveValue(3)
        await userEvent.clear(screen.getByLabelText(/maximum open sessions/i))
        await userEvent.clear(screen.getByLabelText(/idle timeout/i))
        await userEvent.click(screen.getByRole("button", { name: /^save$/i }))
        expect(onSave).toHaveBeenCalledWith(
          expect.objectContaining({ maxConcurrentSessions: null, sessionIdleTimeout: null })
        )
      })
    })

    it("leaves an unset limit out of a create input", async () => {
      const onSave = jest.fn().mockResolvedValue(true)
      render(
        <AgentEditorDialog open onOpenChange={jest.fn()} initialPreset="kimi" onSave={onSave} />
      )
      await userEvent.click(screen.getAllByRole("button", { name: /^add$/i }).at(-1)!)
      const input = onSave.mock.calls[0][0]
      expect(input).not.toHaveProperty("maxConcurrentSessions")
      expect(input).not.toHaveProperty("sessionIdleTimeout")
    })

    it("refuses a limit that is not a whole number above zero", async () => {
      const onSave = jest.fn().mockResolvedValue(true)
      render(
        <AgentEditorDialog open editingAgentId="agent-1" onOpenChange={jest.fn()} onSave={onSave} />
      )
      await userEvent.click(screen.getByRole("button", { name: /^sessions/i }))
      await userEvent.type(screen.getByLabelText(/maximum open sessions/i), "0")
      await userEvent.click(screen.getByRole("button", { name: /^save$/i }))
      expect(onSave).not.toHaveBeenCalled()
      expect(toastErrorMock).toHaveBeenCalledWith(expect.stringMatching(/whole number/))
    })
  })

  describe("subscription account", () => {
    it("explains the binding outside the desktop app instead of offering a picker", () => {
      render(
        <AgentEditorDialog
          open
          editingAgentId="agent-1"
          onOpenChange={jest.fn()}
          onSave={jest.fn()}
        />
      )
      expect(screen.getByTestId("subscription-account-unavailable")).toBeInTheDocument()
      expect(screen.queryByTestId("subscription-account-select")).toBeNull()
    })

    it("binds a Codex configuration to an account and back to the active one", async () => {
      isTauriMock.mockReturnValue(true)
      useAccountsMock.mockReturnValue({
        accounts: [
          { id: "acct-work", label: "Work", provider: "codex" },
          { id: "acct-home", email: "me@example.com", provider: "codex" },
        ],
        activeAccountId: "acct-home",
        loading: false,
        error: null,
      })
      const onSave = jest.fn().mockResolvedValue(true)
      render(
        <AgentEditorDialog open editingAgentId="agent-1" onOpenChange={jest.fn()} onSave={onSave} />
      )
      expect(useAccountsMock).toHaveBeenCalledWith("codex")
      const select = screen.getByLabelText(/subscription account/i)
      expect(select).toHaveTextContent(/follow the active account/i)
      await userEvent.click(select)
      await userEvent.click(screen.getByRole("option", { name: "Work" }))
      await userEvent.click(screen.getByRole("button", { name: /^save$/i }))
      expect(onSave).toHaveBeenLastCalledWith(
        expect.objectContaining({ subscriptionAccountId: "acct-work" })
      )
    })

    it("clears a saved binding with null and keeps a removed account visible", async () => {
      isTauriMock.mockReturnValue(true)
      await withAgent({ subscriptionAccountId: "acct-gone" }, async () => {
        const onSave = jest.fn().mockResolvedValue(true)
        render(
          <AgentEditorDialog
            open
            editingAgentId="agent-1"
            onOpenChange={jest.fn()}
            onSave={onSave}
          />
        )
        const select = screen.getByLabelText(/subscription account/i)
        expect(select).toHaveTextContent(/unavailable account/i)
        await userEvent.click(select)
        await userEvent.click(screen.getByRole("option", { name: /follow the active account/i }))
        await userEvent.click(screen.getByRole("button", { name: /^save$/i }))
        expect(onSave).toHaveBeenCalledWith(
          expect.objectContaining({ subscriptionAccountId: null })
        )
      })
    })

    it("keeps the binding when the accounts cannot be read", () => {
      isTauriMock.mockReturnValue(true)
      useAccountsMock.mockReturnValue({
        accounts: [],
        activeAccountId: null,
        loading: false,
        error: "vault locked",
      })
      render(
        <AgentEditorDialog
          open
          editingAgentId="agent-1"
          onOpenChange={jest.fn()}
          onSave={jest.fn()}
        />
      )
      expect(screen.getByTestId("subscription-account-error")).toHaveTextContent("vault locked")
    })

    it("is not offered to a runtime that has no Codex account", async () => {
      await withAgent({ metadata: { preset: "claude-code" } }, () => {
        render(
          <AgentEditorDialog
            open
            editingAgentId="agent-1"
            onOpenChange={jest.fn()}
            onSave={jest.fn()}
          />
        )
        expect(screen.queryByTestId("subscription-account-field")).toBeNull()
      })
    })
  })

  describe("keyring secrets", () => {
    const opencodeV2 = {
      protocol: "opencode-v2",
      transport: "sse",
      process: { command: "", args: [] },
      network: { endpoint: "" },
      metadata: { preset: "opencode-v2-service", serverUsername: "opencode" },
      credentialRefs: { serverPassword: "ref-1" },
    }

    it("shows a saved server password and removes it only after a successful save", async () => {
      await withAgent(opencodeV2, async () => {
        const onSave = jest.fn().mockResolvedValue(true)
        render(
          <AgentEditorDialog
            open
            editingAgentId="agent-1"
            onOpenChange={jest.fn()}
            onSave={onSave}
          />
        )
        expect(screen.getByTestId("opencode-v2-server-password-saved")).toHaveTextContent(
          /saved in the keyring/i
        )
        await userEvent.click(screen.getByRole("button", { name: /remove saved value/i }))
        expect(screen.getByTestId("opencode-v2-server-password-saved")).toHaveTextContent(
          /will be removed when you save/i
        )
        await userEvent.click(screen.getByRole("button", { name: /^save$/i }))
        const input = onSave.mock.calls[0][0]
        // The password never travels as `null` (the credential scrubber drops it).
        expect(input.metadata).not.toHaveProperty("serverPassword")
        await waitFor(() =>
          expect(clearCredentialSlotMock).toHaveBeenCalledWith("agent-1", "serverPassword")
        )
      })
    })

    it("does not remove anything when the save fails", async () => {
      await withAgent(opencodeV2, async () => {
        const onSave = jest.fn().mockResolvedValue(false)
        render(
          <AgentEditorDialog
            open
            editingAgentId="agent-1"
            onOpenChange={jest.fn()}
            onSave={onSave}
          />
        )
        await userEvent.click(screen.getByRole("button", { name: /remove saved value/i }))
        await userEvent.click(screen.getByRole("button", { name: /^save$/i }))
        await waitFor(() => expect(screen.getByRole("button", { name: /^save$/i })).toBeEnabled())
        expect(clearCredentialSlotMock).not.toHaveBeenCalled()
      })
    })

    it("replaces rather than removes when a new password is typed", async () => {
      await withAgent(opencodeV2, async () => {
        const onSave = jest.fn().mockResolvedValue(true)
        render(
          <AgentEditorDialog
            open
            editingAgentId="agent-1"
            onOpenChange={jest.fn()}
            onSave={onSave}
          />
        )
        await userEvent.click(screen.getByRole("button", { name: /remove saved value/i }))
        await userEvent.type(screen.getByLabelText(/server password/i), "new-secret")
        await userEvent.click(screen.getByRole("button", { name: /^save$/i }))
        expect(onSave).toHaveBeenCalledWith(
          expect.objectContaining({
            metadata: expect.objectContaining({ serverPassword: "new-secret" }),
          })
        )
        await waitFor(() => expect(onSave).toHaveBeenCalled())
        expect(clearCredentialSlotMock).not.toHaveBeenCalled()
      })
    })

    it("says when nothing is saved", async () => {
      await withAgent({ ...opencodeV2, credentialRefs: {} }, () => {
        render(
          <AgentEditorDialog
            open
            editingAgentId="agent-1"
            onOpenChange={jest.fn()}
            onSave={jest.fn()}
          />
        )
        expect(screen.getByTestId("opencode-v2-server-password-not-saved")).toBeInTheDocument()
      })
    })
  })

  it("shows the translated setup hint for a preset through the shared copy helper", () => {
    render(
      <AgentEditorDialog open onOpenChange={jest.fn()} initialPreset="devin" onSave={jest.fn()} />
    )
    // Devin's hint was missing from this dialog's private ladder.
    expect(screen.getByTestId("preset-setup-hint")).toBeInTheDocument()
  })
})
