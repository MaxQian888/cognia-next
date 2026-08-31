/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import {
  EntityPicker,
  McpToolPicker,
  ModelPicker,
  TeamPicker,
  providerForModel,
} from "./entity-picker"

const getMcpServerMock = jest.fn()
jest.mock("@/lib/db/characters", () => ({ listCharacters: jest.fn(async () => []) }))
jest.mock("@/lib/db/teams", () => ({
  listTeams: jest.fn(async () => [{ id: "team_1", name: "Alpha" }]),
}))
jest.mock("@/lib/db/skills", () => ({ listSkills: jest.fn(async () => []) }))
jest.mock("@/lib/db/mcp-servers", () => ({
  listMcpServers: jest.fn(async () => []),
  getMcpServer: (...a: unknown[]) => getMcpServerMock(...a),
}))
jest.mock("@/lib/db/plugins", () => ({ listPlugins: jest.fn(async () => []) }))
jest.mock("@/lib/db/workflows", () => ({ listWorkflows: jest.fn(async () => []) }))
jest.mock("@/lib/db/twins", () => ({ listTwins: jest.fn(async () => []) }))
jest.mock("@/lib/claude/feature-call", () => ({ discoverMcpServerViaSidecar: jest.fn() }))
jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn(() => true) }))
jest.mock("@/lib/settings/builtin-tools", () => ({ listBuiltinTools: () => [] }))
jest.mock("@/lib/claude/agents/subagents", () => ({ resolveDispatchableSubagents: () => [] }))
jest.mock("@/stores/agent/external-agent-store", () => ({
  useExternalAgentStore: (selector: (s: unknown) => unknown) => selector({ agents: {} }),
}))
jest.mock("@/components/shared/model-select", () => ({
  useModelOptions: () => ({
    options: [
      {
        modelId: "claude-opus-5",
        modelName: "Opus 5",
        providerId: "anthropic",
        providerName: "Anthropic",
      },
    ],
    groups: [],
  }),
}))
import { isTauri } from "@/lib/tauri"
const isTauriMock = isTauri as jest.Mock

const messages = {
  workflows: {
    forms: {
      pickers: {
        team: "Select a team",
        none: "None",
        noResults: "No matches",
        useExpression: "Use expression",
        usePicker: "Pick from list",
      },
      mcpInvokeTool: {
        toolName: {
          placeholder: "search_repos",
          loading: "Discovering tools…",
          probeError: "Couldn't reach the server — type the tool name.",
          empty: "No tools discovered — type the tool name.",
        },
      },
    },
  },
}

function wrap(ui: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>
  )
}

const OPTIONS = [
  { value: "a", label: "Alpha" },
  { value: "b", label: "Beta" },
]

describe("EntityPicker", () => {
  it("renders the combobox with the placeholder when nothing is selected", () => {
    wrap(
      <EntityPicker
        id="ep"
        value=""
        onChange={jest.fn()}
        options={OPTIONS}
        placeholder="Pick one"
      />
    )
    expect(screen.getByLabelText("Pick one")).toBeInTheDocument()
  })

  it("shows the selected option's label, not its raw id", () => {
    wrap(
      <EntityPicker
        id="ep"
        value="b"
        onChange={jest.fn()}
        options={OPTIONS}
        placeholder="Pick one"
      />
    )
    // The combobox input placeholder reflects the resolved label.
    expect(screen.getByLabelText("Pick one")).toHaveAttribute("placeholder", "Beta")
  })

  it("toggles into expression mode and edits a raw value", () => {
    const onChange = jest.fn()
    wrap(
      <EntityPicker
        id="ep"
        value=""
        onChange={onChange}
        options={OPTIONS}
        placeholder="Pick one"
        allowExpression
      />
    )
    fireEvent.click(screen.getByTestId("ep-use-expression"))
    const input = screen.getByLabelText("Pick one")
    fireEvent.change(input, { target: { value: "{{ $node['x'].out.id }}" } })
    expect(onChange).toHaveBeenCalledWith("{{ $node['x'].out.id }}")
    // And we can switch back to the picker.
    fireEvent.click(screen.getByTestId("ep-use-picker"))
    expect(screen.queryByTestId("ep-use-picker")).not.toBeInTheDocument()
  })

  it("starts in expression mode when the value already holds an expression", () => {
    wrap(
      <EntityPicker
        id="ep"
        value="{{ $vars.team }}"
        onChange={jest.fn()}
        options={OPTIONS}
        placeholder="Pick one"
        allowExpression
      />
    )
    // Manual mode renders a font-mono Input pre-filled with the expression.
    expect(screen.getByDisplayValue("{{ $vars.team }}")).toBeInTheDocument()
    expect(screen.getByTestId("ep-use-picker")).toBeInTheDocument()
  })

  it("does not offer the expression toggle when allowExpression is false", () => {
    wrap(<EntityPicker id="ep" value="" onChange={jest.fn()} options={OPTIONS} />)
    expect(screen.queryByTestId("ep-use-expression")).not.toBeInTheDocument()
  })
})

