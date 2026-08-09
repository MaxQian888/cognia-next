import React from "react"
import { act, render } from "@testing-library/react"
import { __fireInput, __resetInk } from "ink"

import { A2UISurfaceOverlay } from "./A2UISurfaceOverlay"
import type { TuiA2UISurface } from "../../a2ui/surface"

const fire = (input: string, key: Record<string, boolean> = {}) =>
  act(() => __fireInput(input, key))

function surface(component: Record<string, unknown>): TuiA2UISurface {
  return {
    surfaceId: "surface-1",
    rootId: "root",
    dataModel: {},
    components: { root: { id: "root", component: "Button", ...component } },
  }
}

describe("A2UISurfaceOverlay", () => {
  beforeEach(() => __resetInk())

  it("keeps field edits local until a submit action", () => {
    const onSubmit = jest.fn()
    const value = surface({ component: "Column", children: ["field", "submit"] })
    value.components.field = {
      id: "field",
      component: "TextField",
      label: "Name",
      value: "",
    }
    value.components.submit = {
      id: "submit",
      component: "Button",
      text: "Submit",
      action: "submit-form",
    }
    const { container } = render(
      <A2UISurfaceOverlay surface={value} onSubmit={onSubmit} onRaw={() => {}} onClose={() => {}} />
    )
    fire("", { downArrow: true })
    fire("A")
    fire("d")
    fire("a")
    expect(container.textContent).toContain("Name: Ada")
    expect(onSubmit).not.toHaveBeenCalled()
    fire("", { downArrow: true })
    fire("", { return: true })
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "submit-form", data: { values: { field: "Ada" } } })
    )
  })

  it("requires a second confirmation for destructive actions", () => {
    const onSubmit = jest.fn()
    const { container } = render(
      <A2UISurfaceOverlay
        surface={surface({ text: "Delete", action: "delete-project", variant: "destructive" })}
        onSubmit={onSubmit}
        onRaw={() => {}}
        onClose={() => {}}
      />
    )
    fire("", { return: true })
    expect(onSubmit).not.toHaveBeenCalled()
    expect(container.textContent).toContain("Confirm destructive action")
    fire("", { return: true })
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it("offers raw data for unsupported fallbacks", () => {
    const onRaw = jest.fn()
    const { container } = render(
      <A2UISurfaceOverlay
        surface={surface({ component: "RichOutput", fallbackContent: "Readable fallback" })}
        onSubmit={() => {}}
        onRaw={onRaw}
        onClose={() => {}}
      />
    )
    expect(container.textContent).toContain("Readable fallback")
    fire("r")
    expect(onRaw).toHaveBeenCalled()
  })

  it("keeps the selected row visible in a bounded window", () => {
    const value = surface({
      component: "Column",
      children: Array.from({ length: 8 }, (_, index) => `button-${index}`),
    })
    for (let index = 0; index < 8; index += 1) {
      value.components[`button-${index}`] = {
        id: `button-${index}`,
        component: "Button",
        text: `Action ${index}`,
      }
    }
    const { container } = render(
      <A2UISurfaceOverlay
        surface={value}
        maxRows={8}
        onSubmit={() => {}}
        onRaw={() => {}}
        onClose={() => {}}
      />
    )

    for (let index = 0; index < 7; index += 1) fire("", { downArrow: true })

    expect(container.textContent).toContain("Action 6")
    expect(container.textContent).not.toContain("Action 0")
    expect(container.textContent).toContain("more")
  })
})
