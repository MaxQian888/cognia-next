import React, { useEffect } from "react"
import { render, act } from "@testing-library/react"

import { useAskUserOverlay, type AskUserOverlayApi } from "./use-ask-user-overlay"
import { useAskUserStore } from "@/stores/agent/ask-user-store"
import type { AskUserRequest } from "@/lib/claude/ask-user-tool"
import type { Overlay, TuiAction } from "../state/types"

const REQUEST: AskUserRequest = {
  question: "Ship it?",
  options: [{ value: "yes", label: "Yes" }],
  multiSelect: false,
  allowText: false,
}

function Harness({
  overlayKind,
  dispatch,
  apiRef,
}: {
  overlayKind: Overlay["kind"]
  dispatch: (a: TuiAction) => void
  apiRef?: { current: AskUserOverlayApi | null }
}) {
  const api = useAskUserOverlay(overlayKind, dispatch)
  useEffect(() => {
    if (apiRef) apiRef.current = api
  }, [api, apiRef])
  return null
}

describe("useAskUserOverlay", () => {
  beforeEach(() => {
    useAskUserStore.setState({ active: null, queue: [] })
  })

  it("opens an askUser overlay when a prompt becomes active and nothing else is open", () => {
    const dispatch = jest.fn()
    render(<Harness overlayKind="none" dispatch={dispatch} />)
    expect(dispatch).not.toHaveBeenCalled()

    act(() => {
      void useAskUserStore.getState().enqueue(REQUEST)
    })

    expect(dispatch).toHaveBeenCalledWith({
      type: "OVERLAY_OPEN",
      overlay: { kind: "askUser", request: REQUEST },
    })
  })

  it("waits for a competing overlay to close before opening", () => {
    const dispatch = jest.fn()
    const { rerender } = render(<Harness overlayKind="permission" dispatch={dispatch} />)
    act(() => {
      void useAskUserStore.getState().enqueue(REQUEST)
    })
    // A permission overlay owns the screen — don't clobber it.
    expect(dispatch).not.toHaveBeenCalled()

    // Once it closes, the effect re-fires and opens the question.
    rerender(<Harness overlayKind="none" dispatch={dispatch} />)
    expect(dispatch).toHaveBeenCalledWith({
      type: "OVERLAY_OPEN",
      overlay: { kind: "askUser", request: REQUEST },
    })
  })

  it("resolves the blocked tool call and closes the overlay", async () => {
    const dispatch = jest.fn()
    const apiRef: { current: AskUserOverlayApi | null } = { current: null }
    render(<Harness overlayKind="askUser" dispatch={dispatch} apiRef={apiRef} />)

    let answered: unknown
    act(() => {
      void useAskUserStore
        .getState()
        .enqueue(REQUEST)
        .then((a) => (answered = a))
    })
    const answer = { selected: ["yes"], text: "", cancelled: false }
    await act(async () => {
      apiRef.current!.resolve(answer)
    })

    expect(answered).toEqual(answer)
    expect(dispatch).toHaveBeenCalledWith({ type: "OVERLAY_CLOSE" })
  })

  it("closes defensively if the active prompt vanishes while the overlay is open", () => {
    const dispatch = jest.fn()
    render(<Harness overlayKind="askUser" dispatch={dispatch} />)
    // No active prompt but the overlay kind says askUser → reconcile by closing.
    expect(dispatch).toHaveBeenCalledWith({ type: "OVERLAY_CLOSE" })
  })
})
