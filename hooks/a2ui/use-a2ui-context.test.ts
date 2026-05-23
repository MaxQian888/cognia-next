/**
 * Tests for A2UI context consumer hooks.
 *
 * The hooks throw when called outside an `A2UIProvider`; when wrapped, they
 * return the actions / data values exposed through the two split contexts.
 */

import React from "react"
import { renderHook, act } from "@testing-library/react"
import {
  A2UIActionsCtx,
  A2UIDataCtx,
  useA2UIActions,
  useA2UIData,
  useA2UIContext,
  useA2UIComponent,
  useA2UIBinding,
  useA2UIVisibility,
  useA2UIDisabled,
} from "./use-a2ui-context"
import type { A2UIActionsContextValue, A2UIDataContextValue } from "@/types/a2ui/context"
import type { A2UIComponent } from "@/types/a2ui/schema"

const componentRegistry: Record<string, A2UIComponent> = {
  btn: { id: "btn", component: "Button", text: "Click" } as A2UIComponent,
}

function makeActions(setDataValue = jest.fn()): A2UIActionsContextValue {
  return {
    surfaceId: "sx",
    catalog: undefined,
    emitAction: jest.fn(),
    setDataValue,
    getBindingPath: (v) =>
      v && typeof v === "object" && "path" in v ? String((v as { path: unknown }).path) : null,
    getComponent: (id: string) => componentRegistry[id],
    renderChild: jest.fn(() => null),
  }
}

function makeData(dataModel: Record<string, unknown> = {}): A2UIDataContextValue {
  return {
    surface: null,
    dataModel,
    components: {},
    resolveString: (v) => (typeof v === "string" ? v : ""),
    resolveNumber: (v) => (typeof v === "number" ? v : 0),
    resolveBoolean: (v, d) => (typeof v === "boolean" ? v : (d ?? false)),
    resolveArray: <T>(v: T[] | { path: string }, d: T[] = []) => (Array.isArray(v) ? v : d),
  }
}

function wrap(actions: A2UIActionsContextValue, data: A2UIDataContextValue) {
  return function Provider({ children }: { children: React.ReactNode }) {
    return React.createElement(
      A2UIActionsCtx.Provider,
      { value: actions },
      React.createElement(A2UIDataCtx.Provider, { value: data }, children)
    )
  }
}

describe("A2UI context hooks", () => {
  it("throws when used outside an A2UIProvider", () => {
    const original = console.error
    console.error = () => {}
    try {
      expect(() => renderHook(() => useA2UIActions())).toThrow(/A2UIProvider/)
      expect(() => renderHook(() => useA2UIData())).toThrow(/A2UIProvider/)
      expect(() => renderHook(() => useA2UIContext())).toThrow(/A2UIProvider/)
    } finally {
      console.error = original
    }
  })

  it("useA2UIActions exposes the actions context", () => {
    const actions = makeActions()
    const { result } = renderHook(() => useA2UIActions(), { wrapper: wrap(actions, makeData()) })
    expect(result.current.surfaceId).toBe("sx")
    expect(result.current.emitAction).toBe(actions.emitAction)
  })

  it("useA2UIData exposes the data context", () => {
    const data = makeData({ a: 1 })
    const { result } = renderHook(() => useA2UIData(), { wrapper: wrap(makeActions(), data) })
    expect(result.current.dataModel).toBe(data.dataModel)
  })

  it("useA2UIContext merges both contexts (backward-compatible)", () => {
    const actions = makeActions()
    const data = makeData({ foo: "bar" })
    const { result } = renderHook(() => useA2UIContext(), { wrapper: wrap(actions, data) })
    expect(result.current.surfaceId).toBe("sx")
    expect(result.current.dataModel).toEqual({ foo: "bar" })
  })

  it("useA2UIComponent looks the component up via the actions context", () => {
    const { result } = renderHook(() => useA2UIComponent("btn"), {
      wrapper: wrap(makeActions(), makeData()),
    })
    expect(result.current).toBe(componentRegistry.btn)
  })

  it("useA2UIBinding reads and writes via the bound JSON Pointer path", () => {
    const setDataValue = jest.fn()
    const dataModel = { user: { name: "Alice" } }
    const wrapper = wrap(makeActions(setDataValue), makeData(dataModel))

    const { result } = renderHook(() => useA2UIBinding<string>("/user/name", ""), { wrapper })

    expect(result.current[0]).toBe("Alice")
    act(() => result.current[1]("Bob"))
    expect(setDataValue).toHaveBeenCalledWith("/user/name", "Bob")
  })

  it("useA2UIBinding falls back to defaultValue when the path is missing", () => {
    const { result } = renderHook(() => useA2UIBinding("/missing", "fallback"), {
      wrapper: wrap(makeActions(), makeData({})),
    })
    expect(result.current[0]).toBe("fallback")
  })

  it("useA2UIVisibility / useA2UIDisabled default sensibly when no binding is given", () => {
    const wrapper = wrap(makeActions(), makeData())
    const vis = renderHook(() => useA2UIVisibility(), { wrapper })
    expect(vis.result.current).toBe(true)
    const dis = renderHook(() => useA2UIDisabled(), { wrapper })
    expect(dis.result.current).toBe(false)
  })

  it("useA2UIVisibility / useA2UIDisabled resolve literal booleans", () => {
    const wrapper = wrap(makeActions(), makeData())
    expect(renderHook(() => useA2UIVisibility(false), { wrapper }).result.current).toBe(false)
    expect(renderHook(() => useA2UIDisabled(true), { wrapper }).result.current).toBe(true)
  })
})
