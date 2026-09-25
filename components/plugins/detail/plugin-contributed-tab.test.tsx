/**
 * @jest-environment jsdom
 */

import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
    if (vars && typeof vars.count === "number") return String(vars.count)
    if (vars && typeof vars.name === "string") return `${key}:${vars.name}`
    return key
  },
}))

const mockPush = jest.fn()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn() }),
}))

const mockRequestCommandPalette = jest.fn()
jest.mock("@/lib/shell/command-palette-request", () => ({
  requestCommandPalette: (detail: unknown) => mockRequestCommandPalette(detail),
}))

const mockGetToolsByPlugin = jest.fn<unknown[], [string]>()
const mockGetModesByPlugin = jest.fn<unknown[], [string]>()
const mockGetCommandsByPlugin = jest.fn<unknown[], [string]>()
const mockGetComponentsByPlugin = jest.fn<unknown[], [string]>()
const mockGetTemplatesByPlugin = jest.fn<unknown[], [string]>()

jest.mock("@/lib/plugin/core/manager", () => ({
  getPluginManager: () => ({
    getRegistry: () => ({
      getToolsByPlugin: mockGetToolsByPlugin,
      getModesByPlugin: mockGetModesByPlugin,
      getCommandsByPlugin: mockGetCommandsByPlugin,
      getComponentsByPlugin: mockGetComponentsByPlugin,
      getTemplatesByPlugin: mockGetTemplatesByPlugin,
    }),
  }),
}))

const mockListPluginThemes = jest.fn<unknown[], []>()
jest.mock("@/lib/theme/theme-registry", () => ({
  listPluginThemes: () => mockListPluginThemes(),
  subscribeThemeRegistry: () => () => undefined,
}))

const mockListMcpServerPresetEntries = jest.fn<unknown[], []>()
jest.mock("@/lib/plugin/registries/mcp-server-preset-registry", () => ({
  listMcpServerPresetEntries: () => mockListMcpServerPresetEntries(),
}))

const mockListSkillEntries = jest.fn<unknown[], []>()
jest.mock("@/lib/plugin/registries/skill-registry", () => ({
  listSkillEntries: () => mockListSkillEntries(),
}))

const mockListNativeToolEntries = jest.fn<unknown[], []>()
jest.mock("@/lib/plugin/registries/native-anthropic-tool-registry", () => ({
  listNativeAnthropicToolEntries: () => mockListNativeToolEntries(),
}))

const mockListDynamicPresetEntries = jest.fn<unknown[], []>()
jest.mock("@/lib/ai/agent/external/config/presets", () => ({
  listDynamicPresetEntries: () => mockListDynamicPresetEntries(),
}))

const mockListPluginProtocolAdapters = jest.fn<unknown[], []>()
jest.mock("@/lib/ai/agent/external/protocol-adapter", () => ({
  listPluginProtocolAdapters: () => mockListPluginProtocolAdapters(),
}))

const mockGetPluginConnectorKinds = jest.fn<readonly string[], [string]>()
jest.mock("@/lib/plugin/bridge/connectors-bridge", () => ({
  getPluginConnectorKinds: (id: string) => mockGetPluginConnectorKinds(id),
}))

const mockGetPluginCatalogSnapshot = jest.fn<unknown[], []>()
jest.mock("@/lib/workflow/nodes/catalog", () => ({
  getPluginCatalogSnapshot: () => mockGetPluginCatalogSnapshot(),
  subscribePluginCatalog: () => () => undefined,
}))

const mockGetHooksByPlugin = jest.fn<string[], [string]>()
jest.mock("@/lib/plugin/messaging/hooks-system", () => ({
  getPluginLifecycleHooks: () => ({ getHooksByPlugin: mockGetHooksByPlugin }),
}))

import { registerCommand, __resetCommandRegistryForTesting } from "@/lib/plugin/commands/registry"
import {
  registerViewContainer,
  __resetViewContainersForTesting,
} from "@/lib/plugin/registries/view-container-registry"
import { registerBot, __resetBotsForTesting } from "@/lib/plugin/registries/bot-registry"
import {
  registerSubagent,
  __resetSubagentsForTesting,
} from "@/lib/plugin/registries/subagent-registry"
import {
  registerToolResultRenderer,
  clearAllToolResultRenderers,
} from "@/lib/plugin/api/tool-result-renderers"
import { useUIStore } from "@/stores/ui"

import { PluginContributedTab } from "./plugin-contributed-tab"

