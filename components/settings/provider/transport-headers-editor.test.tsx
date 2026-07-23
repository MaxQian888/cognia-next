import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { TransportHeadersEditor } from "./transport-headers-editor"

describe("TransportHeadersEditor", () => {
  it("renders existing headers and adds new rows", () => {
    const onChange = jest.fn()
    render(
      <TransportHeadersEditor value={{ "anthropic-beta": "computer-use" }} onChange={onChange} />
    )

    expect(screen.getByDisplayValue("anthropic-beta")).toBeInTheDocument()
    expect(screen.getByDisplayValue("computer-use")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "transportHeadersAdd" }))
    expect(screen.getAllByRole("textbox")).toHaveLength(4)
  })

  it("emits only valid headers and surfaces a reason-coded error for blocked names", () => {
    const onChange = jest.fn()
    render(<TransportHeadersEditor value={undefined} onChange={onChange} />)

    fireEvent.click(screen.getByRole("button", { name: "transportHeadersAdd" }))
    const [nameInput, valueInput] = screen.getAllByRole("textbox")

    fireEvent.change(nameInput, { target: { value: "authorization" } })
    fireEvent.change(valueInput, { target: { value: "Bearer sk" } })

    expect(screen.getByRole("alert")).toHaveTextContent("transportHeadersReason_authHeader")
    // The blocked header never reaches the persisted value.
    expect(onChange).toHaveBeenLastCalledWith(undefined)

    fireEvent.change(nameInput, { target: { value: "x-tenant" } })
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(onChange).toHaveBeenLastCalledWith({ "x-tenant": "Bearer sk" })
  })

  it("flags internal x-cognia-* names and value injection attempts", () => {
    const onChange = jest.fn()
    render(<TransportHeadersEditor value={{ "x-cognia-run": "1" }} onChange={onChange} />)
    expect(screen.getByRole("alert")).toHaveTextContent("transportHeadersReason_internalHeader")

    // Browsers strip CR/LF from <input> values, so the injection probe uses
    // a NUL byte (same invalid-value class, survives the DOM round-trip).
    const [nameInput, valueInput] = screen.getAllByRole("textbox")
    fireEvent.change(nameInput, { target: { value: "x-ok" } })
    fireEvent.change(valueInput, { target: { value: "nul\u0000byte" } })
    expect(screen.getByRole("alert")).toHaveTextContent("transportHeadersReason_invalidValue")
  })

  it("removes rows and collapses to undefined when empty", () => {
    const onChange = jest.fn()
    render(<TransportHeadersEditor value={{ "x-tenant": "t1" }} onChange={onChange} />)

    fireEvent.click(screen.getByRole("button", { name: "transportHeadersRemove" }))
    expect(onChange).toHaveBeenLastCalledWith(undefined)
    expect(screen.queryAllByRole("textbox")).toHaveLength(0)
  })
})
