/**
 * @jest-environment jsdom
 */
import "./test-pointer-polyfill"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

import { PullToRefresh } from "./pull-to-refresh"

function pullDown(el: HTMLElement, dy: number) {
  fireEvent.pointerDown(el, { clientX: 0, clientY: 100, pointerId: 1 })
  fireEvent.pointerMove(el, { clientX: 0, clientY: 100 + dy, pointerId: 1 })
  fireEvent.pointerUp(el, { clientX: 0, clientY: 100 + dy, pointerId: 1 })
}

describe("<PullToRefresh />", () => {
  it("invokes onRefresh when pulled past trigger", async () => {
    const onRefresh = jest.fn().mockResolvedValue(undefined)
    render(
      <PullToRefresh onRefresh={onRefresh} silent>
        <div>list</div>
      </PullToRefresh>
    )
    const wrap = screen.getByTestId("pull-to-refresh")
    pullDown(wrap, 80)
    await waitFor(() => expect(onRefresh).toHaveBeenCalled())
  })

  it("does not invoke onRefresh when pull falls short", async () => {
    const onRefresh = jest.fn().mockResolvedValue(undefined)
    render(
      <PullToRefresh onRefresh={onRefresh} silent>
        <div>list</div>
      </PullToRefresh>
    )
    const wrap = screen.getByTestId("pull-to-refresh")
    pullDown(wrap, 30)
    await new Promise((r) => setTimeout(r, 0))
    expect(onRefresh).not.toHaveBeenCalled()
  })

  it("flips data-refreshing during the refresh callback", async () => {
    let resolve: (() => void) | null = null
    const onRefresh = jest.fn(
      () =>
        new Promise<void>((r) => {
          resolve = () => r()
        })
    )
    render(
      <PullToRefresh onRefresh={onRefresh} silent>
        <div>list</div>
      </PullToRefresh>
    )
    const wrap = screen.getByTestId("pull-to-refresh")
    pullDown(wrap, 80)
    await waitFor(() => expect(wrap.getAttribute("data-refreshing")).toBe("true"))
    resolve!()
    await waitFor(() => expect(wrap.getAttribute("data-refreshing")).toBe("false"))
  })

  it("does nothing when scrollTop > 0 at gesture start", () => {
    const onRefresh = jest.fn()
    const { container } = render(
      <PullToRefresh onRefresh={onRefresh} silent>
        <div style={{ height: 5000 }}>tall list</div>
      </PullToRefresh>
    )
    const wrap = container.querySelector('[data-testid="pull-to-refresh"]') as HTMLElement
    Object.defineProperty(wrap, "scrollTop", { value: 200, configurable: true })
    pullDown(wrap, 100)
    expect(onRefresh).not.toHaveBeenCalled()
  })

  it("ignores upward (negative) drag", () => {
    const onRefresh = jest.fn()
    render(
      <PullToRefresh onRefresh={onRefresh} silent>
        <div>list</div>
      </PullToRefresh>
    )
    const wrap = screen.getByTestId("pull-to-refresh")
    pullDown(wrap, -50)
    expect(onRefresh).not.toHaveBeenCalled()
  })

  it("survives onRefresh throwing", async () => {
    const onRefresh = jest.fn().mockRejectedValue(new Error("boom"))
    render(
      <PullToRefresh onRefresh={onRefresh} silent>
        <div>list</div>
      </PullToRefresh>
    )
    pullDown(screen.getByTestId("pull-to-refresh"), 80)
    await waitFor(() =>
      expect(screen.getByTestId("pull-to-refresh").getAttribute("data-refreshing")).toBe("false")
    )
  })
})
