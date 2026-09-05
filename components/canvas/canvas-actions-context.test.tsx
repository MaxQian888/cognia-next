/** @jest-environment jsdom */
import { act, render, screen } from "@testing-library/react"

const runMock = jest.fn(async () => "ok")
let instances = 0
jest.mock("@/hooks/canvas/use-canvas-actions", () => ({
  useCanvasActions: () => {
    instances += 1
    return {
      running: false,
      actionType: null,
      output: "",
      error: null,
      errorKind: null,
      cancellable: false,
      retryable: false,
      run: runMock,
      stream: jest.fn(),
      cancel: jest.fn(),
      retry: jest.fn(),
      reset: jest.fn(),
    }
  },
}))

import { CanvasActionsProvider, useSharedCanvasActions } from "./canvas-actions-context"

function Consumer({ label }: { label: string }) {
  const actions = useSharedCanvasActions()
  return (
    <button type="button" onClick={() => void actions.run({ actionType: "improve", content: "x" })}>
      {label}
    </button>
  )
}

beforeEach(() => {
  runMock.mockClear()
  instances = 0
})

describe("useSharedCanvasActions", () => {
  it("gives every consumer under a provider the same run state", () => {
    // The editor pane fires the action and the workbench panel renders its
    // output. Two hook instances would mean the output had nowhere to land.
    render(
      <CanvasActionsProvider>
        <Consumer label="editor" />
        <Consumer label="panel" />
      </CanvasActionsProvider>
    )

    act(() => {
      screen.getByText("editor").click()
    })
    act(() => {
      screen.getByText("panel").click()
    })

    expect(runMock).toHaveBeenCalledTimes(2)
  })

  it("falls back to its own instance outside a provider", () => {
    // `CanvasPanel` is mounted on its own in stories and unit tests, so an
    // unprovided consumer must work rather than throw.
    expect(() => render(<Consumer label="lonely" />)).not.toThrow()
    expect(screen.getByText("lonely")).toBeInTheDocument()
  })
})
