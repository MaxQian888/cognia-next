import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import en from "@/i18n/messages/en.json"
import type { ExternalAgentCogniaModelBinding } from "@/types/agent/external-agent"
import {
  TemplateCogniaModelFields,
  templateModelRolesInvalid,
} from "./template-cognia-model-fields"

const pickerProps: Array<Record<string, unknown>> = []
const roleProps: Array<Record<string, unknown>> = []
const agents: Record<string, unknown> = {}

jest.mock("@/stores/agent/external-agent-store", () => ({
  useExternalAgentStore: (select: (s: unknown) => unknown) => select({ agents }),
}))
jest.mock("@/components/agent/external-agent/cognia-model-picker", () => ({
  CogniaModelPicker: (props: {
    value: ExternalAgentCogniaModelBinding | null
    onChange: (value: ExternalAgentCogniaModelBinding | null) => void
  }) => {
    pickerProps.push(props)
    return (
      <div>
        <button
          type="button"
          onClick={() => props.onChange({ providerId: "gateway", modelId: "big" })}
        >
          pick
        </button>
        <button type="button" onClick={() => props.onChange(null)}>
          off
        </button>
      </div>
    )
  },
}))
jest.mock("@/components/agent/external-agent/role-model-fields", () => ({
  RoleModelFields: (props: Record<string, unknown>) => {
    roleProps.push(props)
    return <div data-testid="role-rows" />
  },
}))

const messages = en as unknown as Record<string, unknown>
const t = en.settings.subagents.templates

function renderFields(config: Parameters<typeof TemplateCogniaModelFields>[0]["config"]) {
  const onChange = jest.fn()
  const view = render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <TemplateCogniaModelFields config={config} onChange={onChange} />
    </NextIntlClientProvider>
  )
  return { onChange, ...view }
}

beforeEach(() => {
  pickerProps.length = 0
  roleProps.length = 0
  for (const key of Object.keys(agents)) delete agents[key]
})

describe("TemplateCogniaModelFields", () => {
  it("is hidden for a built-in (non-external) template", () => {
    const { container } = renderFields({})
    expect(container).toBeEmptyDOMElement()
  })

  it("judges the preset's launch shape and edits the template layer", () => {
    renderFields({ externalPresetId: "claude-code" })
    expect(screen.getByText(t.cogniaModelHint)).toBeInTheDocument()
    const runtime = pickerProps.at(-1)!.config as { protocol: string; metadata: { preset: string } }
    expect(runtime.protocol).toBe("acp")
    expect(runtime.metadata.preset).toBe("claude-code")
    expect(roleProps.at(-1)).toMatchObject({ layer: "subagent", primary: undefined })
  })

  it("judges the pinned configuration and follows its binding for sub-task rows", () => {
    const binding = { providerId: "gateway", modelId: "pinned" }
    agents.saved = { protocol: "acp", transport: "stdio", cogniaModel: binding, metadata: {} }
    renderFields({ externalPresetId: "claude-code", externalAgentConfigId: "saved" })
    expect(screen.getByText(t.cogniaModelPinnedHint)).toBeInTheDocument()
    expect(pickerProps.at(-1)!.config).toBe(agents.saved)
    expect(pickerProps.at(-1)!.value).toBeNull()
    expect(roleProps.at(-1)!.primary).toEqual(binding)
  })

  it("stores a template binding and clears it (not the native lane) when switched off", () => {
    const { onChange } = renderFields({ externalPresetId: "claude-code" })
    fireEvent.click(screen.getByText("pick"))
    expect(onChange).toHaveBeenLastCalledWith({
      cogniaModel: { providerId: "gateway", modelId: "big" },
    })
    fireEvent.click(screen.getByText("off"))
    expect(onChange).toHaveBeenLastCalledWith({ cogniaModel: undefined })
  })

  it("passes the pinned slots down only while the template stays on their provider account", () => {
    const roles = { version: 1, slots: { "subagent.default": { kind: "inherit-primary" } } }
    agents.saved = {
      protocol: "acp",
      transport: "stdio",
      cogniaModel: { providerId: "x", modelId: "y" },
      modelRoles: roles,
    }
    renderFields({ externalPresetId: "claude-code", externalAgentConfigId: "saved" })
    expect(roleProps.at(-1)!.inherited).toBe(roles)
    renderFields({
      externalPresetId: "claude-code",
      externalAgentConfigId: "saved",
      cogniaModel: { providerId: "other", modelId: "z" },
    })
    expect(roleProps.at(-1)!.inherited).toBeUndefined()
  })

  it("prefers the template's own binding as the sub-task primary", () => {
    const own = { providerId: "gateway", modelId: "own" }
    agents.saved = {
      protocol: "acp",
      transport: "stdio",
      cogniaModel: { providerId: "x", modelId: "y" },
    }
    renderFields({
      externalPresetId: "claude-code",
      externalAgentConfigId: "saved",
      cogniaModel: own,
    })
    expect(roleProps.at(-1)!.primary).toEqual(own)
  })
})

describe("templateModelRolesInvalid", () => {
  const pinned = {
    protocol: "acp" as const,
    transport: "stdio" as const,
    process: { command: "claude-agent-acp" },
    metadata: { preset: "claude-code" },
    cogniaModel: { providerId: "a", modelId: "a-big" },
    modelRoles: {
      version: 1 as const,
      slots: {
        "subagent.default": {
          kind: "cognia" as const,
          binding: { providerId: "a", modelId: "a-small" },
        },
      },
    },
  }

  it("does not hold a template on another provider to the pinned configuration's slots", () => {
    // Admission runs such a template on its own primary alone.
    expect(
      templateModelRolesInvalid(
        {
          externalPresetId: "claude-code",
          externalAgentConfigId: "saved",
          cogniaModel: { providerId: "b", modelId: "b-big" },
        },
        pinned,
        null
      )
    ).toBe(false)
  })

  it("refuses a template's own slot on another provider than its primary", () => {
    expect(
      templateModelRolesInvalid(
        {
          externalPresetId: "claude-code",
          externalAgentConfigId: "saved",
          cogniaModel: { providerId: "b", modelId: "b-big" },
          modelRoles: pinned.modelRoles,
        },
        pinned,
        null
      )
    ).toBe(true)
  })

  it("judges a template that follows the pinned binding over the inherited slots", () => {
    const stale = {
      ...pinned,
      modelRoles: {
        version: 1 as const,
        slots: { "aux.unknown": { kind: "inherit-primary" as const } },
      },
    }
    expect(
      templateModelRolesInvalid(
        { externalPresetId: "claude-code", externalAgentConfigId: "saved" },
        stale,
        null
      )
    ).toBe(true)
    expect(
      templateModelRolesInvalid(
        {
          externalPresetId: "claude-code",
          externalAgentConfigId: "saved",
          modelRoles: { version: 1, slots: { "subagent.default": { kind: "inherit-primary" } } },
        },
        pinned,
        null
      )
    ).toBe(false)
  })

  it("has nothing to judge without an external preset or a binding", () => {
    expect(templateModelRolesInvalid({ modelRoles: pinned.modelRoles }, undefined, null)).toBe(
      false
    )
    expect(
      templateModelRolesInvalid(
        { externalPresetId: "claude-code", modelRoles: pinned.modelRoles },
        undefined,
        null
      )
    ).toBe(false)
  })
})
