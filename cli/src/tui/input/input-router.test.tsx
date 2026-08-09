import React from "react"
import { act, render } from "@testing-library/react"
import { __fireInput, __resetInk } from "ink"

import {
  TuiInputProvider,
  useComposerInput,
  useCriticalInput,
  useGlobalInput,
  useModalBodyInput,
  useModalInput,
  useTuiInput,
} from "./input-router"

function Route({
  name,
  priority,
  active = true,
  handled = true,
  calls,
}: {
  name: string
  priority: number
  active?: boolean
  handled?: boolean
  calls: string[]
}): React.ReactElement {
  useTuiInput(
    () => {
      calls.push(name)
      return handled
    },
    { priority, isActive: active }
  )
  return <></>
}

function BuiltinRoutes({ active, calls }: { active: string; calls: string[] }) {
  const route = (name: string) => () => calls.push(name)
  useCriticalInput(route("critical"), { isActive: active === "critical" })
  useModalInput(route("modal"), { isActive: active === "modal" })
  useModalBodyInput(route("modalBody"), { isActive: active === "modalBody" })
  useGlobalInput(route("global"), { isActive: active === "global" })
  useComposerInput(route("composer"), { isActive: active === "composer" })
  return <></>
}

describe("TuiInputProvider", () => {
  beforeEach(() => __resetInk())

  it("dispatches by priority and stops after a handled route", () => {
    const calls: string[] = []
    render(
      <TuiInputProvider>
        <Route name="composer" priority={100} calls={calls} />
        <Route name="modal" priority={400} calls={calls} />
      </TuiInputProvider>
    )
    act(() => __fireInput("x"))
    expect(calls).toEqual(["modal"])
  })

  it("falls through unhandled routes and ignores inactive routes", () => {
    const calls: string[] = []
    render(
      <TuiInputProvider>
        <Route name="composer" priority={100} calls={calls} />
        <Route name="global" priority={300} handled={false} calls={calls} />
        <Route name="hidden" priority={500} active={false} calls={calls} />
      </TuiInputProvider>
    )
    act(() => __fireInput("x"))
    expect(calls).toEqual(["global", "composer"])
  })

  it("lets conditional critical and global routes fall through", () => {
    const calls: string[] = []
    function ConditionalRoutes() {
      useCriticalInput(() => calls.push("critical"), { shouldHandle: (input) => input === "c" })
      useGlobalInput(() => calls.push("global"), { shouldHandle: (input) => input === "g" })
      useComposerInput(() => calls.push("composer"))
      return <></>
    }
    render(
      <TuiInputProvider>
        <ConditionalRoutes />
      </TuiInputProvider>
    )

    act(() => __fireInput("x"))
    act(() => __fireInput("g"))
    act(() => __fireInput("c"))
    expect(calls).toEqual(["composer", "global", "critical"])
  })

  it("uses newest-first ordering for equal priorities and unregisters on unmount", () => {
    const calls: string[] = []
    const view = render(
      <TuiInputProvider>
        <Route name="older" priority={400} calls={calls} />
        <Route name="newer" priority={400} calls={calls} />
      </TuiInputProvider>
    )
    act(() => __fireInput("x"))
    expect(calls).toEqual(["newer"])

    calls.length = 0
    view.rerender(
      <TuiInputProvider>
        <Route name="older" priority={400} calls={calls} />
      </TuiInputProvider>
    )
    act(() => __fireInput("x"))
    expect(calls).toEqual(["older"])
  })

  it.each(["critical", "modal", "modalBody", "global", "composer"])(
    "registers the %s built-in route",
    (active) => {
      const calls: string[] = []
      render(
        <TuiInputProvider>
          <BuiltinRoutes active={active} calls={calls} />
        </TuiInputProvider>
      )
      act(() => __fireInput("x"))
      expect(calls).toEqual([active])
    }
  )

  it("keeps isolated component tests working without the application provider", () => {
    const calls: string[] = []
    render(<BuiltinRoutes active="composer" calls={calls} />)
    act(() => __fireInput("x"))
    expect(calls).toEqual(["composer"])
  })
})
