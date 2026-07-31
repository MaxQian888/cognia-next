/**
 * Integration test for fine-grained A2UI re-render skipping.
 *
 * Exercises the real provider + Zustand store + renderer together (no context
 * mock) to prove that a data change only re-renders the components whose bound
 * path actually changed — the payoff of the structural-sharing data model
 * (lib/a2ui/data-model.ts) combined with `useBoundDataVersion`.
 */

import React, { memo, useEffect } from "react"
import { render, act, screen } from "@testing-library/react"
import { A2UIProvider } from "./a2ui-context"
import { A2UIRenderer, registerBuiltInComponent } from "./a2ui-renderer"
import { useA2UIStore } from "@/stores/a2ui"
import { getValueByPath } from "@/lib/a2ui/data-model"
import type { A2UIComponent, A2UIComponentProps } from "@/types/a2ui/schema"

const renderCounts: Record<string, number> = {}

// A memoized leaf that records every render and reads its bound value, mirroring
// how the real A2UI leaf components (all `memo()`) consume props.
const CountingText = memo(function CountingText({ component, dataModel }: A2UIComponentProps) {
  const binding = (component as { text?: { path?: string } }).text
  const value = binding?.path ? getValueByPath(dataModel, binding.path) : ""
  // Count committed renders in an effect — a memo-skipped render never runs the
  // component body (and thus never this effect), so the count reflects real
  // re-renders without mutating state during render.
  useEffect(() => {
    renderCounts[component.id] = (renderCounts[component.id] ?? 0) + 1
  })
  return <div data-testid={component.id}>{String(value ?? "")}</div>
})

const SURFACE_ID = "fine-grained-surface"

const compA = {
  id: "compA",
  component: "CountingText",
  text: { path: "/a" },
} as unknown as A2UIComponent

const compB = {
  id: "compB",
  component: "CountingText",
  text: { path: "/b" },
} as unknown as A2UIComponent

function Harness() {
  return (
    <A2UIProvider surfaceId={SURFACE_ID} renderComponent={(c) => <A2UIRenderer component={c} />}>
      <A2UIRenderer component={compA} />
      <A2UIRenderer component={compB} />
    </A2UIProvider>
  )
}

describe("A2UI fine-grained re-render skipping", () => {
  beforeAll(() => {
    registerBuiltInComponent("CountingText", CountingText as never)
  })

  beforeEach(() => {
    const store = useA2UIStore.getState()
    store.reset()
    store.createSurface(SURFACE_ID, "inline")
    store.updateDataModel(SURFACE_ID, { a: 1, b: 2 }, false)
    for (const key of Object.keys(renderCounts)) delete renderCounts[key]
  })

  it("re-renders only the component bound to the changed path", () => {
    render(<Harness />)

    expect(renderCounts.compA).toBe(1)
    expect(renderCounts.compB).toBe(1)
    expect(screen.getByTestId("compA")).toHaveTextContent("1")
    expect(screen.getByTestId("compB")).toHaveTextContent("2")

    // Mutate ONLY /a — compB binds /b and must not re-render.
    act(() => {
      useA2UIStore.getState().setDataValue(SURFACE_ID, "/a", 99)
    })

    expect(renderCounts.compA).toBe(2)
    expect(renderCounts.compB).toBe(1) // skipped — its bound data is unchanged
    expect(screen.getByTestId("compA")).toHaveTextContent("99")
    expect(screen.getByTestId("compB")).toHaveTextContent("2")
  })

  it("re-renders a component when its own bound path changes", () => {
    render(<Harness />)
    const beforeA = renderCounts.compA

    act(() => {
      useA2UIStore.getState().setDataValue(SURFACE_ID, "/b", 7)
    })

    expect(renderCounts.compB).toBe(2)
    expect(renderCounts.compA).toBe(beforeA) // /a untouched → compA skipped
    expect(screen.getByTestId("compB")).toHaveTextContent("7")
  })

  it("skips both components when an unrelated path changes", () => {
    render(<Harness />)

    act(() => {
      useA2UIStore.getState().setDataValue(SURFACE_ID, "/unrelated", "x")
    })

    expect(renderCounts.compA).toBe(1)
    expect(renderCounts.compB).toBe(1)
  })
})
