/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { isUsdAmount, RouterFusionUsdField } from "./router-fusion-usd-field"

describe("RouterFusionUsdField", () => {
  it("accepts dollar amounts the ledger can convert and nothing else", () => {
    expect(isUsdAmount("1.25")).toBe(true)
    expect(isUsdAmount(" 0.000001 ")).toBe(true)
    expect(isUsdAmount("0.1234567")).toBe(false)
    expect(isUsdAmount("-1")).toBe(false)
    expect(isUsdAmount("abc")).toBe(false)
  })

  it("saves a changed valid amount on blur and refuses a malformed one", async () => {
    const user = userEvent.setup()
    const onCommit = jest.fn()
    render(
      <RouterFusionUsdField
        id="cap"
        label="Cap"
        description="The cap."
        value="1.00"
        onCommit={onCommit}
      />
    )
    const input = screen.getByLabelText("Cap")
    await user.clear(input)
    await user.type(input, "1.2345678")
    expect(input).toHaveAttribute("aria-invalid", "true")
    expect(
      screen.getByText("Enter a dollar amount with at most six decimal places.")
    ).toBeInTheDocument()
    await user.tab()
    expect(onCommit).not.toHaveBeenCalled()
    await user.clear(input)
    await user.tab()
    expect(onCommit).not.toHaveBeenCalled()
    await user.type(input, "2.5")
    await user.tab()
    expect(onCommit).toHaveBeenCalledWith("2.5")
    expect(screen.getByText("The cap.")).toBeInTheDocument()
  })

  it("does not save an unchanged amount", async () => {
    const user = userEvent.setup()
    const onCommit = jest.fn()
    render(
      <RouterFusionUsdField id="cap" label="Cap" description="d" value="1.00" onCommit={onCommit} />
    )
    const input = screen.getByLabelText("Cap")
    await user.clear(input)
    await user.type(input, " 1.00 ")
    await user.tab()
    expect(onCommit).not.toHaveBeenCalled()
  })

  it("lets an optional amount be emptied, showing what applies instead", async () => {
    const user = userEvent.setup()
    const onCommit = jest.fn()
    render(
      <RouterFusionUsdField
        id="cap"
        label="Cap"
        description="d"
        value="3.00"
        placeholder="2.00"
        allowBlank
        onCommit={onCommit}
      />
    )
    const input = screen.getByLabelText("Cap")
    await user.clear(input)
    expect(input).toHaveAttribute("aria-invalid", "false")
    expect(input).toHaveAttribute("placeholder", "2.00")
    await user.tab()
    expect(onCommit).toHaveBeenCalledWith("")
  })
})