beforeEach(() => {
  mockGetToolsByPlugin.mockReturnValue([])
  mockGetModesByPlugin.mockReturnValue([])
  mockGetCommandsByPlugin.mockReturnValue([])
  mockGetComponentsByPlugin.mockReturnValue([])
  mockGetTemplatesByPlugin.mockReturnValue([])
  mockListPluginThemes.mockReturnValue([])
  mockListMcpServerPresetEntries.mockReturnValue([])
  mockListSkillEntries.mockReturnValue([])
  mockListNativeToolEntries.mockReturnValue([])
  mockListDynamicPresetEntries.mockReturnValue([])
  mockListPluginProtocolAdapters.mockReturnValue([])
  mockGetPluginConnectorKinds.mockReturnValue([])
  mockGetPluginCatalogSnapshot.mockReturnValue([])
  mockGetHooksByPlugin.mockReturnValue([])
  mockPush.mockClear()
  mockRequestCommandPalette.mockClear()
  __resetCommandRegistryForTesting()
  __resetViewContainersForTesting()
  __resetBotsForTesting()
  __resetSubagentsForTesting()
  clearAllToolResultRenderers()
})

describe("PluginContributedTab", () => {
  it("renders the empty state when no category is populated", () => {
    render(<PluginContributedTab pluginId="p1" />)
    expect(screen.getByText("empty")).toBeInTheDocument()
    expect(screen.queryByTestId("plugin-contributed-tab")).not.toBeInTheDocument()
  })

  it("renders only the cards that have contributions", () => {
    mockGetToolsByPlugin.mockReturnValue([{ name: "tool_one" }, { name: "tool_two" }])
    mockListSkillEntries.mockReturnValue([
      { id: "skill_a", pluginId: "p1", entry: {} },
      { id: "skill_b", pluginId: "p1", entry: {} },
      { id: "skill_other", pluginId: "other", entry: {} },
    ])

    render(<PluginContributedTab pluginId="p1" />)

    // Container appears
    expect(screen.getByTestId("plugin-contributed-tab")).toBeInTheDocument()

    // Tools card present with both tool names
    expect(screen.getByTestId("contributed-tools")).toBeInTheDocument()
    expect(screen.getByText("tool_one")).toBeInTheDocument()
    expect(screen.getByText("tool_two")).toBeInTheDocument()

    // Skills card present with only the matching plugin's two skills
    expect(screen.getByTestId("contributed-skills")).toBeInTheDocument()
    expect(screen.getByText("skill_a")).toBeInTheDocument()
    expect(screen.getByText("skill_b")).toBeInTheDocument()
    expect(screen.queryByText("skill_other")).not.toBeInTheDocument()

    // Cards with no items don't render
    expect(screen.queryByTestId("contributed-modes")).not.toBeInTheDocument()
    expect(screen.queryByTestId("contributed-themes")).not.toBeInTheDocument()
  })

  it("localizes the Eval Lab tool label without renaming other plugin tools", () => {
    mockGetToolsByPlugin.mockReturnValue([
      { name: "eval_project_v2" },
      { name: "plugin_specific_tool" },
    ])

    render(<PluginContributedTab pluginId="p1" />)

    expect(screen.getByText("toolLabels.eval_project_v2")).toBeInTheDocument()
    expect(screen.getByText("plugin_specific_tool")).toBeInTheDocument()
    expect(screen.queryByText("eval_project_v2")).not.toBeInTheDocument()
  })

  it("enumerates the plugin's contributed lifecycle hooks", () => {
    mockGetHooksByPlugin.mockReturnValue(["onEnable", "onMessageSend"])
    render(<PluginContributedTab pluginId="p1" />)
    expect(screen.getByTestId("contributed-hooks")).toBeInTheDocument()
    expect(screen.getByText("onEnable")).toBeInTheDocument()
    expect(screen.getByText("onMessageSend")).toBeInTheDocument()
  })

  it("filters themes / mcp presets / external presets / adapters / workflow entries by pluginId", () => {
    mockListPluginThemes.mockReturnValue([
      { id: "p1.dark", name: "Dark", pluginId: "p1", variables: {} },
      { id: "p2.light", name: "Light", pluginId: "p2", variables: {} },
    ])
    mockListMcpServerPresetEntries.mockReturnValue([
      { id: "playwright", pluginId: "p1", entry: {} },
      { id: "stagehand", pluginId: "other", entry: {} },
    ])
    mockListDynamicPresetEntries.mockReturnValue([
      { id: "claude-fork", pluginId: "p1", config: {} },
    ])
    mockListPluginProtocolAdapters.mockReturnValue([
      { protocol: "p1:demo-echo", pluginId: "p1" },
      { protocol: "other:x", pluginId: "other" },
    ])
    mockGetPluginConnectorKinds.mockReturnValue(["telegram-bot", "discord-bot"])
    mockGetPluginCatalogSnapshot.mockReturnValue([
      { kind: "p1.action.x", category: "action", label: "Do X", pluginId: "p1", keywords: [] },
      {
        kind: "trigger.p1.foo",
        category: "trigger",
        label: "Foo trigger",
        pluginId: "p1",
        keywords: [],
      },
      {
        kind: "other.action.y",
        category: "action",
        label: "Other",
        pluginId: "other",
        keywords: [],
      },
    ])

    render(<PluginContributedTab pluginId="p1" />)

    // Themes — only "Dark"
    expect(screen.getByText("Dark")).toBeInTheDocument()
    expect(screen.queryByText("Light")).not.toBeInTheDocument()

    // MCP presets — only "playwright"
    expect(screen.getByText("playwright")).toBeInTheDocument()
    expect(screen.queryByText("stagehand")).not.toBeInTheDocument()

    // External agent preset
    expect(screen.getByText("claude-fork")).toBeInTheDocument()

    // External agent adapter — only p1's namespaced protocol
    expect(screen.getByTestId("contributed-externalAgentAdapters")).toBeInTheDocument()
    expect(screen.getByText("p1:demo-echo")).toBeInTheDocument()
    expect(screen.queryByText("other:x")).not.toBeInTheDocument()

    // Connectors — both adapter ids
    expect(screen.getByText("telegram-bot")).toBeInTheDocument()
    expect(screen.getByText("discord-bot")).toBeInTheDocument()

    // Workflow nodes / triggers split by category
    expect(screen.getByTestId("contributed-workflowNodes")).toBeInTheDocument()
    expect(screen.getByText("Do X")).toBeInTheDocument()
    expect(screen.getByTestId("contributed-workflowTriggers")).toBeInTheDocument()
    expect(screen.getByText("Foo trigger")).toBeInTheDocument()
    expect(screen.queryByText("Other")).not.toBeInTheDocument()
  })

  describe("the registries the tab used to miss", () => {
    it("names commands by their title and opens the command palette on them", async () => {
      const user = userEvent.setup()
      mockGetCommandsByPlugin.mockReturnValue([{ id: "p1.greet", name: "Say hello" }])
      render(<PluginContributedTab pluginId="p1" />)
      const chip = screen.getByRole("button", { name: "actionAria.palette:Say hello" })
      expect(chip).toHaveAttribute("title", "p1.greet")
      await user.click(chip)
      expect(mockRequestCommandPalette).toHaveBeenCalledWith({ query: "Say hello" })
    })

    it("lists a titled command from the command registry once", () => {
      registerCommand({ id: "p1.open", title: "Open things", pluginId: "p1", handler: () => {} })
      registerCommand({ id: "other.x", title: "Not mine", pluginId: "other", handler: () => {} })
      render(<PluginContributedTab pluginId="p1" />)
      expect(screen.getByTestId("contributed-commands")).toHaveTextContent("Open things")
      expect(screen.queryByText("Not mine")).toBeNull()
    })

    it("switches the shell to a contributed view container", async () => {
      const user = userEvent.setup()
      registerViewContainer({ id: "explorer", title: "Explorer" }, { pluginId: "p1" })
      render(<PluginContributedTab pluginId="p1" />)
      await user.click(screen.getByRole("button", { name: "actionAria.viewContainer:Explorer" }))
      expect(useUIStore.getState().selectedGuild).toEqual({
        kind: "plugin-view",
        containerId: "p1:explorer",
      })
      expect(mockPush).toHaveBeenCalledWith("/")
    })

    it("lists subagents, Bots and tool-result cards", async () => {
      const user = userEvent.setup()
      registerSubagent(
        "p1:reviewer",
        { id: "reviewer", name: "Reviewer", description: "d" } as never,
        { pluginId: "p1" }
      )
      registerBot("p1:digest", { id: "p1:digest", definition: { name: "Daily digest" } } as never, {
        pluginId: "p1",
      })
      registerToolResultRenderer("p1", "web_fetch", () => null)
      render(<PluginContributedTab pluginId="p1" />)
      expect(screen.getByTestId("contributed-subagents")).toHaveTextContent("Reviewer")
      expect(screen.getByTestId("contributed-toolRenderers")).toHaveTextContent("web_fetch")
      await user.click(screen.getByRole("button", { name: "actionAria.route:Daily digest" }))
      expect(mockPush).toHaveBeenCalledWith("/bots")
    })

    // It used to be read once: enabling the plugin with its detail open showed
    // "no contributions" until the pane was reopened.
    it("updates when a registry changes while the tab is open", async () => {
      render(<PluginContributedTab pluginId="p1" />)
      expect(screen.getByTestId("plugin-contributed-empty")).toBeInTheDocument()
      await act(async () => {
        registerCommand({ id: "p1.late", title: "Late command", pluginId: "p1", handler: () => {} })
        await Promise.resolve()
      })
      expect(await screen.findByText("Late command")).toBeInTheDocument()
    })
  })
})
