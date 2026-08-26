/**
 * @jest-environment jsdom
 *
 * Coverage for the stacked-branch (`action.stack.*`) inspector config forms:
 * each renders its fields, edits the param keys the executors read, and the
 * layer list coerces between a comma-separated string and `string[]`.
 *
 * Queried by the stable `data-field` attribute the shared `Field` primitive
 * stamps, never by translated text — the repo's global `next-intl` mock
 * resolves against the real bundle, so text assertions would couple these
 * tests to copy.
 */
import { fireEvent, render } from "@testing-library/react"
import {
  StackListConfig,
  StackParentConfig,
  StackPushConfig,
  StackRestackConfig,
  StackValidateConfig,
} from "./stack-forms"

jest.mock("./shared/expression-field", () => ({
  ExpressionField: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <input value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}))

function fieldInput(container: HTMLElement, name: string): HTMLInputElement {
  const wrapper = container.querySelector(`[data-field="${name}"]`)
  if (!wrapper) throw new Error(`no field wrapper for "${name}"`)
  const control = wrapper.querySelector("input")
  if (!control) throw new Error(`no control in field "${name}"`)
  return control
}

describe("stack inspector forms", () => {
  it("every kind can address a repository", () => {
    for (const Form of [
      StackListConfig,
      StackParentConfig,
      StackValidateConfig,
      StackRestackConfig,
      StackPushConfig,
    ]) {
      const { container } = render(<Form params={{}} onChange={() => {}} />)
      expect(fieldInput(container, "repoPath")).toBeInTheDocument()
      expect(fieldInput(container, "projectId")).toBeInTheDocument()
    }
  })

  it("list has no layer fields — it is what finds them", () => {
    const { container } = render(<StackListConfig params={{}} onChange={() => {}} />)
    expect(container.querySelector('[data-field="branches"]')).toBeNull()
    expect(container.querySelector('[data-field="tipBranch"]')).toBeNull()
  })

  it("parent edits branch and parent", () => {
    const onChange = jest.fn()
    const { container } = render(<StackParentConfig params={{}} onChange={onChange} />)
    fireEvent.change(fieldInput(container, "branch"), { target: { value: "me/ui" } })
    expect(onChange).toHaveBeenLastCalledWith({ branch: "me/ui" })
    fireEvent.change(fieldInput(container, "parent"), { target: { value: "me/api" } })
    expect(onChange).toHaveBeenLastCalledWith({ parent: "me/api" })
  })

  it("the layer list round-trips through a comma-separated string", () => {
    const onChange = jest.fn()
    const { container } = render(
      <StackValidateConfig params={{ branches: ["me/api", "me/ui"] }} onChange={onChange} />
    )
    expect(fieldInput(container, "branches").value).toBe("me/api, me/ui")
    fireEvent.change(fieldInput(container, "branches"), { target: { value: "a, b ,, c " } })
    expect(onChange).toHaveBeenLastCalledWith({ branches: ["a", "b", "c"] })
  })

  it("restack offers an onto, validate does not", () => {
    const restack = render(<StackRestackConfig params={{}} onChange={() => {}} />)
    expect(fieldInput(restack.container, "onto")).toBeInTheDocument()
    const validate = render(<StackValidateConfig params={{}} onChange={() => {}} />)
    expect(validate.container.querySelector('[data-field="onto"]')).toBeNull()
  })

  it("push offers a remote and the shared layer fields", () => {
    const { container } = render(<StackPushConfig params={{}} onChange={() => {}} />)
    expect(fieldInput(container, "remote")).toBeInTheDocument()
    expect(fieldInput(container, "tipBranch")).toBeInTheDocument()
    expect(fieldInput(container, "branches")).toBeInTheDocument()
  })

  it("the tip branch is offered everywhere the layers are", () => {
    // The useful automation is "act on whatever is stacked on this", and a form
    // that only took an explicit list would push every author into a flow that
    // goes stale the moment somebody adds a layer.
    for (const Form of [StackValidateConfig, StackRestackConfig, StackPushConfig]) {
      const { container } = render(<Form params={{}} onChange={() => {}} />)
      expect(fieldInput(container, "tipBranch")).toBeInTheDocument()
    }
  })
})
