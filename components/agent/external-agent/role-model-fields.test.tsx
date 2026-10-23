import { fireEvent, render, screen, within, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import en from "@/i18n/messages/en.json"
import type { AgentModelRoleOverrides, ExternalAgentConfig } from "@/types/agent/external-agent"
import { getPresetConfig } from "@/lib/ai/agent/external/config/presets"
import { RoleModelFields } from "./role-model-fields"
import { resolvePiSubagents } from "@/lib/ai/agent/external/config/pi-subagents"
jest.mock("@/lib/ai/agent/external/config/pi-subagents", () => ({
  ...jest.requireActual("@/lib/ai/agent/external/config/pi-subagents"),
  resolvePiSubagents: jest.fn(async (config) => config),
}))

const settings = { providerSettings: {}, customProviders: [] }
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (select: (s: unknown) => unknown) => select({ settings }),
}))
jest.mock("@/lib/subscription/core/hooks", () => ({ useSubscriptionProviders: () => [] }))
jest.mock("@/lib/ai/agent/external/config/cognia-model-options", () => {
  const { compileTaskModelPlan } = jest.requireActual("@/lib/ai/agent/external/config/model-plan")
  const { gatewayModelSlots } = jest.requireActual("@/lib/ai/agent/external/config/model-slots")
  // "small" does not reason; "big" reasons but, like GPT-6, rejects `minimal`.
  const facts = {
    modelSupportsReasoning: (modelId: string) => modelId !== "small",
    modelEffortValues: (modelId: string) =>
      modelId === "small" ? [] : ["low", "medium", "high", "xhigh"],
  }
  return {
    filterCogniaGatewayModels: () => [
      { providerId: "gateway", providerName: "Gateway", modelId: "big", modelName: "Big" },
      { providerId: "gateway", providerName: "Gateway", modelId: "small", modelName: "Small" },
      { providerId: "other", providerName: "Other", modelId: "elsewhere", modelName: "Elsewhere" },
    ],
    cogniaModelReasoningFacts: () => facts,
    compileEditorModelPlan: (input: {
      config: Parameters<typeof gatewayModelSlots>[0]
      primary: unknown
      layers: unknown
    }) =>
      compileTaskModelPlan({
        primary: input.primary,
        slots: gatewayModelSlots(input.config),
        layers: input.layers,
        ...facts,
      }),
  }
})
jest.mock("@/components/shared/responsive-picker", () => ({
  ResponsivePicker: ({
    trigger,
    children,
  }: {
    trigger: React.ReactNode
    children: React.ReactNode
  }) => (
    <div>
      {trigger}
      {children}
    </div>
  ),
}))
jest.mock("@/components/settings/provider/provider-model-list", () => ({
  ProviderModelList: ({
    groups,
    onSelect,
  }: {
    groups: Array<{ providerId: string; models: string[] }>
    onSelect: (providerId: string, modelId: string) => void
  }) => (
    <ul>
      {groups.flatMap((group) =>
        group.models.map((model) => (
          <li key={`${group.providerId}/${model}`}>
            <button type="button" onClick={() => onSelect(group.providerId, model)}>
              {`pick ${group.providerId}/${model}`}
            </button>
          </li>
        ))
      )}
    </ul>
  ),
}))
jest.mock("@/components/ui/select", () => {
  const React = jest.requireActual("react")
  return {
    Select: ({
      value,
      onValueChange,
      children,
    }: {
      value: string
      onValueChange: (value: string) => void
      children: React.ReactNode
    }) =>
      React.createElement(
        "select",
        {
          value,
          onChange: (event: { target: { value: string } }) => onValueChange(event.target.value),
        },
        children
      ),
    SelectTrigger: () => null,
    SelectValue: () => null,
    SelectContent: ({ children }: { children: React.ReactNode }) => children,
    SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) =>
      React.createElement("option", { value }, children),
  }
})

const config = (preset: string, protocol = "acp") =>
  ({
    id: "saved",
    name: "Agent",
    enabled: true,
    protocol,
    transport: "stdio",
    process: { command: getPresetConfig(preset)?.process?.command ?? "agent" },
    metadata: { preset },
  }) as ExternalAgentConfig
const primary = { providerId: "gateway", modelId: "big", accountId: "account-a" }
const messages = en as unknown as Record<string, unknown>

