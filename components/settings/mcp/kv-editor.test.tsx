/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { fireEvent, render, screen } from "@testing-library/react"
import { KvEditor } from "./kv-editor"
import type { KvRow } from "./mcp-server-utils"

function setup(rows: KvRow[]) {
  const onChange = jest.fn()
  render(
    <KvEditor label="Env" rows={rows} onChange={onChange} keyPlaceholder="K" valuePlaceholder="V" />
  )
  return onChange
}

describe("KvEditor", () => {
  it("shows the empty state with no rows", () => {
    setup([])
    expect(screen.getByText("kvEmpty")).toBeInTheDocument()
  })

  it("adds a row", () => {
    const onChange = setup([])
    fireEvent.click(screen.getByText("kvAdd"))
    expect(onChange).toHaveBeenCalledWith([{ key: "", value: "" }])
  })

  it("updates a row key and value", () => {
    const onChange = setup([{ key: "A", value: "1" }])
    const inputs = screen.getAllByDisplayValue(/A|1/)
    fireEvent.change(inputs[0], { target: { value: "B" } })
    expect(onChange).toHaveBeenCalledWith([{ key: "B", value: "1" }])
    fireEvent.change(inputs[1], { target: { value: "2" } })
    expect(onChange).toHaveBeenCalledWith([{ key: "A", value: "2" }])
  })

  it("removes a row", () => {
    const onChange = setup([{ key: "A", value: "1" }])
    fireEvent.click(screen.getByLabelText("kvRemove"))
    expect(onChange).toHaveBeenCalledWith([])
  })
})
