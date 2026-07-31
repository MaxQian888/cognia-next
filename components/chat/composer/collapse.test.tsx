/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import { Collapse } from "./collapse"

describe("Collapse", () => {
  const RealResizeObserver = global.ResizeObserver

  afterEach(() => {
    global.ResizeObserver = RealResizeObserver
  })

  it("renders its children", () => {
    render(
      <Collapse>
        <span>hello content</span>
      </Collapse>
    )
    expect(screen.getByText("hello content")).toBeInTheDocument()
  })

  it("renders nothing visible for a self-hiding (null) child without throwing", () => {
    const { container } = render(<Collapse>{null}</Collapse>)
    // The wrapper stays mounted (so it can animate open later) but has no
    // measurable content.
    expect(container.textContent).toBe("")
  })

  it("observes its content with a ResizeObserver and disconnects on unmount", () => {
    const observe = jest.fn()
    const disconnect = jest.fn()
    global.ResizeObserver = class {
      observe = observe
      disconnect = disconnect
      unobserve = jest.fn()
    } as unknown as typeof ResizeObserver

    const { unmount } = render(
      <Collapse>
        <span>watched</span>
      </Collapse>
    )
    expect(observe).toHaveBeenCalledTimes(1)
    unmount()
    expect(disconnect).toHaveBeenCalledTimes(1)
  })

  it("degrades gracefully when ResizeObserver is unavailable", () => {
    // @ts-expect-error — simulate an environment without ResizeObserver
    delete global.ResizeObserver
    expect(() =>
      render(
        <Collapse>
          <span>no observer</span>
        </Collapse>
      )
    ).not.toThrow()
    expect(screen.getByText("no observer")).toBeInTheDocument()
  })

  it("passes a className through to the animated wrapper", () => {
    const { container } = render(
      <Collapse className="my-wrapper">
        <span>x</span>
      </Collapse>
    )
    expect(container.querySelector(".my-wrapper")).not.toBeNull()
  })
})
