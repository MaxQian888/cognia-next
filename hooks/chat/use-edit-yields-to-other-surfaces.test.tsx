import { useRef, useState } from "react"
import { fireEvent, render, screen } from "@testing-library/react"

import { useEditYieldsToOtherSurfaces } from "./use-edit-yields-to-other-surfaces"

function EditBox({ id, onYield }: { id: string; onYield: (id: string) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(true)
  useEditYieldsToOtherSurfaces(open, ref, () => {
    setOpen(false)
    onYield(id)
  })
  return open ? (
    <div ref={ref} data-message-edit="" data-testid={`edit-${id}`}>
      <textarea aria-label={`draft-${id}`} />
      <button type="button">send-{id}</button>
    </div>
  ) : (
    <button type="button" data-testid={`closed-${id}`}>
      closed-{id}
    </button>
  )
}

function Harness({ onYield }: { onYield: (id: string) => void }) {
  return (
    <>
      <EditBox id="a" onYield={onYield} />
      <p data-testid="prose">message text</p>
      <div data-composer-skin="classic" data-testid="composer">
        <textarea aria-label="composer" />
        <button type="button">attach</button>
      </div>
    </>
  )
}

describe("useEditYieldsToOtherSurfaces", () => {
  it("stays open while the user works inside its own box", () => {
    const onYield = jest.fn()
    render(<Harness onYield={onYield} />)
    fireEvent.focusIn(screen.getByLabelText("draft-a"))
    fireEvent.pointerDown(screen.getByRole("button", { name: "send-a" }))
    expect(onYield).not.toHaveBeenCalled()
    expect(screen.getByTestId("edit-a")).toBeInTheDocument()
  })

  it("ignores taps on anything that is not a text-entry surface", () => {
    const onYield = jest.fn()
    render(<Harness onYield={onYield} />)
    fireEvent.pointerDown(screen.getByTestId("prose"))
    expect(onYield).not.toHaveBeenCalled()
  })

  it("yields when the composer textarea takes focus", () => {
    const onYield = jest.fn()
    render(<Harness onYield={onYield} />)
    fireEvent.focusIn(screen.getByLabelText("composer"))
    expect(onYield).toHaveBeenCalledWith("a")
    expect(screen.queryByTestId("edit-a")).toBeNull()
  })

  it("yields on a tap on a composer button that does not take focus (touch WebKit)", () => {
    const onYield = jest.fn()
    render(<Harness onYield={onYield} />)
    fireEvent.pointerDown(screen.getByRole("button", { name: "attach" }))
    expect(onYield).toHaveBeenCalledTimes(1)
  })

  it("yields to another message's edit box", () => {
    const onYield = jest.fn()
    render(
      <>
        <EditBox id="a" onYield={onYield} />
        <EditBox id="b" onYield={onYield} />
      </>
    )
    fireEvent.focusIn(screen.getByLabelText("draft-b"))
    expect(onYield).toHaveBeenCalledWith("a")
    expect(onYield).not.toHaveBeenCalledWith("b")
    expect(screen.getByTestId("edit-b")).toBeInTheDocument()
  })

  it("stops listening once the edit is closed", () => {
    const onYield = jest.fn()
    render(<Harness onYield={onYield} />)
    fireEvent.focusIn(screen.getByLabelText("composer"))
    fireEvent.focusIn(screen.getByLabelText("composer"))
    expect(onYield).toHaveBeenCalledTimes(1)
  })
})
