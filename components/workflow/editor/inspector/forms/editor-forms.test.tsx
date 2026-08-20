/**
 * @jest-environment jsdom
 *
 * Coverage for the Pro IDE (`action.editor.*`) inspector config forms. Verifies
 * each form renders the fields its schema declares, edits the right param keys,
 * and coerces the 1-based position inputs the way the schema expects.
 *
 * The repo's global `next-intl` mock resolves keys against the real
 * `i18n/messages/en.json`, so fields are queried by the stable `data-field`
 * attribute the shared `Field` primitive stamps — never by translated text.
 */
import { fireEvent, render, within } from "@testing-library/react"
import {
  EditorApplyEditConfig,
  EditorOpenConfig,
  EditorReadActiveConfig,
  EditorRevealConfig,
  EditorSaveAllConfig,
  EditorShowDiffConfig,
} from "./editor-forms"

// ExpressionField mounts a Monaco-ish editor; stub it to a plain input so the
// forms render in jsdom and we can assert param edits without the heavy editor.
jest.mock("./shared/expression-field", () => ({
  ExpressionField: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <input value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}))

/** The control inside the `Field` wrapper with `data-field={name}`. */
function fieldInput(container: HTMLElement, name: string): HTMLElement {
  const wrapper = container.querySelector(`[data-field="${name}"]`)
  if (!wrapper) throw new Error(`no field wrapper for "${name}"`)
  const el = wrapper as HTMLElement
  const control =
    el.querySelector("input") ?? el.querySelector("textarea") ?? within(el).getByRole("switch")
  return control as HTMLElement
}

const fieldNames = (container: HTMLElement) =>
  [...container.querySelectorAll("[data-field]")].map((n) => n.getAttribute("data-field"))

describe("editor-forms", () => {
  it("every form offers the shared root + autoStart controls", () => {
    // The addressing story is per-node: each one must let an author pin a
    // workspace and decide whether the step may start code-server.
    for (const Form of [
      EditorOpenConfig,
      EditorRevealConfig,
      EditorShowDiffConfig,
      EditorReadActiveConfig,
      EditorApplyEditConfig,
      EditorSaveAllConfig,
    ]) {
      const { container, unmount } = render(<Form params={{}} onChange={jest.fn()} />)
      expect(fieldNames(container)).toEqual(expect.arrayContaining(["root", "autoStart"]))
      unmount()
    }
  })

  it("EditorOpenConfig edits root, path and the 1-based position", () => {
    const onChange = jest.fn()
    const { container } = render(<EditorOpenConfig params={{}} onChange={onChange} />)
    expect(fieldNames(container)).toEqual(["root", "path", "line", "column", "autoStart"])

    fireEvent.change(fieldInput(container, "root"), { target: { value: "/work/proj" } })
    expect(onChange).toHaveBeenLastCalledWith({ root: "/work/proj" })

    fireEvent.change(fieldInput(container, "path"), { target: { value: "src/a.ts" } })
    expect(onChange).toHaveBeenLastCalledWith({ path: "src/a.ts" })

    fireEvent.change(fieldInput(container, "line"), { target: { value: "42" } })
    expect(onChange).toHaveBeenLastCalledWith({ line: 42 })
  })

  it("clears a position param when its field is emptied", () => {
    // `undefined` (not 0) — the schema reads absence as "wherever the file
    // already is", while 0 would be rejected as below the 1-based minimum.
    const onChange = jest.fn()
    const { container } = render(<EditorOpenConfig params={{ line: 42 }} onChange={onChange} />)
    fireEvent.change(fieldInput(container, "line"), { target: { value: "" } })
    expect(onChange).toHaveBeenLastCalledWith({ line: undefined })
  })

  it("ignores an unparseable position rather than writing NaN", () => {
    const onChange = jest.fn()
    const { container } = render(<EditorOpenConfig params={{}} onChange={onChange} />)
    fireEvent.change(fieldInput(container, "column"), { target: { value: "abc" } })
    expect(onChange).toHaveBeenLastCalledWith({ column: undefined })
  })

  it("EditorRevealConfig offers no position — reveal has none", () => {
    const { container } = render(<EditorRevealConfig params={{}} onChange={jest.fn()} />)
    expect(fieldNames(container)).toEqual(["root", "path", "autoStart"])
  })

  it("EditorShowDiffConfig edits the proposal and its title", () => {
    const onChange = jest.fn()
    const { container } = render(<EditorShowDiffConfig params={{}} onChange={onChange} />)
    expect(fieldNames(container)).toEqual(["root", "path", "content", "title", "autoStart"])

    fireEvent.change(fieldInput(container, "content"), { target: { value: "next contents" } })
    expect(onChange).toHaveBeenLastCalledWith({ content: "next contents" })

    fireEvent.change(fieldInput(container, "title"), { target: { value: "Proposed fix" } })
    expect(onChange).toHaveBeenLastCalledWith({ title: "Proposed fix" })
  })

  it("EditorReadActiveConfig asks for nothing but the target", () => {
    const { container } = render(<EditorReadActiveConfig params={{}} onChange={jest.fn()} />)
    expect(fieldNames(container)).toEqual(["root", "autoStart"])
  })

  it("EditorApplyEditConfig edits path and position", () => {
    const onChange = jest.fn()
    const { container } = render(<EditorApplyEditConfig params={{}} onChange={onChange} />)
    expect(fieldNames(container)).toEqual(["root", "path", "line", "column", "autoStart"])
    fireEvent.change(fieldInput(container, "path"), { target: { value: "src/a.ts" } })
    expect(onChange).toHaveBeenLastCalledWith({ path: "src/a.ts" })
  })

  it("EditorSaveAllConfig treats path as the optional narrowing filter", () => {
    const onChange = jest.fn()
    const { container } = render(<EditorSaveAllConfig params={{}} onChange={onChange} />)
    expect(fieldNames(container)).toEqual(["root", "path", "autoStart"])
    fireEvent.change(fieldInput(container, "path"), { target: { value: "src/a.ts" } })
    expect(onChange).toHaveBeenLastCalledWith({ path: "src/a.ts" })
  })

  it("toggles autoStart off by default and on when switched", () => {
    const onChange = jest.fn()
    const { container } = render(<EditorReadActiveConfig params={{}} onChange={onChange} />)
    const toggle = fieldInput(container, "autoStart")
    expect(toggle).toHaveAttribute("aria-checked", "false")
    fireEvent.click(toggle)
    expect(onChange).toHaveBeenLastCalledWith({ autoStart: true })
  })
})
