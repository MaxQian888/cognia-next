import { RenderPrefsProvider } from "../render/context"
import { RENDER_DEFAULTS } from "../../config/schema"
import React from "react"
import { act, render } from "@testing-library/react"

import { WorkingIndicator } from "./WorkingIndicator"
import { SPINNER_VERBS } from "../format/spinner-verbs"

describe("WorkingIndicator", () => {
  it("shows the first verb when streaming starts", () => {
    const { container } = render(<WorkingIndicator turnStatus="streaming" />)
    expect(container.textContent).toContain(SPINNER_VERBS[0])
  })

  it("shows a static 'stopping' word while aborting", () => {
    const { container } = render(<WorkingIndicator turnStatus="aborting" />)
    expect(container.textContent).toBe("stopping")
  })

  it("renders a verb even when idle (the footer hides it, but the word is safe)", () => {
    const { container } = render(<WorkingIndicator turnStatus="idle" />)
    expect(container.textContent).toContain(SPINNER_VERBS[0])
  })

  it("pins the word on the compaction phase instead of a rotating verb", () => {
    const { container } = render(<WorkingIndicator turnStatus="streaming" compacting />)
    expect(container.textContent).toBe("compacting context")
  })

  it("shows the compaction word even while the turn is otherwise idle", () => {
    const { container } = render(<WorkingIndicator turnStatus="idle" compacting />)
    expect(container.textContent).toBe("compacting context")
  })

  it("keeps 'stopping' authoritative while aborting during a compaction report", () => {
    const { container } = render(<WorkingIndicator turnStatus="aborting" compacting />)
    expect(container.textContent).toBe("stopping")
  })
})

it("keeps screen-reader work status stable without a timer", () => {
  jest.useFakeTimers()
  try {
    const { container, unmount } = render(
      <RenderPrefsProvider prefs={RENDER_DEFAULTS} screenReader>
        <WorkingIndicator turnStatus="streaming" />
      </RenderPrefsProvider>
    )
    expect(container.textContent).toBe("Working")
    act(() => jest.advanceTimersByTime(9000))
    expect(container.textContent).toBe("Working")
    expect(jest.getTimerCount()).toBe(0)
    unmount()
  } finally {
    jest.useRealTimers()
  }
})
