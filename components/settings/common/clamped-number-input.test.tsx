/**
 * @jest-environment jsdom
 */

import { useState } from "react"
import { render, screen, fireEvent, act } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { ClampedNumberInput, clampNumber } from "./clamped-number-input"

/**
 * Store-backed harness: the committed value feeds back into `value`, which is
 * what makes the input controlled. A test that renders `ClampedNumberInput`
 * with a frozen `value` would not exercise the bug this component exists for.
 */
function Harness(props: {
  initial: number
  min: number
  max: number
  integer?: boolean
  onCommit?: (n: number) => void
}) {
  const [value, setValue] = useState(props.initial)
  return (
    <>
      <ClampedNumberInput
        value={value}
        min={props.min}
        max={props.max}
        integer={props.integer}
        onCommit={(next) => {
          setValue(next)
          props.onCommit?.(next)
        }}
        aria-label="size"
        data-testid="input"
      />
      <button type="button">blur target</button>
    </>
  )
}

function field(): HTMLInputElement {
  return screen.getByTestId("input") as HTMLInputElement
}

describe("clampNumber", () => {
  it("bounds to the range", () => {
    expect(clampNumber(200, 8, 32, true)).toBe(32)
    expect(clampNumber(-5, 8, 32, true)).toBe(8)
    expect(clampNumber(15, 8, 32, true)).toBe(15)
  })

  it("rounds only when integer is requested", () => {
    expect(clampNumber(1.4, 0.8, 2, false)).toBe(1.4)
    expect(clampNumber(1.4, 1, 10, true)).toBe(1)
  })
})

describe("ClampedNumberInput", () => {
  it("lets a multi-digit value be typed through an out-of-range prefix", async () => {
    const onCommit = jest.fn()
    const user = userEvent.setup()
    render(<Harness initial={13} min={8} max={32} integer onCommit={onCommit} />)

    await user.clear(field())
    await user.type(field(), "20")

    expect(field().value).toBe("20")
    expect(onCommit).toHaveBeenLastCalledWith(20)
    // "2" is below the floor — it must not have been committed as 8.
    expect(onCommit.mock.calls.flat()).not.toContain(8)
  })

  it("commits an in-range draft while typing (live preview)", async () => {
    const onCommit = jest.fn()
    const user = userEvent.setup()
    render(<Harness initial={13} min={8} max={32} integer onCommit={onCommit} />)

    await user.clear(field())
    await user.type(field(), "9")

    expect(onCommit).toHaveBeenCalledWith(9)
  })

  it("clamps an out-of-range draft on blur", async () => {
    const onCommit = jest.fn()
    render(<Harness initial={13} min={8} max={32} integer onCommit={onCommit} />)

    await act(async () => {
      fireEvent.change(field(), { target: { value: "500" } })
      fireEvent.blur(field())
    })

    expect(onCommit).toHaveBeenLastCalledWith(32)
    expect(field().value).toBe("32")
  })

  it("clamps and commits on Enter without losing the value", async () => {
    const onCommit = jest.fn()
    render(<Harness initial={13} min={8} max={32} integer onCommit={onCommit} />)

    await act(async () => {
      fireEvent.change(field(), { target: { value: "1" } })
      fireEvent.keyDown(field(), { key: "Enter" })
    })

    expect(onCommit).toHaveBeenLastCalledWith(8)
  })

  it("reverts to the committed value when blurred empty", async () => {
    const onCommit = jest.fn()
    render(<Harness initial={13} min={8} max={32} integer onCommit={onCommit} />)

    await act(async () => {
      fireEvent.change(field(), { target: { value: "" } })
      fireEvent.blur(field())
    })

    expect(onCommit).not.toHaveBeenCalled()
    expect(field().value).toBe("13")
  })

  it("abandons the draft on Escape", async () => {
    const onCommit = jest.fn()
    render(<Harness initial={13} min={8} max={32} integer onCommit={onCommit} />)

    await act(async () => {
      fireEvent.change(field(), { target: { value: "999" } })
      fireEvent.keyDown(field(), { key: "Escape" })
    })

    expect(field().value).toBe("13")
    expect(onCommit).not.toHaveBeenCalled()
  })

  it("keeps fractional drafts intact while typing a decimal", async () => {
    const onCommit = jest.fn()
    const user = userEvent.setup()
    render(<Harness initial={1} min={0.8} max={2} onCommit={onCommit} />)

    await user.clear(field())
    await user.type(field(), "1.25")

    expect(field().value).toBe("1.25")
    expect(onCommit).toHaveBeenLastCalledWith(1.25)
  })

  it("rounds on commit when integer is set", async () => {
    const onCommit = jest.fn()
    render(<Harness initial={2} min={1} max={10} integer onCommit={onCommit} />)

    await act(async () => {
      fireEvent.change(field(), { target: { value: "3.6" } })
      fireEvent.blur(field())
    })

    expect(onCommit).toHaveBeenLastCalledWith(4)
  })

  it("re-seeds the draft when the value changes externally", async () => {
    function ExternalHarness() {
      const [value, setValue] = useState(13)
      return (
        <>
          <ClampedNumberInput
            value={value}
            min={8}
            max={32}
            integer
            onCommit={setValue}
            data-testid="input"
          />
          <button type="button" onClick={() => setValue(24)}>
            reset
          </button>
        </>
      )
    }
    render(<ExternalHarness />)

    await act(async () => {
      fireEvent.change(field(), { target: { value: "3" } })
    })
    expect(field().value).toBe("3")

    await act(async () => {
      fireEvent.click(screen.getByText("reset"))
    })
    expect(field().value).toBe("24")
  })

  it("forwards blur and keydown handlers supplied by the caller", async () => {
    const onBlur = jest.fn()
    const onKeyDown = jest.fn()
    render(
      <ClampedNumberInput
        value={10}
        min={1}
        max={20}
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