function renderFields(props: Partial<Parameters<typeof RoleModelFields>[0]> = {}) {
  const onChange = jest.fn()
  const view = render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <RoleModelFields
        config={config("codex-app-server", "codex-app-server")}
        primary={primary}
        onChange={onChange}
        {...props}
      />
    </NextIntlClientProvider>
  )
  return { onChange, ...view }
}

describe("RoleModelFields", () => {
  it("shows Pi child controls only after a supported package is detected", async () => {
    const input = config("pi-rpc", "pi-rpc")
    let finish!: (value: typeof input) => void
    jest.mocked(resolvePiSubagents).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    renderFields({ config: input })
    expect(screen.queryByRole("heading", { name: en.externalAgent.roleModels.title })).toBeNull()
    finish({
      ...input,
      metadata: {
        ...input.metadata,
        cogniaPiSubagents: { family: "nico", version: "0.80.0", agents: {} },
      },
    })
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: en.externalAgent.roleModels.title })).toBeVisible()
    )
    expect(screen.getByText(en.externalAgent.roleModels.slots.subagentDefault)).toBeVisible()
  })
  it("keeps Pi controls hidden when no package is detected", async () => {
    renderFields({ config: config("pi-rpc", "pi-rpc") })
    await waitFor(() => expect(resolvePiSubagents).toHaveBeenCalled())
    expect(screen.queryByRole("heading", { name: en.externalAgent.roleModels.title })).toBeNull()
  })
  it("retains v2 candidates when changing a slot and reuses the provider picker", () => {
    const value: AgentModelRoleOverrides = {
      version: 2,
      slots: { "subagent.default": { kind: "cognia", binding: primary } },
      allowedSpawnModels: [primary],
    }
    const { onChange } = renderFields({ value })
    fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: "__unset__" } })
    expect(onChange).toHaveBeenLastCalledWith({ ...value, slots: {} })
    const picks = screen.getAllByRole("button", { name: "pick gateway/small" })
    fireEvent.click(picks[picks.length - 1])
    expect(onChange).toHaveBeenLastCalledWith({
      ...value,
      allowedSpawnModels: [primary, { ...primary, modelId: "small" }],
    })
  })
  it("renders nothing for a runtime without slots and no stored overrides", () => {
    const { container } = renderFields({ config: config("kimi") })
    expect(container).toBeEmptyDOMElement()
  })

  it("asks for a primary model before showing slot rows", () => {
    renderFields({ primary: null })
    expect(screen.getByText(en.externalAgent.roleModels.needsPrimary)).toBeInTheDocument()
    expect(screen.queryByTestId("role-model-slot-subagent.default")).not.toBeInTheDocument()
  })

  it("explains a Host that cannot store sub-task models instead of offering rows", () => {
    renderFields({ blocker: "host-outdated" })
    expect(screen.getByText(en.externalAgent.roleModels.hostOutdated)).toBeInTheDocument()
    expect(screen.queryByTestId("role-model-slot-subagent.default")).not.toBeInTheDocument()
  })

  it("lists one row per declared Claude slot", () => {
    renderFields({ config: config("claude-code") })
    for (const slot of ["subagent.default", "tier.haiku", "tier.sonnet", "tier.opus"])
      expect(screen.getByTestId(`role-model-slot-${slot}`)).toBeInTheDocument()
  })

  it("offers only the primary provider's models and stores a binding that follows its account", () => {
    const { onChange } = renderFields()
    const row = screen.getByTestId("role-model-slot-subagent.default")
    fireEvent.change(within(row).getByRole("combobox"), { target: { value: "__model__" } })
    expect(within(row).queryByText("pick other/elsewhere")).not.toBeInTheDocument()
    fireEvent.click(within(row).getByText("pick gateway/small"))
    expect(onChange).toHaveBeenLastCalledWith({
      version: 1,
      slots: {
        "subagent.default": {
          kind: "cognia",
          binding: { providerId: "gateway", modelId: "small" },
        },
      },
    })
  })

  it("sets and clears the Codex child effort", () => {
    const value: AgentModelRoleOverrides = {
      version: 1,
      slots: {
        "subagent.default": { kind: "cognia", binding: { providerId: "gateway", modelId: "big" } },
      },
    }
    const { onChange } = renderFields({ value })
    const row = screen.getByTestId("role-model-slot-subagent.default")
    const [, effort] = within(row).getAllByRole("combobox")
    fireEvent.change(effort, { target: { value: "high" } })
    expect(onChange).toHaveBeenLastCalledWith({
      version: 1,
      slots: {
        "subagent.default": {
          kind: "cognia",
          binding: { providerId: "gateway", modelId: "big" },
          reasoningEffort: "high",
        },
      },
    })
  })

  it("offers only the efforts the chosen model accepts", () => {
    renderFields({
      value: {
        version: 1,
        slots: {
          "subagent.default": {
            kind: "cognia",
            binding: { providerId: "gateway", modelId: "big" },
          },
        },
      },
    })
    const row = screen.getByTestId("role-model-slot-subagent.default")
    const [, effort] = within(row).getAllByRole("combobox")
    const values = within(effort)
      .getAllByRole("option")
      .map((option) => (option as HTMLOptionElement).value)
    expect(values).toEqual(["__default__", "low", "medium", "high", "xhigh"])
  })

  it("compiles a template over its pinned configuration's overrides", () => {
    renderFields({
      layer: "subagent",
      inherited: {
        version: 1,
        slots: {
          "subagent.default": {
            kind: "cognia",
            binding: { providerId: "other", modelId: "elsewhere" },
          },
        },
      },
    })
    expect(
      within(screen.getByTestId("role-model-slot-subagent.default")).getByRole("alert")
    ).toHaveTextContent("Choose a model from gateway")
  })

  it("emits undefined once the last slot is cleared", () => {
    const value: AgentModelRoleOverrides = {
      version: 1,
      slots: {
        "subagent.default": { kind: "cognia", binding: { providerId: "gateway", modelId: "big" } },
      },
    }
    const { onChange } = renderFields({ value })
    const row = screen.getByTestId("role-model-slot-subagent.default")
    fireEvent.change(within(row).getAllByRole("combobox")[0], { target: { value: "__unset__" } })
    expect(onChange).toHaveBeenLastCalledWith(undefined)
  })

  it("offers explicit primary inheritance only on the subagent layer", () => {
    renderFields()
    const configRow = screen.getByTestId("role-model-slot-subagent.default")
    expect(
      within(configRow).queryByRole("option", { name: en.externalAgent.roleModels.modes.inherit })
    ).toBeNull()
  })

  it("lets a subagent template shield the configuration's slot with the primary model", () => {
    const { onChange } = renderFields({ layer: "subagent" })
    const row = screen.getByTestId("role-model-slot-subagent.default")
    expect(
      within(row).getByRole("option", { name: en.externalAgent.roleModels.modes.inherit })
    ).toBeInTheDocument()
    fireEvent.change(within(row).getByRole("combobox"), { target: { value: "__primary__" } })
    expect(onChange).toHaveBeenLastCalledWith({
      version: 1,
      slots: { "subagent.default": { kind: "inherit-primary" } },
    })
  })

  it("flags a stored cross-provider binding on its row", () => {
    renderFields({
      value: {
        version: 1,
        slots: {
          "subagent.default": {
            kind: "cognia",
            binding: { providerId: "other", modelId: "elsewhere" },
          },
        },
      },
    })
    const row = screen.getByTestId("role-model-slot-subagent.default")
    expect(within(row).getByRole("alert")).toHaveTextContent("Choose a model from gateway")
  })

  it("flags an effort on a model that does not reason", () => {
    renderFields({
      value: {
        version: 1,
        slots: {
          "subagent.default": {
            kind: "cognia",
            binding: { providerId: "gateway", modelId: "small" },
            reasoningEffort: "high",
          },
        },
      },
    })
    expect(
      within(screen.getByTestId("role-model-slot-subagent.default")).getByRole("alert")
    ).toHaveTextContent(en.externalAgent.roleModels.refusals.effortUnsupported)
  })

  it("lets the user remove a slot the runtime no longer declares", () => {
    const { onChange } = renderFields({
      config: config("opencode-v2-service", "opencode-v2"),
      value: {
        version: 1,
        slots: { "aux.small": { kind: "inherit-primary" } },
      },
    })
    fireEvent.click(screen.getByRole("button", { name: en.externalAgent.roleModels.removeStale }))
    expect(onChange).toHaveBeenLastCalledWith(undefined)
  })
})
