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
  it("replaces an aborted child question with its sibling and rejects the old answer identity", async () => {
    useAskUserStore.setState({ active: null, queue: [] })
    const dispatch = jest.fn(),
      controller = new AbortController()
    const apiRef: { current: AskUserOverlayApi | null } = { current: null }
    render(<Harness overlayKind="askUser" dispatch={dispatch} apiRef={apiRef} />)
    let first: Promise<unknown>, sibling: Promise<unknown>, firstId: string
    act(() => {
      first = useAskUserStore.getState().enqueue(REQUEST, "child", controller.signal)
      firstId = useAskUserStore.getState().active!.id
      sibling = useAskUserStore
        .getState()
        .enqueue({ ...REQUEST, question: "Sibling question" }, "sibling")
    })
    await act(async () => {
      controller.abort()
      await first
    })
    const siblingId = useAskUserStore.getState().active!.id
    expect(dispatch).toHaveBeenLastCalledWith({
      type: "OVERLAY_OPEN",
      overlay: {
        kind: "askUser",
        request: expect.objectContaining({ question: "Sibling question" }),
        requestId: siblingId,
      },
    })
    act(() =>
      apiRef.current!.resolve({ selected: ["yes"], text: "stale", cancelled: false }, firstId!)
    )
    expect(useAskUserStore.getState().active!.id).toBe(siblingId)
    await act(async () => {
      apiRef.current!.resolve({ selected: ["yes"], text: "correct", cancelled: false }, siblingId)
      await sibling
    })
    await expect(sibling!).resolves.toMatchObject({ text: "correct" })
  })
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
      overlay: { kind: "askUser", request: REQUEST, requestId: expect.any(String) },
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
      overlay: { kind: "askUser", request: REQUEST, requestId: expect.any(String) },
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
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "OVERLAY_CLOSE" }))
  })

  it("closes defensively if the active prompt vanishes while the overlay is open", () => {
    const dispatch = jest.fn()
    render(<Harness overlayKind="askUser" dispatch={dispatch} />)
    // No active prompt but the overlay kind says askUser → reconcile by closing.
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "OVERLAY_CLOSE" }))
  })
})
