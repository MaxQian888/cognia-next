import { fireEvent, render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))
jest.mock("@/components/workflow/editor/inspector/forms/shared/multi-entity-picker", () => ({
  MultiEntityPicker: ({
    id,
    value,
    onChange,
  }: {
    id: string
    value: readonly string[]
    onChange: (next: string[]) => void
  }) => (
    <input
      data-testid={id}
      value={value.join(",")}
      onChange={(event) => onChange(event.target.value.split(",").filter(Boolean))}
    />
  ),
}))

import { TemplateMetadataEditor, type TemplateMetadataDraft } from "./template-metadata-editor"

function draft(overrides: Partial<TemplateMetadataDraft> = {}): TemplateMetadataDraft {
  return {
    metadata: {},
    dependencies: [],
    capabilities: [],
    compatibility: { platforms: ["desktop", "web", "mobile"] },
    ...overrides,
  }
}

function renderEditor(value: TemplateMetadataDraft) {
  const onChange = jest.fn()
  render(<TemplateMetadataEditor value={value} onChange={onChange} />)
  return onChange
}

describe("TemplateMetadataEditor", () => {
  it("narrows the platforms preflight will accept", () => {
    const onChange = renderEditor(draft())

    fireEvent.click(screen.getByLabelText("platforms.mobile"))

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ compatibility: { platforms: ["desktop", "web"] } })
    )
  })

  it("records a host version floor", () => {
    const onChange = renderEditor(draft())

    fireEvent.change(screen.getByLabelText("minHostVersion"), { target: { value: "2.1.0" } })

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        compatibility: { platforms: ["desktop", "web", "mobile"], minHostVersion: "2.1.0" },
      })
    )
  })

  it("adds a dependency row", () => {
    const onChange = renderEditor(draft())
    fireEvent.click(screen.getByRole("button", { name: /addDependency/ }))

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        dependencies: [{ id: "", kind: "template", requirement: "required" }],
      })
    )
  })

  it("offers a fallback only on an optional dependency", () => {
    renderEditor(draft({ dependencies: [{ id: "dep", kind: "plugin", requirement: "required" }] }))
    expect(screen.queryByLabelText("dependencyFallback")).not.toBeInTheDocument()

    renderEditor(draft({ dependencies: [{ id: "dep", kind: "plugin", requirement: "optional" }] }))
    expect(screen.getAllByLabelText("dependencyFallback").length).toBeGreaterThan(0)
  })

  it("seeds a localized entry per catalogue locale and can drop one", () => {
    const onChange = renderEditor(draft())
    fireEvent.click(screen.getAllByRole("button", { name: /addLocalized/ })[0])

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { localized: { en: { name: "" } } } })
    )

    const withLocale = renderEditor(
      draft({ metadata: { localized: { "zh-CN": { name: "笔记" } } } })
    )
    fireEvent.click(screen.getByLabelText("removeLocalized"))
    // The whole map goes away rather than becoming an empty object, which would
    // change the content hash for no reason on every draft that never had one.
    expect(withLocale).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { localized: undefined } })
    )
  })

  it("edits the capabilities the definition carries", () => {
    const onChange = renderEditor(draft())

    fireEvent.change(screen.getByTestId("template-capabilities"), {
      target: { value: "network,twin" },
    })

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ capabilities: ["network", "twin"] })
    )
  })
})
