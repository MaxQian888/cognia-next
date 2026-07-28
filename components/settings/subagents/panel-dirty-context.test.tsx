/**
 * @jest-environment jsdom
 */

import { useState } from "react"
import { act, render, screen } from "@testing-library/react"

import { PanelDirtyProvider, useReportPanelDirty, usePanelDirty } from "./panel-dirty-context"

function Reporter({ dirty }: { dirty: boolean }) {
  useReportPanelDirty(dirty)
  return <span>panel</span>
}

function Readout() {
  const dirty = usePanelDirty()
  return <span data-testid="readout">{dirty ? "dirty" : "clean"}</span>
}

function Harness() {
  const [mounted, setMounted] = useState(true)
  const [dirty, setDirty] = useState(false)
  return (
    <PanelDirtyProvider>
      <Readout />
      <button type="button" data-testid="soil" onClick={() => setDirty(true)}>
        soil
      </button>
      <button type="button" data-testid="unmount" onClick={() => setMounted(false)}>
        unmount
      </button>
      {mounted ? <Reporter dirty={dirty} /> : null}
    </PanelDirtyProvider>
  )
}

describe("panel dirty context", () => {
  it("starts clean", () => {
    render(<Harness />)
    expect(screen.getByTestId("readout")).toHaveTextContent("clean")
  })

  it("propagates the active panel's dirty flag up to the section", () => {
    render(<Harness />)
    act(() => screen.getByTestId("soil").click())
    expect(screen.getByTestId("readout")).toHaveTextContent("dirty")
  })

  it("clears when the panel unmounts so a departed panel cannot keep blocking", () => {
    render(<Harness />)
    act(() => screen.getByTestId("soil").click())
    act(() => screen.getByTestId("unmount").click())
    expect(screen.getByTestId("readout")).toHaveTextContent("clean")
  })

  it("reads clean outside a provider rather than throwing", () => {
    render(<Readout />)
    expect(screen.getByTestId("readout")).toHaveTextContent("clean")
  })
})
