/**
 * @jest-environment jsdom
 *
 * Coverage for the Artifact + Canvas (`action.artifact.*` / `action.canvas.*`)
 * inspector config forms. Verifies each form renders the fields its schema
 * declares and edits the right param keys.
 *
 * The repo's global `next-intl` mock resolves keys against the real
 * `i18n/messages/en.json`, so fields are queried by the stable `data-field`
 * attribute the shared `Field` primitive stamps — never by translated text.
 */
import { fireEvent, render } from "@testing-library/react"
import {
  ArtifactCreateConfig,
  ArtifactExportConfig,
  ArtifactGetConfig,
  ArtifactUpdateConfig,
  CanvasCreateConfig,
  CanvasGetConfig,
} from "./artifact-forms"

// ExpressionField mounts a Monaco-ish editor; stub it to a plain input so the
// forms render in jsdom and we can assert param edits without the heavy editor.
jest.mock("./shared/expression-field", () => ({
  ExpressionField: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <input value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}))

function fieldInput(container: HTMLElement, name: string): HTMLElement {
  const wrapper = container.querySelector(`[data-field="${name}"]`)
  if (!wrapper) throw new Error(`no field wrapper for "${name}"`)
  const el = wrapper as HTMLElement
  const control = el.querySelector("input") ?? el.querySelector("textarea")
  if (!control) throw new Error(`no editable control inside "${name}"`)
  return control as HTMLElement
}

const fieldNames = (container: HTMLElement) =>
  [...container.querySelectorAll("[data-field]")].map((n) => n.getAttribute("data-field"))

describe("ArtifactCreateConfig", () => {
  it("offers the fields the params schema requires", () => {
    const { container } = render(<ArtifactCreateConfig params={{}} onChange={jest.fn()} />)
    expect(fieldNames(container)).toEqual(
      expect.arrayContaining(["title", "type", "content", "language", "sessionId"])
    )
  })

  it("hides the chart type until the artifact is a chart", () => {
    // `chartType` is only read for chart artifacts; offering it on a code
    // artifact would advertise a param the executor ignores.
    const { container, rerender } = render(
      <ArtifactCreateConfig params={{ type: "code" }} onChange={jest.fn()} />
    )
    expect(fieldNames(container)).not.toContain("chartType")

    rerender(<ArtifactCreateConfig params={{ type: "chart" }} onChange={jest.fn()} />)
    expect(fieldNames(container)).toContain("chartType")
  })

  it("edits the param key the executor reads", () => {
    const onChange = jest.fn()
    const { container } = render(<ArtifactCreateConfig params={{}} onChange={onChange} />)
    fireEvent.change(fieldInput(container, "title"), { target: { value: "Revenue" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ title: "Revenue" }))
  })

  it("takes the content through a textarea, not a one-line field", () => {
    // The body is usually a multi-line expression referring to an earlier step.
    const { container } = render(<ArtifactCreateConfig params={{}} onChange={jest.fn()} />)
    expect(fieldInput(container, "content").tagName).toBe("TEXTAREA")
  })
})

describe("ArtifactUpdateConfig", () => {
  it("offers the id, the new content and the version note", () => {
    const { container } = render(<ArtifactUpdateConfig params={{}} onChange={jest.fn()} />)
    expect(fieldNames(container)).toEqual(
      expect.arrayContaining(["artifactId", "content", "title", "changeDescription"])
    )
  })

  it("edits changeDescription", () => {
    const onChange = jest.fn()
    const { container } = render(<ArtifactUpdateConfig params={{}} onChange={onChange} />)
    fireEvent.change(fieldInput(container, "changeDescription"), { target: { value: "sept" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ changeDescription: "sept" }))
  })
})

describe("ArtifactGetConfig", () => {
  it("leaves the id optional and offers the list filter beside it", () => {
    // Both empty means "list this conversation's artifacts", which is a real
    // configuration rather than an incomplete one.
    const { container } = render(<ArtifactGetConfig params={{}} onChange={jest.fn()} />)
    expect(fieldNames(container)).toEqual(
      expect.arrayContaining(["artifactId", "query", "sessionId"])
    )
    expect(container.querySelector('[data-field="artifactId"]')?.textContent).not.toMatch(/\*/)
  })
})

describe("ArtifactExportConfig", () => {
  it("offers the id and a closed format list", () => {
    const { container } = render(<ArtifactExportConfig params={{}} onChange={jest.fn()} />)
    expect(fieldNames(container)).toEqual(expect.arrayContaining(["artifactId", "format"]))
  })

  it("defaults the format to the source text rather than a render", () => {
    const { container } = render(<ArtifactExportConfig params={{}} onChange={jest.fn()} />)
    const trigger = container.querySelector('[data-field="format"] [role="combobox"]')
    expect(trigger?.textContent).toBe("raw")
  })
})

describe("CanvasCreateConfig", () => {
  it("offers title, language, content and the document type", () => {
    const { container } = render(<CanvasCreateConfig params={{}} onChange={jest.fn()} />)
    expect(fieldNames(container)).toEqual(
      expect.arrayContaining(["title", "language", "content", "type", "sessionId"])
    )
  })

  it("defaults the document type to code", () => {
    const { container } = render(<CanvasCreateConfig params={{}} onChange={jest.fn()} />)
    const trigger = container.querySelector('[data-field="type"] [role="combobox"]')
    expect(trigger?.textContent).toBe("Code")
  })
})

describe("CanvasGetConfig", () => {
  it("offers an optional document id and the conversation", () => {
    const { container } = render(<CanvasGetConfig params={{}} onChange={jest.fn()} />)
    expect(fieldNames(container)).toEqual(expect.arrayContaining(["documentId", "sessionId"]))
  })

  it("edits documentId", () => {
    const onChange = jest.fn()
    const { container } = render(<CanvasGetConfig params={{}} onChange={onChange} />)
    fireEvent.change(fieldInput(container, "documentId"), { target: { value: "doc_1" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ documentId: "doc_1" }))
  })
})
