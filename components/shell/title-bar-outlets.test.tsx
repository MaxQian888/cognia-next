import { act, render, renderHook, screen } from "@testing-library/react"
import { createPortal } from "react-dom"
import type { ReactNode } from "react"
import {
  TITLE_BAR_ZONES,
  TitleBarOutletsProvider,
  TitleBarProjectionScope,
  useTitleBarOutletRef,
  useTitleBarProjection,
  useTitleBarProjectionState,
} from "./title-bar-outlets"

function Bar() {
  const start = useTitleBarOutletRef("start")
  const center = useTitleBarOutletRef("center")
  const end = useTitleBarOutletRef("end")
  const projected = useTitleBarProjectionState()
  return (
    <div data-testid="bar" data-projected={JSON.stringify(projected)}>
      <div ref={start} data-testid="outlet-start" />
      <div ref={center} data-testid="outlet-center" />
      <div ref={end} data-testid="outlet-end" />
    </div>
  )
}

function ColumnHeader({ zone, active }: { zone: "start" | "center" | "end"; active?: boolean }) {
  const outlet = useTitleBarProjection(zone, { active })
  const content = <span data-testid={`header-${zone}`}>{zone} header</span>
  return outlet ? createPortal(content, outlet) : <header data-testid="inline">{content}</header>
}

function projectedState() {
  return JSON.parse(screen.getByTestId("bar").getAttribute("data-projected") ?? "{}") as Record<
    string,
    boolean
  >
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <TitleBarOutletsProvider>
      <Bar />
      {children}
    </TitleBarOutletsProvider>
  )
}

describe("title-bar outlets", () => {
  it("names the three structural zones", () => {
    expect(TITLE_BAR_ZONES).toEqual(["start", "center", "end"])
  })

  it("draws inline when there is no provider at all (the mobile shell)", () => {
    render(<ColumnHeader zone="center" />)
    expect(screen.getByTestId("inline")).toContainElement(screen.getByTestId("header-center"))
  })

  it("draws inline inside the shell until a scope enables projection", () => {
    render(
      <Shell>
        <ColumnHeader zone="center" />
      </Shell>
    )
    expect(screen.getByTestId("inline")).toBeInTheDocument()
    expect(screen.getByTestId("outlet-center")).toBeEmptyDOMElement()
    expect(projectedState().center).toBe(false)
  })

  it("portals into the zone's outlet inside an enabling scope and counts itself", () => {
    render(
      <Shell>
        <TitleBarProjectionScope enabled>
          <ColumnHeader zone="center" />
        </TitleBarProjectionScope>
      </Shell>
    )
    expect(screen.queryByTestId("inline")).toBeNull()
    expect(screen.getByTestId("outlet-center")).toContainElement(
      screen.getByTestId("header-center")
    )
    expect(projectedState()).toEqual({ start: false, center: true, end: false })
  })

  it("lets a nested scope switch projection back off (the rail's mobile Sheet)", () => {
    render(
      <Shell>
        <TitleBarProjectionScope enabled>
          <TitleBarProjectionScope enabled={false}>
            <ColumnHeader zone="start" />
          </TitleBarProjectionScope>
        </TitleBarProjectionScope>
      </Shell>
    )
    expect(screen.getByTestId("inline")).toBeInTheDocument()
    expect(projectedState().start).toBe(false)
  })

  it("stands down while inactive and un-counts on unmount", () => {
    const { rerender, unmount } = render(
      <Shell>
        <TitleBarProjectionScope enabled>
          <ColumnHeader zone="start" active />
        </TitleBarProjectionScope>
      </Shell>
    )
    expect(projectedState().start).toBe(true)

    rerender(
      <Shell>
        <TitleBarProjectionScope enabled>
          <ColumnHeader zone="start" active={false} />
        </TitleBarProjectionScope>
      </Shell>
    )
    expect(screen.getByTestId("inline")).toBeInTheDocument()
    expect(projectedState().start).toBe(false)

    rerender(
      <Shell>
        <TitleBarProjectionScope enabled>
          <ColumnHeader zone="start" active />
        </TitleBarProjectionScope>
      </Shell>
    )
    expect(projectedState().start).toBe(true)
    unmount()
  })

  it("counts several projectors into one zone (split view has two chat headers)", () => {
    const { rerender } = render(
      <Shell>
        <TitleBarProjectionScope enabled>
          <ColumnHeader zone="center" />
          <ColumnHeader zone="center" />
        </TitleBarProjectionScope>
      </Shell>
    )
    expect(screen.getAllByTestId("header-center")).toHaveLength(2)
    expect(projectedState().center).toBe(true)

    rerender(
      <Shell>
        <TitleBarProjectionScope enabled>
          <ColumnHeader zone="center" />
        </TitleBarProjectionScope>
      </Shell>
    )
    // One left: still projected. The count, not a boolean, is what makes this
    // hold when the second pane closes.
    expect(projectedState().center).toBe(true)

    rerender(
      <Shell>
        <TitleBarProjectionScope enabled>{null}</TitleBarProjectionScope>
      </Shell>
    )
    expect(projectedState().center).toBe(false)
  })

  it("outlet ref and projection state are inert without a provider", () => {
    const { result } = renderHook(() => ({
      ref: useTitleBarOutletRef("end"),
      state: useTitleBarProjectionState(),
    }))
    act(() => result.current.ref(document.createElement("div")))
    expect(result.current.state).toEqual({ start: false, center: false, end: false })
  })
})
