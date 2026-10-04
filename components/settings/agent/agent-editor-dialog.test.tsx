/**
 * AgentEditorDialog — extracted from the settings shell; the deep editor.
 * Verifies the dialog opens in create vs edit mode, runs preset seeding,
 * and produces a CreateExternalAgentInput on save.
 */

import { render, screen, act, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { AgentEditorDialog } from "./agent-editor-dialog"
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

describe("AgentEditorDialog", () => {
  it("seeds Kimi subscription ACP and saves isolated state through the masked env editor", async () => {
    const onSave = jest.fn()
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
      const onSave = jest.fn()
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
    const onSave = jest.fn()
    render(
      <AgentEditorDialog open editingAgentId="agent-1" onOpenChange={jest.fn()} onSave={onSave} />
    )
    await userEvent.clear(screen.getByLabelText(/^arguments$/i))
    await userEvent.type(screen.getByLabelText(/^arguments$/i), '--config "unfinished path')
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }))
    expect(onSave).not.toHaveBeenCalled()
  })

  it("saves environment customization for a generic ACP Agent", async () => {
    const onSave = jest.fn()
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
    const onSave = jest.fn()
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
    const onSave = jest.fn()
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
    const onSave = jest.fn()
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
    const onSave = jest.fn()
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
    const onSave = jest.fn()
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
      const onSave = jest.fn()
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
    const onSave = jest.fn()
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
})
