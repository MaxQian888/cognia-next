/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/components/settings/common/model-override-fields", () => ({
  useUtilityProviderOptions: () => [
    { id: "anthropic", name: "Anthropic" },
    { id: "openai", name: "OpenAI" },
  ],
}))

jest.mock("@/lib/db/settings", () => ({ saveSettings: jest.fn() }))

jest.mock("@/lib/tools/tool-catalog", () => ({
  getToolCatalog: jest.fn(async () => []),
  searchToolCatalog: (entries: unknown[]) => entries,
}))

import { useState } from "react"
import { act, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { AdvancedOverridesFields, AdvancedOverridesSection } from "./advanced-overrides-section"
import { emptyAgentOverrides, pickAgentOverrides, type AgentOverrides } from "./agent-overrides"

/** Blur commits through an async draft; settle it inside act. */
async function commitBlur(element: HTMLElement) {
  await act(async () => {
    fireEvent.blur(element)
  })
}

function Harness({
  initial,
  onChange,
}: {
  initial: AgentOverrides
  onChange: (next: AgentOverrides) => void
}) {
  const [value, setValue] = useState(initial)
  return (
    <AdvancedOverridesFields
      value={value}
      onChange={(next) => {
        setValue(next)
        onChange(next)
      }}
    />
  )
}

function renderFields(initial: AgentOverrides = emptyAgentOverrides()) {
  const onChange = jest.fn<void, [AgentOverrides]>()
  render(<Harness initial={initial} onChange={onChange} />)
  const last = () => onChange.mock.calls.at(-1)?.[0]
  return { onChange, last }
}

async function choose(label: string, option: string) {
  const user = userEvent.setup()
  await user.click(screen.getByRole("combobox", { name: label }))
  await user.click(screen.getByRole("option", { name: option }))
}

describe("AdvancedOverridesSection", () => {
  it("starts collapsed and counts the overrides it holds", async () => {
    const user = userEvent.setup()
    render(
      <AdvancedOverridesSection
        value={pickAgentOverrides({ enableOcr: false, providerId: "openai" })}
        onChange={jest.fn()}
      />
    )
    expect(screen.getByText("count")).toBeInTheDocument()
    expect(screen.queryByRole("combobox", { name: "provider.label" })).not.toBeInTheDocument()

    await user.click(screen.getByTestId("agent-advanced-overrides"))
    expect(screen.getByRole("combobox", { name: "provider.label" })).toHaveTextContent("OpenAI")
  })

  it("hides the count while everything inherits", () => {
    render(<AdvancedOverridesSection value={emptyAgentOverrides()} onChange={jest.fn()} />)
    expect(screen.queryByText("count")).not.toBeInTheDocument()
  })
})

describe("AdvancedOverridesFields", () => {
  it("shows every simple override as inherited for an agent that sets none", () => {
    renderFields()
    for (const label of [
      "provider.label",
      "outputStyle.label",
      "a2ui.label",
      "a2uiCatalog.label",
      "workspaceConfinement.label",
    ]) {
      expect(screen.getByRole("combobox", { name: label })).toHaveTextContent("inherit")
    }
    expect(screen.getByRole("combobox", { name: "pluginTools.label" })).toHaveTextContent(
      "pluginTools.default"
    )
    expect(screen.getByRole("combobox", { name: "builtInSkills.label" })).toHaveTextContent(
      "builtInSkills.default"
    )
    expect(screen.getByRole("combobox", { name: "ocr.label" })).toHaveTextContent("ocr.default")
    expect(screen.getByLabelText("thinking.label")).toHaveValue(null)
  })

  it("picks a provider and returns to inherit", async () => {
    const { last } = renderFields()
    await choose("provider.label", "OpenAI")
    expect(last()?.providerId).toBe("openai")
    await choose("provider.label", "inherit")
    expect(last()?.providerId).toBeUndefined()
  })

  it("stores plugin tools inverted as disablePluginTools", async () => {
    const { last } = renderFields()
    await choose("pluginTools.label", "off")
    expect(last()?.disablePluginTools).toBe(true)
    await choose("pluginTools.label", "on")
    expect(last()?.disablePluginTools).toBe(false)
    await choose("pluginTools.label", "pluginTools.default")
    expect(last()?.disablePluginTools).toBeUndefined()
  })

  it.each([
    ["a2ui.label", "a2uiEnabled", "on", true],
    ["builtInSkills.label", "enableBuiltInSkills", "on", true],
    ["ocr.label", "enableOcr", "off", false],
    ["workspaceConfinement.label", "workspaceConfinementEnabled", "off", false],
  ] as const)("sets %s explicitly", async (label, field, option, expected) => {
    const { last } = renderFields()
    await choose(label, option)
    expect(last()?.[field]).toBe(expected)
  })

  it("picks a registered A2UI catalog and returns to inheriting", async () => {
    const { last } = renderFields()
    await choose("a2uiCatalog.label", "global.standardCatalog")
    expect(last()?.a2uiCatalogId).toBe("cognia-standard-v1")
    await choose("a2uiCatalog.label", "inherit")
    expect(last()?.a2uiCatalogId).toBeUndefined()
  })

  it("keeps showing a pack catalog that is not registered here", () => {
    renderFields(pickAgentOverrides({ a2uiCatalogId: "pack-financial" }))
    // The mocked translator returns the key; the real copy names the value.
    expect(screen.getByRole("combobox", { name: "a2uiCatalog.label" })).toHaveTextContent(
      "unknownValue"
    )
  })

  it("sets a thinking budget, keeps 0 as a real value, and clears on empty", async () => {
    const { last } = renderFields()
    const input = screen.getByLabelText("thinking.label")
    fireEvent.change(input, { target: { value: "80000" } })
    await commitBlur(input)
    expect(last()?.maxThinkingTokens).toBe(64000)
    fireEvent.change(input, { target: { value: "0" } })
    await commitBlur(input)
    expect(last()?.maxThinkingTokens).toBe(0)
    fireEvent.change(input, { target: { value: "" } })
    await commitBlur(input)
    expect(last()?.maxThinkingTokens).toBeUndefined()
  })

  it("pins the default output style and keeps custom text independent", async () => {
    const { last } = renderFields()
    fireEvent.change(screen.getByLabelText("outputStyle.customLabel"), {
      target: { value: "Answer in haiku." },
    })
    expect(last()?.customOutputStyle).toBe("Answer in haiku.")

    await choose("outputStyle.label", "outputStyle.default")
    expect(last()?.outputStyle).toBe("default")
    // Picking another style never throws away text the user wrote.
    expect(last()?.customOutputStyle).toBe("Answer in haiku.")

    fireEvent.change(screen.getByLabelText("outputStyle.customLabel"), { target: { value: "  " } })
    expect(last()?.customOutputStyle).toBeUndefined()
    // A pinned non-custom style with no text has nothing to show.
    expect(screen.queryByLabelText("outputStyle.customLabel")).not.toBeInTheDocument()
  })

  it("leaves every other field untouched by reference when one changes", async () => {
    const toolFilter = { mode: "deny" as const, tools: ["Bash"] }
    const platformDefaults = { mode: "draft" as const }
    const { last } = renderFields(pickAgentOverrides({ toolFilter, platformDefaults }))
    await choose("a2ui.label", "on")
    expect(last()?.toolFilter).toBe(toolFilter)
    expect(last()?.platformDefaults).toBe(platformDefaults)
  })
})
