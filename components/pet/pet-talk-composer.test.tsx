import { render, screen, fireEvent, waitFor } from "@testing-library/react"

import { PetTalkComposer } from "./pet-talk-composer"

function setup(props: Partial<React.ComponentProps<typeof PetTalkComposer>> = {}) {
  const onTalk = jest.fn()
  render(<PetTalkComposer onTalk={onTalk} {...props} />)
  const input = screen.getByPlaceholderText("Say something to your pet…")
  return { onTalk, input }
}

beforeEach(() => window.localStorage.clear())

describe("PetTalkComposer", () => {
  it("submits trimmed text on Enter and clears the input", async () => {
    const { onTalk, input } = setup()
    fireEvent.change(input, { target: { value: "  hi Boba  " } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(onTalk).toHaveBeenCalledWith("hi Boba"))
    await waitFor(() => expect(input).toHaveValue(""))
  })

  it("does not submit mid-IME-composition Enter", () => {
    const { onTalk, input } = setup()
    fireEvent.change(input, { target: { value: "ni hao" } })
    fireEvent.keyDown(input, { key: "Enter", isComposing: true })
    expect(onTalk).not.toHaveBeenCalled()
    expect(input).toHaveValue("ni hao")
  })

  it("submits bare talk (no text) as undefined via the send button", async () => {
    const { onTalk } = setup()
    fireEvent.click(screen.getByLabelText("Send"))
    await waitFor(() => expect(onTalk).toHaveBeenCalledWith(undefined))
  })

  it("recalls a previously said phrase with ArrowUp", async () => {
    const { onTalk, input } = setup()
    fireEvent.change(input, { target: { value: "good boy" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(onTalk).toHaveBeenCalledWith("good boy"))
    await waitFor(() => expect(input).toHaveValue(""))
    fireEvent.keyDown(input, { key: "ArrowUp" })
    expect(input).toHaveValue("good boy")
  })

  it("focuses the input on mount", () => {
    const { input } = setup()
    expect(input).toHaveFocus()
  })

  it("requires text in chat mode and reflects the in-flight status", () => {
    const { onTalk } = setup({ mode: "chat", status: "submitted", allowEmpty: false })
    const submit = screen.getByLabelText("Send")
    expect(submit).toBeDisabled()
    fireEvent.click(submit)
    expect(onTalk).not.toHaveBeenCalled()
  })
})
