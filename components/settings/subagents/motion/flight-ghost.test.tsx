/**
 * @jest-environment jsdom
 */

import { useState } from "react"
import { act, render, screen } from "@testing-library/react"

import { FLIGHT_TARGET_ATTR, SubagentFlightGhost } from "./flight-ghost"

let flowMotion = { reduce: false, speed: 1 }
jest.mock("@/components/chat/motion/motion-reveal", () => ({
  useFlowMotion: () => flowMotion,
}))

/** jsdom returns an all-zero rect; give the two anchors real geometry. */
function stubRects(map: Record<string, DOMRect | undefined>) {
  jest.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
    this: Element
  ) {
    const source = this.getAttribute("data-flight-source")
    const key = source ?? (this.hasAttribute(FLIGHT_TARGET_ATTR) ? "__target__" : "__other__")
    return (map[key] ?? { top: 0, left: 0, width: 0, height: 0 }) as DOMRect
  })
}

const rect = (top: number, left: number): DOMRect =>
  ({ top, left, width: 20, height: 20 }) as DOMRect

function Harness({ initial = "a" }: { initial?: string }) {
  const [panel, setPanel] = useState(initial)
  const [flying, setFlying] = useState(false)
  return (
    <div>
      <button type="button" onClick={() => setPanel("b")} data-testid="go-b">
        go b
      </button>
      <span data-flight-source="a">A</span>
      <span data-flight-source="b">B</span>
      <span {...{ [FLIGHT_TARGET_ATTR]: "" }} data-testid="target" data-flying={flying}>
        T
      </span>
      <SubagentFlightGhost activePanel={panel} onFlightChange={setFlying}>
        <span>ghost</span>
      </SubagentFlightGhost>
    </div>
  )
}

beforeEach(() => {
  flowMotion = { reduce: false, speed: 1 }
})

afterEach(() => {
  jest.restoreAllMocks()
})

describe("SubagentFlightGhost", () => {
  it("does not fly on first mount — there is no previous selection", () => {
    stubRects({ a: rect(10, 10), __target__: rect(50, 300) })
    render(<Harness />)
    expect(screen.queryByTestId("subagent-flight-ghost")).not.toBeInTheDocument()
  })

  it("flies when the selection changes and both anchors are measurable", () => {
    stubRects({ a: rect(10, 10), b: rect(30, 10), __target__: rect(50, 300) })
    render(<Harness />)
    act(() => {
      screen.getByTestId("go-b").click()
    })
    expect(screen.getByTestId("subagent-flight-ghost")).toBeInTheDocument()
    expect(screen.getByTestId("target")).toHaveAttribute("data-flying", "true")
  })

  it("stays grounded when the anchors have no geometry (unlaid-out / jsdom)", () => {
    stubRects({})
    render(<Harness />)
    act(() => {
      screen.getByTestId("go-b").click()
    })
    expect(screen.queryByTestId("subagent-flight-ghost")).not.toBeInTheDocument()
    expect(screen.getByTestId("target")).toHaveAttribute("data-flying", "false")
  })

  it("stays grounded when the target anchor is missing entirely", () => {
    stubRects({ b: rect(30, 10) })
    const { container } = render(<Harness />)
    container.querySelector(`[${FLIGHT_TARGET_ATTR}]`)?.remove()
    act(() => {
      screen.getByTestId("go-b").click()
    })
    expect(screen.queryByTestId("subagent-flight-ghost")).not.toBeInTheDocument()
  })

  it("honours reduced motion by never taking off", () => {
    flowMotion = { reduce: true, speed: 1 }
    stubRects({ a: rect(10, 10), b: rect(30, 10), __target__: rect(50, 300) })
    render(<Harness />)
    act(() => {
      screen.getByTestId("go-b").click()
    })
    expect(screen.queryByTestId("subagent-flight-ghost")).not.toBeInTheDocument()
    expect(screen.getByTestId("target")).toHaveAttribute("data-flying", "false")
  })

  it("escapes quotes in a panel id so the anchor lookup cannot break out", () => {
    stubRects({ 'we"ird': rect(30, 10), __target__: rect(50, 300) })
    function QuoteHarness() {
      const [panel, setPanel] = useState("a")
      return (
        <div>
          <button type="button" onClick={() => setPanel('we"ird')} data-testid="go-quote">
            go
          </button>
          <span data-flight-source='we"ird'>Q</span>
          <span {...{ [FLIGHT_TARGET_ATTR]: "" }}>T</span>
          <SubagentFlightGhost activePanel={panel}>
            <span>ghost</span>
          </SubagentFlightGhost>
        </div>
      )
    }
    render(<QuoteHarness />)
    act(() => {
      screen.getByTestId("go-quote").click()
    })
    expect(screen.getByTestId("subagent-flight-ghost")).toBeInTheDocument()
  })
})
