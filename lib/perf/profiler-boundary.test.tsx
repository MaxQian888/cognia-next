import { render } from "@testing-library/react"
import { PerfBoundary } from "./profiler-boundary"

// The production branch (`process.env.NODE_ENV === "production"` returns
// children directly) is intentionally hard-coded so Next.js / SWC eliminates
// it at compile time. There is no runtime to assert on in tests — verifying
// compile-time elimination requires a build inspection, not a unit test.
//
// We exercise: (a) children render through the boundary, (b) the boundary
// survives a rerender. The performance-measure side effect is observable in
// integration / manual runs; jsdom's perf timeline is unstable enough that
// asserting on getEntriesByName here is more brittle than informative.

describe("PerfBoundary", () => {
  it("renders children verbatim", () => {
    const { getByTestId } = render(
      <PerfBoundary id="test:boundary">
        <span data-testid="child">hello</span>
      </PerfBoundary>
    )
    expect(getByTestId("child").textContent).toBe("hello")
  })

  it("survives a rerender with a new child", () => {
    const { rerender, getByTestId } = render(
      <PerfBoundary id="re-commit">
        <span data-testid="phase-1">phase-1</span>
      </PerfBoundary>
    )
    expect(getByTestId("phase-1")).toBeInTheDocument()
    rerender(
      <PerfBoundary id="re-commit">
        <span data-testid="phase-2">phase-2</span>
      </PerfBoundary>
    )
    expect(getByTestId("phase-2")).toBeInTheDocument()
  })

  it("nests cleanly with another boundary on the same id", () => {
    const { getAllByTestId } = render(
      <PerfBoundary id="outer">
        <PerfBoundary id="inner">
          <span data-testid="leaf">leaf</span>
        </PerfBoundary>
      </PerfBoundary>
    )
    expect(getAllByTestId("leaf")).toHaveLength(1)
  })
})
