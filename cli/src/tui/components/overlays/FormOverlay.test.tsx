import React from "react"
import { act, render } from "@testing-library/react"
import { __fireInput, __resetInk } from "ink"

import { FormOverlay } from "./FormOverlay"
import type { FormOverlayState } from "../../state/form"

const fire = (input: string, key: Record<string, boolean> = {}) =>
  act(() => __fireInput(input, key))

function form(activeField = 0): FormOverlayState {
  return {
    title: "Configure",
    commandName: "demo",
    activeField,
    fields: Array.from({ length: 7 }, (_, index) => ({
      spec: { name: `field-${index}`, label: `Field ${index}`, type: "string" as const },
      value: `value-${index}`,
    })),
  }
}

describe("FormOverlay", () => {
  beforeEach(() => __resetInk())

  it("windows long forms around the active field", () => {
    const { container } = render(
      <FormOverlay
        form={form(5)}
        maxRows={8}
        onUpdate={() => {}}
        onSubmit={() => {}}
        onCancel={() => {}}
      />
    )

    expect(container.textContent).toContain("Field 5")
    expect(container.textContent).not.toContain("Field 0")
    expect(container.textContent).toContain("more")
  })

  it("routes navigation, editing, submit, and cancel once", () => {
    const onUpdate = jest.fn()
    const onSubmit = jest.fn()
    const onCancel = jest.fn()
    render(
      <FormOverlay form={form()} onUpdate={onUpdate} onSubmit={onSubmit} onCancel={onCancel} />
    )

    fire("x")
    fire("", { downArrow: true })
    fire("", { return: true })
    fire("", { escape: true })

    expect(onUpdate).toHaveBeenCalledTimes(2)
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})
