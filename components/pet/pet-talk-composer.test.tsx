import { render, screen, fireEvent } from "@testing-library/react"

import { PetTalkComposer } from "./pet-talk-composer"

function setup() {
  const onTalk = jest.fn()
  render(<PetTalkComposer onTalk={onTalk} />)
  const input = screen.getByPlaceholderText("Say something to your pet…")
  return { onTalk, input }
}

beforeEach(() => window.localStorage.clear())

describe("PetTalkComposer", () => {
  it("submits trimmed text on Enter and clears the input", () => {
    const { onTalk, input } = setup()
    fireEvent.change(input, { target: { value: "  hi Boba  " } })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(onTalk).toHaveBeenCalledWith("hi Boba")
    expect(input).toHaveValue("")
  })

  it("does not submit mid-IME-composition Enter", () => {
    const { onTalk, input } = setup()
    fireEvent.change(input, { target: { value: "ni hao" } })
    fireEvent.keyDown(input, { key: "Enter", isComposing: true })
    expect(onTalk).not.toHaveBeenCalled()
    expect(input).toHaveValue("ni hao")
  })

  it("submits bare talk (no text) as undefined via the send button", () => {
    const { onTalk } = setup()
    fireEvent.click(screen.getByLabelText("Send"))
    expect(onTalk).toHaveBeenCalledWith(undefined)
  })

  it("recalls a previously said phrase with ArrowUp", () => {
    const { onTalk, input } = setup()
    fireEvent.change(input, { target: { value: "good boy" } })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(onTalk).toHaveBeenCalledWith("good boy")
    expect(input).toHaveValue("")
    fireEvent.keyDown(input, { key: "ArrowUp" })
    expect(input).toHaveValue("good boy")
  })

  it("focuses the input on mount", () => {
    const { input } = setup()
    expect(input).toHaveFocus()
  })
})
