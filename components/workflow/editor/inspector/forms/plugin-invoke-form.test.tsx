/**
 * @jest-environment jsdom
 *
 * Coverage for the reworked PluginInvokeConfig form: tool/task mode
 * inference, capability-fed dropdown data, and the args schema hint.
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { PluginInvokeConfig } from "./index"

jest.mock("@/lib/db/characters", () => ({ listCharacters: jest.fn(async () => []) }))
jest.mock("@/lib/db/teams", () => ({ listTeams: jest.fn(async () => []) }))
jest.mock("@/lib/db/skills", () => ({ listSkills: jest.fn(async () => []) }))
jest.mock("@/lib/db/mcp-servers", () => ({ listMcpServers: jest.fn(async () => []) }))
jest.mock("@/lib/db/plugins", () => ({ listPlugins: jest.fn(async () => []) }))
jest.mock("@/lib/db/workflows", () => ({ listWorkflows: jest.fn(async () => []) }))
jest.mock("@/lib/db/twins", () => ({ listTwins: jest.fn(async () => []) }))

jest.mock("@/stores/plugin-runtime/plugin-store", () => ({
  usePluginStore: jest.fn((selector: (s: { plugins: Record<string, unknown> }) => unknown) =>
    selector({ plugins: {} })
  ),
}))

const listPluginCapabilities = jest.fn(async () => [
  {
    pluginId: "plug-a",
    enabled: true,
    tools: [
      {
        kind: "tool",
        id: "scan",
        label: "scan",
        description: "scans",
        argsSchema: { type: "object", properties: { q: {}, limit: {} } },
      },
    ],
    commands: [],
    modes: [],
    workflowNodes: [],
    workflowTriggers: [],
    workflowTemplates: [],
    skills: [],
    mcpPresets: [],
    subagents: [],
  },
  {
    pluginId: "plug-disabled",
    enabled: false,
    tools: [{ kind: "tool", id: "x", label: "x" }],
    commands: [],
    modes: [],
    workflowNodes: [],
    workflowTriggers: [],
    workflowTemplates: [],
    skills: [],
    mcpPresets: [],
    subagents: [],
  },
])
jest.mock("@/lib/plugin/api/plugin-capability-registry", () => ({
  listPluginCapabilities: () => listPluginCapabilities(),
}))

const messages = {
  workflows: {
    forms: {
      pickers: {
        plugin: "Select a plugin",
        noResults: "No matches",
        useExpression: "Use expression",
        usePicker: "Pick from list",
        none: "None",
      },
      pluginInvoke: {
        mode: {
          label: "Mode",
          options: { tool: "Plugin tool", task: "Task handler (legacy)" },
        },
        pluginId: { label: "Plugin", toolPlaceholder: "Select an enabled plugin" },
        toolName: { label: "Tool", placeholder: "Select a tool", empty: "Select a plugin first" },
        taskId: { label: "Task id", placeholder: "generate-report" },
        argsJson: {
          label: "Arguments (JSON)",
          hint: "Forwarded to the plugin task handler.",
          toolHint: "Expected fields: {fields}",
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

afterEach(() => {
  listPluginCapabilities.mockClear()
})

describe("PluginInvokeConfig — mode inference", () => {
  it("defaults a fresh node to tool mode (tool field, no task id)", async () => {
    wrap(<PluginInvokeConfig params={{}} onChange={jest.fn()} />)

    expect(await screen.findByLabelText(/Select a tool|Select a plugin first/i)).toBeInTheDocument()
    expect(screen.queryByLabelText(/Task id/i)).not.toBeInTheDocument()
  })

  it("infers task mode for a persisted legacy node carrying only taskId", () => {
    wrap(<PluginInvokeConfig params={{ pluginId: "p", taskId: "report" }} onChange={jest.fn()} />)

    expect(screen.getByLabelText(/Task id/i)).toBeInTheDocument()
    expect(screen.queryByLabelText(/Select a tool/i)).not.toBeInTheDocument()
    // Legacy mode must not hit the capability API at all.
    expect(listPluginCapabilities).not.toHaveBeenCalled()
  })

  it("honors an explicit mode discriminator over field inference", () => {
    wrap(
      <PluginInvokeConfig
        params={{ pluginId: "p", mode: "task", toolName: "ghost" }}
        onChange={jest.fn()}
      />
    )

    expect(screen.getByLabelText(/Task id/i)).toBeInTheDocument()
  })

  it("writes the mode discriminator when switched", async () => {
    const user = userEvent.setup()
    const onChange = jest.fn()
    wrap(<PluginInvokeConfig params={{}} onChange={onChange} />)

    // Let the capability fetch settle before interacting (avoids act noise).
    await screen.findByTestId("pi-plug-use-expression")
    await user.click(screen.getByRole("combobox", { name: "Mode" }))
    await user.click(await screen.findByRole("option", { name: /Task handler/i }))

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ mode: "task" }))
  })
})

describe("PluginInvokeConfig — capability-fed tool mode", () => {
  it("loads capabilities and surfaces the selected tool's schema fields as the args hint", async () => {
    wrap(
      <PluginInvokeConfig
        params={{ pluginId: "plug-a", mode: "tool", toolName: "scan" }}
        onChange={jest.fn()}
      />
    )

    expect(await screen.findByText("Expected fields: q, limit")).toBeInTheDocument()
    expect(listPluginCapabilities).toHaveBeenCalled()
  })

  it("falls back to the generic hint when no tool schema is known", async () => {
    wrap(<PluginInvokeConfig params={{ mode: "tool" }} onChange={jest.fn()} />)

    expect(await screen.findByText(/Forwarded to the plugin task handler/i)).toBeInTheDocument()
  })

  it("offers the expression escape hatch on both tool-mode pickers", async () => {
    wrap(<PluginInvokeConfig params={{ mode: "tool" }} onChange={jest.fn()} />)

    expect(await screen.findByTestId("pi-plug-use-expression")).toBeInTheDocument()
    expect(screen.getByTestId("pi-tool-use-expression")).toBeInTheDocument()
  })
})
