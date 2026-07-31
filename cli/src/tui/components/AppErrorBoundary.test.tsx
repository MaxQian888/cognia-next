import React from "react"
import { act, render } from "@testing-library/react"
import { __fireInput, __resetInk } from "ink"

import { AppErrorBoundary } from "./AppErrorBoundary"

function Boom(): React.ReactElement {
  throw new Error("kaboom in render")
}

describe("AppErrorBoundary", () => {
  let errSpy: jest.SpyInstance
  beforeEach(() => {
    __resetInk()
    // React logs caught render errors to console.error — silence the noise.
    errSpy = jest.spyOn(console, "error").mockImplementation(() => undefined)
  })
  afterEach(() => errSpy.mockRestore())

  it("renders children when nothing throws", () => {
    const { container } = render(
      <AppErrorBoundary>
        <>ok content</>
      </AppErrorBoundary>
    )
    expect(container.textContent).toContain("ok content")
  })

  it("catches a render throw, logs it, and shows the fallback", () => {
    const onCrash = jest.fn()
    const { container } = render(
      <AppErrorBoundary onCrash={onCrash}>
        <Boom />
      </AppErrorBoundary>
    )
    expect(container.textContent).toContain("Something went wrong")
    expect(container.textContent).toContain("kaboom in render")
    expect(onCrash).toHaveBeenCalledTimes(1)
    expect(onCrash.mock.calls[0][0]).toBeInstanceOf(Error)
    expect(onCrash.mock.calls[0][0].message).toBe("kaboom in render")
  })

  it("pressing r invokes the injected onReset", () => {
    const onReset = jest.fn()
    render(
      <AppErrorBoundary onReset={onReset}>
        <Boom />
      </AppErrorBoundary>
    )
    act(() => __fireInput("r"))
    expect(onReset).toHaveBeenCalledTimes(1)
  })

  it("q and Esc route to the exit path without throwing", () => {
    render(
      <AppErrorBoundary>
        <Boom />
      </AppErrorBoundary>
    )
    // Exercises the exit branch of the fallback's key handler (exit is the ink
    // mock's no-op useApp().exit); it must not throw.
    expect(() => {
      act(() => __fireInput("x")) // an unrelated key → no-op branch
      act(() => __fireInput("q"))
      act(() => __fireInput("", { escape: true }))
    }).not.toThrow()
  })

  it("renders a fallback even when the error has no stack", () => {
    function NoStack(): React.ReactElement {
      const e = new Error("stackless")
      e.stack = undefined
      throw e
    }
    const { container } = render(
      <AppErrorBoundary>
        <NoStack />
      </AppErrorBoundary>
    )
    expect(container.textContent).toContain("stackless")
  })

  it("the default reset remounts children from a clean slate (recovers)", () => {
    let shouldThrow = true
    function MaybeBoom(): React.ReactElement {
      if (shouldThrow) throw new Error("first-mount only")
      return <>recovered</>
    }
    const { container } = render(
      <AppErrorBoundary>
        <MaybeBoom />
      </AppErrorBoundary>
    )
    expect(container.textContent).toContain("Something went wrong")
    // The transient condition clears, then reset remounts the subtree fresh.
    shouldThrow = false
    act(() => __fireInput("r"))
    expect(container.textContent).toContain("recovered")
  })
})
