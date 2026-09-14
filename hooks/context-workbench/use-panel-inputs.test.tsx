/** @jest-environment jsdom */

import { useEffect } from "react"
import { act, render, renderHook, screen } from "@testing-library/react"

import { usePanelInput, usePanelInputs, type PanelInputs } from "./use-panel-inputs"

interface Inputs {
  sessionId: string
  messages: readonly string[]
}

describe("usePanelInputs", () => {
  it("keeps one store for the life of the component, holding the latest input", () => {
    const first = { sessionId: "s1", messages: ["a"] }
    const { result, rerender } = renderHook((input: Inputs) => usePanelInputs(input), {
      initialProps: first,
    })
    const store = result.current
    expect(store.getState()).toBe(first)

    const next = { sessionId: "s1", messages: ["a", "b"] }
    rerender(next)
    expect(result.current).toBe(store)
    expect(store.getState()).toBe(next)
  })

  // Every dock render builds a fresh input object. Notifying on each would
  // re-render every panel on every render for nothing.
  it("notifies no one when nothing in the input changed", () => {
    const messages = ["a"]
    const { result, rerender } = renderHook((input: Inputs) => usePanelInputs(input), {
      initialProps: { sessionId: "s1", messages },
    })
    const listener = jest.fn()
    result.current.subscribe(listener)
    rerender({ sessionId: "s1", messages })
    expect(listener).not.toHaveBeenCalled()
    rerender({ sessionId: "s2", messages })
    expect(listener).toHaveBeenCalledTimes(1)
  })
})

describe("usePanelInput", () => {
  function Panel({ store, onMount }: { store: PanelInputs<Inputs>; onMount: () => void }) {
    const sessionId = usePanelInput(store, (input) => input.sessionId)
    useEffect(onMount, [onMount])
    return <p data-testid="panel">{sessionId}</p>
  }

  // The defect this exists for: a panel must follow its facts WITHOUT being
  // torn down and rebuilt when they change.
  it("re-renders a panel when its slice changes, and never remounts it", () => {
    let store: PanelInputs<Inputs> | null = null
    const onMount = jest.fn()
    function Host({ input }: { input: Inputs }) {
      store = usePanelInputs(input)
      return <Panel store={store} onMount={onMount} />
    }
    const { rerender } = render(<Host input={{ sessionId: "s1", messages: [] }} />)
    expect(screen.getByTestId("panel")).toHaveTextContent("s1")

    rerender(<Host input={{ sessionId: "s2", messages: [] }} />)
    expect(screen.getByTestId("panel")).toHaveTextContent("s2")
    expect(onMount).toHaveBeenCalledTimes(1)
  })

  it("does not re-render a panel for a slice it did not select", () => {
    const renders = jest.fn()
    let store: PanelInputs<Inputs> | null = null
    function Reader({ source }: { source: PanelInputs<Inputs> }) {
      const sessionId = usePanelInput(source, (input) => input.sessionId)
      renders(sessionId)
      return null
    }
    const { result, rerender } = renderHook((input: Inputs) => usePanelInputs(input), {
      initialProps: { sessionId: "s1", messages: [] as string[] },
    })
    store = result.current
    render(<Reader source={store} />)
    renders.mockClear()
    act(() => rerender({ sessionId: "s1", messages: ["streamed token"] }))
    expect(renders).not.toHaveBeenCalled()
  })
})