describe("entity wrappers", () => {
  it("TeamPicker loads teams from Dexie and renders the picker", async () => {
    wrap(<TeamPicker id="tp" value="" onChange={jest.fn()} />)
    expect(await screen.findByLabelText("Select a team")).toBeInTheDocument()
  })
})

describe("McpToolPicker", () => {
  beforeEach(() => {
    isTauriMock.mockReturnValue(true)
    getMcpServerMock.mockReset()
  })

  it("probes the selected server's tools and offers them as options", async () => {
    getMcpServerMock.mockResolvedValue({
      id: "srv1",
      name: "S",
      transport: "http",
      config: { url: "https://x/mcp" },
      enabled: true,
    })
    const probe = jest.fn(async () => ({
      ok: true,
      toolCount: 1,
      tools: [{ name: "search_repos" }],
      durationMs: 1,
    }))
    wrap(
      <McpToolPicker id="mt" serverId="srv1" value="" onChange={jest.fn()} probe={probe as never} />
    )
    // The probe receives the complete stored definition; secret resolution is
    // owned by the feature-call wrapper immediately before sidecar dispatch.
    await waitFor(() =>
      expect(probe).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "srv1",
          transport: "http",
          config: { url: "https://x/mcp" },
        })
      )
    )
  })

  it("shows the empty hint and stays free-text when the probe finds no tools", async () => {
    getMcpServerMock.mockResolvedValue({
      id: "srv1",
      name: "S",
      transport: "http",
      config: { url: "https://x/mcp" },
      enabled: true,
    })
    const probe = jest.fn(async () => ({ ok: true, toolCount: 0, tools: [], durationMs: 1 }))
    wrap(
      <McpToolPicker id="mt" serverId="srv1" value="" onChange={jest.fn()} probe={probe as never} />
    )
    expect(await screen.findByTestId("mcp-tool-empty")).toBeInTheDocument()
  })

  it("surfaces a probe error and keeps free-text entry reachable", async () => {
    getMcpServerMock.mockResolvedValue({
      id: "srv1",
      name: "S",
      transport: "stdio",
      config: { command: "x" },
      enabled: true,
    })
    const probe = jest.fn(async () => ({
      ok: false,
      toolCount: 0,
      tools: [],
      error: "spawn failed",
      durationMs: 1,
    }))
    wrap(
      <McpToolPicker
        id="mt"
        serverId="srv1"
        value="foo"
        onChange={jest.fn()}
        probe={probe as never}
      />
    )
    expect(await screen.findByTestId("mcp-tool-error")).toBeInTheDocument()
    // The expression/free-text toggle is available as the fallback.
    expect(screen.getByTestId("mt-use-expression")).toBeInTheDocument()
  })

  it("does not probe in web mode (isTauri false)", async () => {
    isTauriMock.mockReturnValue(false)
    getMcpServerMock.mockResolvedValue({
      id: "srv1",
      name: "S",
      transport: "http",
      config: { url: "https://x" },
      enabled: true,
    })
    const probe = jest.fn()
    wrap(
      <McpToolPicker id="mt" serverId="srv1" value="" onChange={jest.fn()} probe={probe as never} />
    )
    // Yield a tick for the effect.
    await screen.findByTestId("mt-use-expression")
    expect(probe).not.toHaveBeenCalled()
  })
})

describe("ModelPicker", () => {
  /**
   * The forms that take an explicit model also take an explicit provider.
   * Writing them with two `onChange` calls off the same `params` object drops
   * the first, which is why the picker reports both at once instead.
   */
  it("pairs a catalogued model with its provider", () => {
    const options = [
      { modelId: "claude-opus-5", providerId: "anthropic" },
      { modelId: "gpt-5", providerId: "openai" },
    ]
    expect(providerForModel(options, "gpt-5")).toBe("openai")
  })

  it("reports no provider for an id the catalog does not know", () => {
    // A hand-typed id, an expression, or a provider configured only by base
    // URL. The caller then writes the model alone and leaves `provider` be.
    expect(providerForModel([], "something-custom")).toBeUndefined()
    expect(providerForModel([], "{{ $json.model }}")).toBeUndefined()
  })

  it("renders as a picker", () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <ModelPicker id="m" value="" onChange={jest.fn()} />
      </NextIntlClientProvider>
    )
    expect(screen.getByRole("combobox")).toBeInTheDocument()
  })
})
