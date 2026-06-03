/**
 * @jest-environment jsdom
 *
 * Coverage for the Local Git (`action.git.*`) and OCR (`ocr.extract`) inspector
 * config forms. Verifies each form renders its fields, edits the right param
 * keys (with the comma-list ↔ string[] coercion), and that the OCR form hides
 * the source fields when `screen` is enabled.
 *
 * The repo's global `next-intl` mock resolves keys against the real
 * `i18n/messages/en.json` (it ignores provider `messages`), so we query by the
 * stable `data-field` attribute that the shared `Field` primitive stamps —
 * never by translated text — to stay independent of the i18n bundle.
 */
import { fireEvent, render, within } from "@testing-library/react"
import {
  GitStageConfig,
  GitCommitConfig,
  GitPushConfig,
  GitBranchConfig,
  OcrExtractConfig,
} from "./git-ocr-forms"

// ExpressionField mounts a Monaco-ish editor; stub it to a plain input so the
// forms render in jsdom and we can assert param edits without the heavy editor.
jest.mock("./shared/expression-field", () => ({
  ExpressionField: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <input value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}))

/** The input element inside the `Field` wrapper with `data-field={name}`. */
function fieldInput(container: HTMLElement, name: string): HTMLElement {
  const wrapper = container.querySelector(`[data-field="${name}"]`)
  if (!wrapper) throw new Error(`no field wrapper for "${name}"`)
  // Git/OCR forms render exactly one control per field (input or switch button).
  const control =
    (wrapper as HTMLElement).querySelector("input") ??
    within(wrapper as HTMLElement).getByRole("switch")
  return control as HTMLElement
}

describe("git-ocr-forms", () => {
  it("GitStageConfig edits repoPath and parses comma-separated paths", () => {
    const onChange = jest.fn()
    const { container } = render(<GitStageConfig params={{}} onChange={onChange} />)
    fireEvent.change(fieldInput(container, "repoPath"), { target: { value: "/work" } })
    expect(onChange).toHaveBeenCalledWith({ repoPath: "/work" })
    fireEvent.change(fieldInput(container, "paths"), { target: { value: "a.ts, b.ts ,, c.ts" } })
    expect(onChange).toHaveBeenCalledWith({ paths: ["a.ts", "b.ts", "c.ts"] })
  })

  it("GitCommitConfig reflects the message and toggles signoff", () => {
    const onChange = jest.fn()
    const { container } = render(
      <GitCommitConfig params={{ message: "init" }} onChange={onChange} />
    )
    expect((fieldInput(container, "message") as HTMLInputElement).value).toBe("init")
    fireEvent.click(fieldInput(container, "signoff"))
    expect(onChange).toHaveBeenCalledWith({ message: "init", signoff: true })
  })

  it("GitPushConfig edits remote and sets upstream", () => {
    const onChange = jest.fn()
    const { container } = render(<GitPushConfig params={{}} onChange={onChange} />)
    fireEvent.change(fieldInput(container, "remote"), { target: { value: "upstream" } })
    expect(onChange).toHaveBeenCalledWith({ remote: "upstream" })
    fireEvent.click(fieldInput(container, "setUpstream"))
    expect(onChange).toHaveBeenCalledWith({ setUpstream: true })
  })

  it("GitBranchConfig edits the name and defaults checkout on", () => {
    const onChange = jest.fn()
    const { container } = render(<GitBranchConfig params={{}} onChange={onChange} />)
    fireEvent.change(fieldInput(container, "name"), { target: { value: "feat/y" } })
    expect(onChange).toHaveBeenCalledWith({ name: "feat/y" })
    // checkout defaults to true → the switch is on without any param set.
    expect(fieldInput(container, "checkout")).toBeChecked()
  })

  it("OcrExtractConfig shows source fields by default and hides them when screen is on", () => {
    const { container, rerender } = render(<OcrExtractConfig params={{}} onChange={jest.fn()} />)
    expect(container.querySelector('[data-field="url"]')).toBeInTheDocument()
    expect(container.querySelector('[data-field="dataUrl"]')).toBeInTheDocument()
    rerender(<OcrExtractConfig params={{ screen: true }} onChange={jest.fn()} />)
    expect(container.querySelector('[data-field="url"]')).not.toBeInTheDocument()
    expect(container.querySelector('[data-field="dataUrl"]')).not.toBeInTheDocument()
    // languages + provider stay visible regardless of screen mode.
    expect(container.querySelector('[data-field="languages"]')).toBeInTheDocument()
    expect(container.querySelector('[data-field="provider"]')).toBeInTheDocument()
  })

  it("OcrExtractConfig parses languages into a string[]", () => {
    const onChange = jest.fn()
    const { container } = render(<OcrExtractConfig params={{}} onChange={onChange} />)
    fireEvent.change(fieldInput(container, "languages"), { target: { value: "en, fr" } })
    expect(onChange).toHaveBeenCalledWith({ languages: ["en", "fr"] })
  })
})
