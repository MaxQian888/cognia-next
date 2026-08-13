/**
 * @jest-environment jsdom
 */

import { act, fireEvent, render, screen } from "@testing-library/react"

const push = jest.fn()
let listener: (() => void) | null = null
let snapshot = {
  captureId: null as string | null,
  sourceKind: null as "renderer" | "host" | null,
  targetId: null as string | null,
  startedAt: null as number | null,
  active: false,
  gapCount: 0,
  error: null as string | null,
}

jest.mock("next/navigation", () => ({ useRouter: () => ({ push }) }))
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${Object.values(values).join(":")}` : key,
}))
jest.mock("@/lib/perf/capture-controller", () => ({
  ...(() => {
    const controller = {
      get snapshot() {
        return snapshot
      },
      subscribe: (next: () => void) => {
        listener = next
        return () => {
          listener = null
        }
      },
      stop: jest.fn().mockResolvedValue(undefined),
    }
    return {
      getPerformanceCaptureController: () => controller,
      __controller: controller,
    }
  })(),
}))

import { PerfCaptureShellStatus } from "./perf-capture-shell-status"

const stop = (
  jest.requireMock("@/lib/perf/capture-controller") as {
    __controller: { stop: jest.Mock }
  }
).__controller.stop

describe("PerfCaptureShellStatus", () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date("2026-08-13T00:00:10Z"))
    push.mockReset()
    stop.mockClear()
    listener = null
    snapshot = {
      captureId: null,
      sourceKind: null,
      targetId: null,
      startedAt: null,
      active: false,
      gapCount: 0,
      error: null,
    }
  })

  afterEach(() => jest.useRealTimers())

  it("stays hidden without an explicit capture", () => {
    render(<PerfCaptureShellStatus />)
    expect(screen.queryByTestId("perf-capture-shell-status")).not.toBeInTheDocument()
  })

  it("shows target, elapsed time, gaps, return, and stop controls", async () => {
    snapshot = {
      captureId: "capture-1",
      sourceKind: "renderer",
      targetId: "target-a",
      startedAt: Date.now() - 10_000,
      active: true,
      gapCount: 2,
      error: null,
    }
    render(<PerfCaptureShellStatus />)

    expect(screen.getByRole("status")).toHaveTextContent("summary:target-a:10:2")
    fireEvent.click(screen.getByRole("button", { name: "return" }))
    expect(push).toHaveBeenCalledWith("/performance")

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "stop" })))
    expect(stop).toHaveBeenCalledWith("manual")

    act(() => {
      snapshot = { ...snapshot, gapCount: 3 }
      listener?.()
    })
    expect(screen.getByRole("status")).toHaveTextContent("summary:target-a:10:3")
  })
})
