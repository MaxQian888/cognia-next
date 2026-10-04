import { act, fireEvent, render, screen } from "@testing-library/react"

import { pickActiveSection, useScrollSpy } from "./use-scroll-spy"

describe("pickActiveSection", () => {
  const ids = ["a", "b", "c"]

  it("is the last section whose top has passed the reading line", () => {
    expect(pickActiveSection(ids, [-400, 10, 300], 16, false)).toBe("b")
  })

  it("is the first section before anything has scrolled", () => {
    expect(pickActiveSection(ids, [0, 200, 400], 16, false)).toBe("a")
  })

  it("is the last section once there is nothing left to scroll", () => {
    // `c` is short and never reaches the line, but it is what the reader sees.
    expect(pickActiveSection(ids, [-400, -100, 120], 16, true)).toBe("c")
  })

  it("skips sections that are not in the document", () => {
    expect(pickActiveSection(ids, [null, -5, null], 16, false)).toBe("b")
    expect(pickActiveSection(ids, [null, null, null], 16, false)).toBeNull()
  })
})

/** Positions every section at `tops[id] - scrollTop` relative to the root. */
function stubLayout(root: HTMLElement, tops: Record<string, number>) {
  root.getBoundingClientRect = () => ({ top: 0 }) as DOMRect
  Object.defineProperty(root, "scrollHeight", { configurable: true, value: 2000 })
  Object.defineProperty(root, "clientHeight", { configurable: true, value: 500 })
  for (const [id, top] of Object.entries(tops)) {
    const element = document.getElementById(id)!
    element.getBoundingClientRect = () => ({ top: top - root.scrollTop }) as DOMRect
  }
}

function Harness({ ids }: { ids: string[] }) {
  const { rootRef: root, activeId, scrollTo } = useScrollSpy<HTMLDivElement>({ ids, offset: 16 })
  return (
    <>
      <output data-testid="active">{activeId ?? "none"}</output>
      {ids.map((id) => (
        <button key={id} type="button" onClick={() => scrollTo(id)}>
          {`go-${id}`}
        </button>
      ))}
      <div ref={root} data-testid="root">
        {ids.map((id) => (
          <section key={id} id={id} />
        ))}
      </div>
    </>
  )
}

describe("useScrollSpy", () => {
  beforeEach(() => {
    jest.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0)
      return 1
    })
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it("follows the reader as the container scrolls", () => {
    render(<Harness ids={["a", "b", "c"]} />)
    const root = screen.getByTestId("root")
    stubLayout(root, { a: 0, b: 600, c: 1200 })

    act(() => {
      root.scrollTop = 650
      fireEvent.scroll(root)
    })
    expect(screen.getByTestId("active")).toHaveTextContent("b")
  })

  it("jumps by moving the container and names the target at once", () => {
    render(<Harness ids={["a", "b", "c"]} />)
    const root = screen.getByTestId("root")
    stubLayout(root, { a: 0, b: 600, c: 1200 })

    fireEvent.click(screen.getByText("go-c"))
    // 1200 from the top, less half the reading offset as breathing room.
    expect(root.scrollTop).toBe(1192)
    expect(screen.getByTestId("active")).toHaveTextContent("c")
  })

  it("does not let the jump's own scroll event take the selection away", () => {
    render(<Harness ids={["a", "b", "c"]} />)
    const root = screen.getByTestId("root")
    // `b` is short and near the end; after the jump the pane is at the bottom,
    // which on its own would make `c` active.
    stubLayout(root, { a: 0, b: 1450, c: 1480 })

    fireEvent.click(screen.getByText("go-b"))
    act(() => {
      root.scrollTop = 1500
      fireEvent.scroll(root)
    })
    expect(screen.getByTestId("active")).toHaveTextContent("b")

    // The reader's next scroll is theirs again.
    act(() => {
      fireEvent.scroll(root)
    })
    expect(screen.getByTestId("active")).toHaveTextContent("c")
  })

  it("ignores a jump to a section that is not rendered", () => {
    render(<Harness ids={["a"]} />)
    const root = screen.getByTestId("root")
    stubLayout(root, { a: 0 })
    document.getElementById("a")!.remove()
    fireEvent.click(screen.getByText("go-a"))
    expect(root.scrollTop).toBe(0)
  })

  it("returns to the top when the reset key changes, and only then", () => {
    function Keyed({ resetKey }: { resetKey: string }) {
      const { rootRef } = useScrollSpy<HTMLDivElement>({ ids: ["a"], resetKey })
      return <div ref={rootRef} data-testid="keyed" />
    }
    const { rerender } = render(<Keyed resetKey="one" />)
    const root = screen.getByTestId("keyed")
    root.scrollTop = 300
    rerender(<Keyed resetKey="one" />)
    expect(root.scrollTop).toBe(300)
    rerender(<Keyed resetKey="two" />)
    expect(root.scrollTop).toBe(0)
  })
})
