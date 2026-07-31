/**
 * @jest-environment jsdom
 */
import React from "react"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { RendererErrorBoundary, withRendererErrorBoundary } from "./renderer-error-boundary"

// React logs caught render errors to console.error; silence it so the test
// output stays readable. Restored after each test.
let consoleErrorSpy: jest.SpyInstance
beforeEach(() => {
  consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {})
})
afterEach(() => {
  consoleErrorSpy.mockRestore()
})

function Boom(): React.JSX.Element {
  throw new Error("kaboom")
}

describe("RendererErrorBoundary", () => {
  it("renders children when nothing throws", () => {
    render(
      <RendererErrorBoundary>
        <span data-testid="ok">healthy</span>
      </RendererErrorBoundary>
    )
    expect(screen.getByTestId("ok")).toHaveTextContent("healthy")
  })

  it("catches a throwing child and shows the named fallback + the error message", () => {
    render(
      <RendererErrorBoundary rendererName="Mermaid">
        <Boom />
      </RendererErrorBoundary>
    )
    expect(screen.getByRole("alert")).toHaveTextContent("Mermaid Render Error")
    expect(screen.getByText("kaboom")).toBeInTheDocument()
  })

  it("falls back to the generic title when no rendererName is given", () => {
    render(
      <RendererErrorBoundary>
        <Boom />
      </RendererErrorBoundary>
    )
    expect(screen.getByRole("alert")).toHaveTextContent("Render Error")
  })

  it("renders a custom fallback node when provided", () => {
    render(
      <RendererErrorBoundary fallback={<div data-testid="custom-fallback" />}>
        <Boom />
      </RendererErrorBoundary>
    )
    expect(screen.getByTestId("custom-fallback")).toBeInTheDocument()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("invokes onError with the caught error", () => {
    const onError = jest.fn()
    render(
      <RendererErrorBoundary onError={onError}>
        <Boom />
      </RendererErrorBoundary>
    )
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error)
  })

  it("retry clears the error so a now-healthy subtree renders", async () => {
    const user = userEvent.setup()
    let shouldThrow = true
    function Toggle(): React.JSX.Element {
      if (shouldThrow) throw new Error("kaboom")
      return <span data-testid="recovered">recovered</span>
    }
    render(
      <RendererErrorBoundary>
        <Toggle />
      </RendererErrorBoundary>
    )
    expect(screen.getByRole("alert")).toBeInTheDocument()
    shouldThrow = false
    await user.click(screen.getByRole("button", { name: "Retry" }))
    expect(screen.getByTestId("recovered")).toBeInTheDocument()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })
})

describe("withRendererErrorBoundary", () => {
  it("wraps a component and catches its render errors", () => {
    const Wrapped = withRendererErrorBoundary(Boom, "Diff")
    render(<Wrapped />)
    expect(screen.getByRole("alert")).toHaveTextContent("Diff Render Error")
  })

  it("renders the wrapped component normally when it does not throw", () => {
    const Healthy = ({ label }: { label: string }) => <span data-testid="wrapped">{label}</span>
    const Wrapped = withRendererErrorBoundary(Healthy)
    render(<Wrapped label="hi" />)
    expect(screen.getByTestId("wrapped")).toHaveTextContent("hi")
  })

  it("sets a descriptive displayName", () => {
    const Named = () => <span />
    Named.displayName = "MyRenderer"
    const Wrapped = withRendererErrorBoundary(Named)
    expect(Wrapped.displayName).toBe("withRendererErrorBoundary(MyRenderer)")
  })
})
