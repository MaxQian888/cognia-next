/**
 * @jest-environment jsdom
 */

import { useState } from "react"
import { render, screen, fireEvent, act } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { DeferredTextInput } from "./deferred-text-input"

function Harness(props: { initial: string; onCommit?: (v: string) => void }) {
  const [value, setValue] = useState(props.initial)
  return (
    <>
      <DeferredTextInput
        value={value}
        onCommit={(next) => {
          setValue(next)
          props.onCommit?.(next)
        }}
        aria-label="font stack"
        data-testid="input"
      />
      <button type="button">blur target</button>
    </>
  )
}

function field(): HTMLInputElement {
  return screen.getByTestId("input") as HTMLInputElement
}

describe("DeferredTextInput", () => {
  it("does not commit while typing", async () => {
    const onCommit = jest.fn()
    const user = userEvent.setup()
    render(<Harness initial="" onCommit={onCommit} />)

    await user.click(field())
    await user.type(field(), '"Fira Code", monospace')

    expect(field().value).toBe('"Fira Code", monospace')
    expect(onCommit).not.toHaveBeenCalled()
  })

  it("commits once on blur", async () => {
    const onCommit = jest.fn()
    const user = userEvent.setup()
    render(<Harness initial="" onCommit={onCommit} />)

    await user.click(field())
    await user.type(field(), '"Fira Code", monospace')
    await user.tab()

    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledWith('"Fira Code", monospace')
  })

  it("commits on Enter", async () => {
    const onCommit = jest.fn()
    render(<Harness initial="" onCommit={onCommit} />)

    await act(async () => {
      fireEvent.change(field(), { target: { value: "Menlo" } })
      fireEvent.keyDown(field(), { key: "Enter" })
    })

    expect(onCommit).toHaveBeenCalledWith("Menlo")
  })

  it("trims surrounding whitespace on commit", async () => {
    const onCommit = jest.fn()
    render(<Harness initial="" onCommit={onCommit} />)

    await act(async () => {
      fireEvent.change(field(), { target: { value: "  Menlo  " } })
      fireEvent.blur(field())
    })

    expect(onCommit).toHaveBeenCalledWith("Menlo")
    expect(field().value).toBe("Menlo")
  })

  it("does not commit when the draft matches the stored value", async () => {
    const onCommit = jest.fn()
    render(<Harness initial="Menlo" onCommit={onCommit} />)

    await act(async () => {
      fireEvent.blur(field())
    })

    expect(onCommit).not.toHaveBeenCalled()
  })

  it("restores the committed value on Escape", async () => {
    const onCommit = jest.fn()
    render(<Harness initial="Menlo" onCommit={onCommit} />)

    await act(async () => {
      fireEvent.change(field(), { target: { value: "half-typed" } })
      fireEvent.keyDown(field(), { key: "Escape" })
    })

    expect(field().value).toBe("Menlo")
    expect(onCommit).not.toHaveBeenCalled()
  })

  it("re-seeds the draft when the value changes externally", async () => {
    function ExternalHarness() {
      const [value, setValue] = useState("Menlo")
      return (
        <>
          <DeferredTextInput value={value} onCommit={setValue} data-testid="input" />
          <button type="button" onClick={() => setValue("Cascadia Code")}>
            preset
          </button>
        </>
      )
    }
    render(<ExternalHarness />)

    await act(async () => {
      fireEvent.change(field(), { target: { value: "typing…" } })
    })
    expect(field().value).toBe("typing…")

    // A preset button writing the setting must win over the stale draft.
    await act(async () => {
      fireEvent.click(screen.getByText("preset"))
    })
    expect(field().value).toBe("Cascadia Code")
  })

  it("forwards blur and keydown handlers supplied by the caller", async () => {
    const onBlur = jest.fn()
    const onKeyDown = jest.fn()
    render(
      <DeferredTextInput
        value="Menlo"
        onCommit={jest.fn()}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
        data-testid="input"
      />
    )

    await act(async () => {
      fireEvent.keyDown(field(), { key: "a" })
      fireEvent.blur(field())
    })

    expect(onKeyDown).toHaveBeenCalled()
    expect(onBlur).toHaveBeenCalled()
  })
})
