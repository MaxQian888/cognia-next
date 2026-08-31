/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"

import { TemplateBindingField } from "./template-binding-field"
import type { TemplateInputSpec } from "@/lib/templates/contracts"

jest.mock("@/components/workflow/editor/inspector/forms/shared/entity-picker", () => ({
  ModelPicker: (p: { id: string }) => <div data-testid={`picker-model-${p.id}`} />,
  CharacterPicker: (p: { id: string }) => <div data-testid={`picker-character-${p.id}`} />,
  SubworkflowPicker: (p: { id: string }) => <div data-testid={`picker-workflow-${p.id}`} />,
  TwinPicker: (p: { id: string }) => <div data-testid={`picker-twin-${p.id}`} />,
  SkillPicker: (p: { id: string }) => <div data-testid={`picker-skill-${p.id}`} />,
  SkillMultiPicker: (p: { id: string }) => <div data-testid={`picker-skill-multi-${p.id}`} />,
  ToolPicker: (p: { id: string }) => <div data-testid={`picker-tool-${p.id}`} />,
}))

const messages = {
  templateStudio: {
    inspector: { required: "(required)" },
    inputKinds: {
      string: "Text",
      number: "Number",
      boolean: "Boolean",
      enum: "Choice",
      resource: "Resource",
      secretRef: "Credential",
      twinSlot: "Twin",
      model: "Model",
      provider: "Provider",
      tool: "Tool",
      skill: "Skill",
      character: "Character",
      workflow: "Workflow",
    },
  },
}

function renderField(input: TemplateInputSpec, value = "") {
  render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <TemplateBindingField input={input} value={value} onChange={jest.fn()} />
    </NextIntlClientProvider>
  )
}

const base = { id: "i1", label: "Pick one", required: false }

describe("TemplateBindingField", () => {
  /**
   * Every kind rendered a plain text `<Input>` before this, so binding a
   * template to a character meant typing a `chr_…` id from memory and finding
   * out at preflight whether it was right.
   */
  it.each([
    ["model", "picker-model-binding-i1"],
    ["character", "picker-character-binding-i1"],
    ["workflow", "picker-workflow-binding-i1"],
    ["twinSlot", "picker-twin-binding-i1"],
    ["skill", "picker-skill-binding-i1"],
    ["tool", "picker-tool-binding-i1"],
  ])("opens the %s registry rather than a text box", (kind, testid) => {
    renderField({ ...base, kind } as TemplateInputSpec)
    expect(screen.getByTestId(testid)).toBeInTheDocument()
  })

  it("switches to the multi picker when the selector allows it", () => {
    renderField({ ...base, kind: "skill", selector: { allowMultiple: true } } as TemplateInputSpec)
    expect(screen.getByTestId("picker-skill-multi-binding-i1")).toBeInTheDocument()
  })

  it("renders an enum as its declared options", () => {
    renderField({ ...base, kind: "enum", options: ["a", "b"] } as TemplateInputSpec)
    expect(screen.getByRole("combobox")).toBeInTheDocument()
  })

  it("renders a boolean as a switch, not the strings true and false", () => {
    renderField({ ...base, kind: "boolean" } as TemplateInputSpec, "true")
    const toggle = screen.getByRole("switch")
    expect(toggle).toBeInTheDocument()
    expect(toggle).toBeChecked()
  })

  it("keeps a text box for the kinds no registry can enumerate", () => {
    // A provider may be configured only by base URL, `resource` carries a
    // free-form `resourceKind`, and a secret is a keyring reference the
    // Studio must never read back.
    for (const kind of ["string", "provider", "resource", "secretRef"]) {
      renderField({ ...base, id: `i-${kind}`, kind } as TemplateInputSpec)
    }
    expect(screen.getAllByRole("textbox")).toHaveLength(4)
  })

  it("renders the description the contract has always carried", () => {
    // It has been on `TemplateInputSpec` from the start and was never shown,
    // so the only guidance an author could give was the label.
    renderField({ ...base, kind: "string", description: "Where to post" } as TemplateInputSpec)
    expect(screen.getByText("Where to post")).toBeInTheDocument()
  })
})
