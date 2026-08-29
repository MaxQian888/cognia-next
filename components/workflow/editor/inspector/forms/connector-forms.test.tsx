/**
 * @jest-environment jsdom
 */
import { fireEvent, render } from "@testing-library/react"

// The adapter picker reads Dexie; stub it to a plain input.
jest.mock("./shared/entity-picker", () => ({
  ...jest.requireActual("./shared/entity-picker"),
  AdapterInstancePicker: ({
    value,
    onChange,
    id,
  }: {
    value?: string
    onChange?: (v: string) => void
    id?: string
  }) => <input id={id} value={value ?? ""} onChange={(e) => onChange?.(e.target.value)} />,
}))

import {
  ConnectorSendConfig,
  ConnectorReactionConfig,
  ConnectorDeleteConfig,
  ConnectorForwardConfig,
  ConnectorWaitReplyConfig,
  ConnectorDraftConfig,
} from "./connector-forms"

describe("connector-forms export surface", () => {
  it("exports its workflow inspector forms", () => {
    expect(
      [
        ConnectorSendConfig,
        ConnectorReactionConfig,
        ConnectorDeleteConfig,
        ConnectorForwardConfig,
        ConnectorWaitReplyConfig,
        ConnectorDraftConfig,
      ].every((form) => typeof form === "function")
    ).toBe(true)
  })
})

/**
 * `action.connector.forward` accepts EITHER `messageId` or `messageIds` (the
 * merge-forward list) and fails closed when both are empty. The form offered
 * only the singular field and marked it required, which both hid merge
 * forwarding and misstated the contract.
 */
describe("ConnectorForwardConfig — merge forwarding", () => {
  it("edits the id list and drops it when emptied", () => {
    const onChange = jest.fn()
    const { container } = render(<ConnectorForwardConfig params={{}} onChange={onChange} />)
    const box = container.querySelector('[data-field="messageIds"] input')!
    fireEvent.change(box, { target: { value: "a, b ," } })
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ messageIds: ["a", "b"] }))

    fireEvent.change(box, { target: { value: " " } })
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ messageIds: undefined }))
  })

  it("stops requiring the single id once a merge list is present", () => {
    const { container } = render(
      <ConnectorForwardConfig params={{ messageIds: ["a", "b"] }} onChange={jest.fn()} />
    )
    const field = container.querySelector('[data-field="messageId"]')!
    expect(field.querySelector("input")).toBeDisabled()
    expect(field.textContent).not.toContain("*")
  })

  it("still requires the single id when no list is set", () => {
    const { container } = render(<ConnectorForwardConfig params={{}} onChange={jest.fn()} />)
    const field = container.querySelector('[data-field="messageId"]')!
    expect(field.querySelector("input")).not.toBeDisabled()
    expect(field.textContent).toContain("*")
  })
})
