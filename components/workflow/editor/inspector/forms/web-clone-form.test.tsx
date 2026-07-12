/**
 * @jest-environment jsdom
 *
 * Coverage for the web-clone (`io.webClone`) inspector config form. Verifies it
 * renders its fields, edits the right param keys, and that the optional-number
 * helper removes a param when its input is cleared.
 *
 * Like the git/ocr form suite, we query by the stable `data-field` attribute the
 * shared `Field` primitive stamps (never by translated text) and stub the heavy
 * `ExpressionField` editor to a plain input.
 */
import { fireEvent, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { WebCloneConfig } from "./web-clone-form"

jest.mock("./shared/expression-field", () => ({
  ExpressionField: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <input value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}))

// Radix Select drives pointer-capture + scrollIntoView, which jsdom lacks.
beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = jest.fn()
  window.HTMLElement.prototype.hasPointerCapture = jest.fn(() => false) as never
  window.HTMLElement.prototype.releasePointerCapture = jest.fn()
})

function fieldControl(container: HTMLElement, name: string): HTMLElement {
  const wrapper = container.querySelector(`[data-field="${name}"]`)
  if (!wrapper) throw new Error(`no field wrapper for "${name}"`)
  const control =
    (wrapper as HTMLElement).querySelector("input") ??
    within(wrapper as HTMLElement).getByRole("switch")
  return control as HTMLElement
}

describe("WebCloneConfig", () => {
  it("renders the core fields", () => {
    const { container } = render(<WebCloneConfig params={{}} onChange={jest.fn()} />)
    for (const name of [
      "url",
      "output",
      "extractComponents",
      "maxAssets",
      "pretty",
      "allowPrivateHosts",
    ]) {
      expect(container.querySelector(`[data-field="${name}"]`)).not.toBeNull()
    }
  })

  it("edits url and output", () => {
    const onChange = jest.fn()
    const { container } = render(<WebCloneConfig params={{}} onChange={onChange} />)
    fireEvent.change(fieldControl(container, "url"), { target: { value: "https://a.test/" } })
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ url: "https://a.test/" }))
    fireEvent.change(fieldControl(container, "output"), { target: { value: "site" } })
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ output: "site" }))
  })

  it("toggles the extractComponents switch", () => {
    const onChange = jest.fn()
    const { container } = render(<WebCloneConfig params={{}} onChange={onChange} />)
    fireEvent.click(fieldControl(container, "extractComponents"))
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ extractComponents: true }))
  })

  it("parses a numeric field and removes it when cleared", () => {
    const onChange = jest.fn()
    const { container } = render(<WebCloneConfig params={{ maxAssets: 50 }} onChange={onChange} />)
    const input = fieldControl(container, "maxAssets")
    fireEvent.change(input, { target: { value: "200" } })
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ maxAssets: 200 }))
    // Clearing removes the key entirely (so the engine default applies).
    fireEvent.change(input, { target: { value: "" } })
    const last = onChange.mock.calls.at(-1)![0]
    expect("maxAssets" in last).toBe(false)
  })

  it("edits the remaining number fields and switches", () => {
    const onChange = jest.fn()
    const { container } = render(<WebCloneConfig params={{}} onChange={onChange} />)
    fireEvent.change(fieldControl(container, "concurrency"), { target: { value: "8" } })
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ concurrency: 8 }))
    fireEvent.change(fieldControl(container, "timeout"), { target: { value: "20000" } })
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ timeout: 20000 }))
    fireEvent.change(fieldControl(container, "maxFileSize"), { target: { value: "1000" } })
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ maxFileSize: 1000 }))
    fireEvent.click(fieldControl(container, "pretty"))
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ pretty: true }))
    fireEvent.click(fieldControl(container, "allowPrivateHosts"))
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ allowPrivateHosts: true }))
  })

  it("selects a mode via the Radix Select", async () => {
    const user = userEvent.setup()
    const onChange = jest.fn()
    const { container } = render(<WebCloneConfig params={{}} onChange={onChange} />)
    const trigger = within(container.querySelector('[data-field="mode"]') as HTMLElement).getByRole(
      "combobox"
    )
    await user.click(trigger)
    await user.click(await screen.findByRole("option", { name: /single/i }))
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "single" }))
  })

  it("picks a framework (adds key) and clearing to None removes it", async () => {
    const user = userEvent.setup()
    const onChange = jest.fn()
    const { container, rerender } = render(<WebCloneConfig params={{}} onChange={onChange} />)
    const fwTrigger = within(
      container.querySelector('[data-field="framework"]') as HTMLElement
    ).getByRole("combobox")
    await user.click(fwTrigger)
    await user.click(await screen.findByRole("option", { name: /^React$/ }))
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ framework: "react" }))

    // With a framework set, choosing "None" strips the key.
    onChange.mockClear()
    rerender(<WebCloneConfig params={{ framework: "react" }} onChange={onChange} />)
    const fwTrigger2 = within(
      container.querySelector('[data-field="framework"]') as HTMLElement
    ).getByRole("combobox")
    await user.click(fwTrigger2)
    await user.click(await screen.findByRole("option", { name: /None/i }))
    const last = onChange.mock.calls.at(-1)![0]
    expect("framework" in last).toBe(false)
  })
})
