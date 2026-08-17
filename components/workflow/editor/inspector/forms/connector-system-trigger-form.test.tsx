/**
 * @jest-environment jsdom
 *
 * `trigger.connector.system` inspector form: adapter + optional conversation
 * key, multi-select of the gesture kinds (mirrors the params schema enum) and
 * the `targetSelfOnly` gate. Queries by `data-field` / `data-testid`, never by
 * translated text (the global next-intl mock resolves against en.json).
 */
import { fireEvent, render, within } from "@testing-library/react"

// Entity pickers hit Dexie live queries — swap for plain inputs.
jest.mock("./shared/entity-picker", () => ({
  ...Object.fromEntries(
    ["AdapterInstancePicker", "CharacterPicker", "TeamPicker", "EntityPicker"].map((name) => [
      name,
      ({
        value,
        onChange,
        id,
      }: {
        value?: string
        onChange?: (v: string) => void
        id?: string
      }) => <input id={id} value={value ?? ""} onChange={(e) => onChange?.(e.target.value)} />,
    ])
  ),
}))

import { ConnectorSystemTriggerConfig } from "./trigger-forms"
import { CONNECTOR_SYSTEM_EVENT_KINDS } from "./form-support"

function fieldInput(container: HTMLElement, name: string): HTMLElement {
  const wrapper = container.querySelector(`[data-field="${name}"]`)
  if (!wrapper) throw new Error(`no field wrapper for "${name}"`)
  return (wrapper as HTMLElement).querySelector("input") as HTMLElement
}

describe("ConnectorSystemTriggerConfig", () => {
  it("edits adapterId and conversationKey", () => {
    const onChange = jest.fn()
    const { container } = render(<ConnectorSystemTriggerConfig params={{}} onChange={onChange} />)
    fireEvent.change(fieldInput(container, "adapterId"), { target: { value: "lark-1" } })
    expect(onChange).toHaveBeenCalledWith({ adapterId: "lark-1" })
    fireEvent.change(fieldInput(container, "conversationKey"), {
      target: { value: "lark:lark-1:oc_1" },
    })
    expect(onChange).toHaveBeenCalledWith({ conversationKey: "lark:lark-1:oc_1" })
  })

  it("renders one checkbox per schema kind and toggles the kinds array (empty → undefined)", () => {
    const onChange = jest.fn()
    const { getByTestId, rerender } = render(
      <ConnectorSystemTriggerConfig params={{}} onChange={onChange} />
    )
    for (const kind of CONNECTOR_SYSTEM_EVENT_KINDS) {
      expect(getByTestId(`cs-kind-${kind}`)).toBeInTheDocument()
    }
    fireEvent.click(getByTestId("cs-kind-reaction_added"))
    expect(onChange).toHaveBeenLastCalledWith({ kinds: ["reaction_added"] })

    rerender(
      <ConnectorSystemTriggerConfig params={{ kinds: ["reaction_added"] }} onChange={onChange} />
    )
    fireEvent.click(getByTestId("cs-kind-poke"))
    expect(onChange).toHaveBeenLastCalledWith({ kinds: ["reaction_added", "poke"] })

    rerender(<ConnectorSystemTriggerConfig params={{ kinds: ["poke"] }} onChange={onChange} />)
    fireEvent.click(getByTestId("cs-kind-poke"))
    expect(onChange).toHaveBeenLastCalledWith({ kinds: undefined })
  })

  it("toggles targetSelfOnly and clears it back to undefined", () => {
    const onChange = jest.fn()
    const { getByTestId, rerender } = render(
      <ConnectorSystemTriggerConfig params={{}} onChange={onChange} />
    )
    fireEvent.click(getByTestId("cs-target-self-only"))
    expect(onChange).toHaveBeenLastCalledWith({ targetSelfOnly: true })
    rerender(<ConnectorSystemTriggerConfig params={{ targetSelfOnly: true }} onChange={onChange} />)
    fireEvent.click(getByTestId("cs-target-self-only"))
    expect(onChange).toHaveBeenLastCalledWith({ targetSelfOnly: undefined })
  })

  it("reflects preselected kinds as checked", () => {
    const { container } = render(
      <ConnectorSystemTriggerConfig
        params={{ kinds: ["lifecycle", "request"] }}
        onChange={jest.fn()}
      />
    )
    const kindsField = container.querySelector('[data-field="kinds"]') as HTMLElement
    const checked = within(kindsField)
      .getAllByRole("checkbox")
      .filter(
        (el) =>
          el.getAttribute("data-state") === "checked" || el.getAttribute("aria-checked") === "true"
      )
    expect(checked).toHaveLength(2)
  })
})
