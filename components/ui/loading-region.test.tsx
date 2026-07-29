import { act, render, screen } from "@testing-library/react"

import { LoadingRegion } from "./loading-region"
import { LOADING_DELAY_MS } from "@/hooks/ui/use-deferred-loading"
import { ESCALATED_AT_MS, PROLONGED_AT_MS } from "@/hooks/ui/use-loading-phase"

const mockNetwork = { connected: true, connectionType: "wifi" as const }

jest.mock("@/hooks/use-network-status", () => ({
  useNetworkStatus: () => ({ loading: false, status: mockNetwork }),
}))

jest.mock("@/hooks/ui/use-loading-i18n", () => ({
  useLoadingI18n: () => ({
    thinking: "thinking",
    pageLoading: "pageLoading",
    inlineLoading: "Loading…",
    loading: "Loading…",
    stillWorking: (seconds: number) => `Still working… (${seconds}s)`,
    offline: "You're offline",
    cancel: "Cancel",
  }),
}))

function setup(props: Partial<React.ComponentProps<typeof LoadingRegion>> = {}) {
  return render(
    <LoadingRegion loading fallback={<div data-testid="fallback" />} {...props}>
      <div data-testid="content" />
    </LoadingRegion>
  )
}

describe("LoadingRegion", () => {
  beforeEach(() => {
    jest.useFakeTimers()
    mockNetwork.connected = true
  })
  afterEach(() => {
    jest.clearAllTimers()
    jest.useRealTimers()
  })

  it("marks the region busy while loading", () => {
    const { container } = setup()
    expect(container.querySelector('[data-slot="loading-region"]')).toHaveAttribute(
      "aria-busy",
      "true"
    )
  })

  it("keeps showing content until the wait is worth interrupting for", () => {
    setup()
    expect(screen.getByTestId("content")).toBeInTheDocument()
    expect(screen.queryByTestId("fallback")).not.toBeInTheDocument()
  })

  it("swaps in the fallback once the delay elapses", () => {
    setup()
    act(() => {
      jest.advanceTimersByTime(LOADING_DELAY_MS)
    })
    expect(screen.getByTestId("fallback")).toBeInTheDocument()
    expect(screen.queryByTestId("content")).not.toBeInTheDocument()
  })

  it("announces once for the whole region, however many skeletons it holds", () => {
    setup({
      label: "Loading sessions",
      fallback: (
        <>
          <div data-slot="skeleton" />
          <div data-slot="skeleton" />
          <div data-slot="skeleton" />
        </>
      ),
    })
    act(() => {
      jest.advanceTimersByTime(LOADING_DELAY_MS)
    })
    const statuses = screen.getAllByRole("status")
    expect(statuses).toHaveLength(1)
    expect(statuses[0]).toHaveTextContent("Loading sessions")
  })

  it("re-announces with an elapsed count once the wait turns prolonged", () => {
    setup({ label: "Loading sessions" })
    act(() => {
      jest.advanceTimersByTime(LOADING_DELAY_MS)
    })
    expect(screen.getByRole("status")).toHaveTextContent("Loading sessions")

    act(() => {
      jest.advanceTimersByTime(PROLONGED_AT_MS)
    })
    expect(screen.getByRole("status")).toHaveTextContent("Still working…")
  })

  it("says it is offline instead of counting seconds at nobody", () => {
    mockNetwork.connected = false
    setup()
    // Two steps on purpose: the status element (and therefore its phase clock)
    // only mounts once the delay has flipped the indicator on, so a single
    // combined advance would never let the phase timer run.
    act(() => {
      jest.advanceTimersByTime(LOADING_DELAY_MS)
    })
    act(() => {
      jest.advanceTimersByTime(PROLONGED_AT_MS)
    })
    expect(screen.getByRole("status")).toHaveTextContent("You're offline")
  })

  it("offers no cancel when the caller cannot actually cancel", () => {
    setup()
    act(() => {
      jest.advanceTimersByTime(LOADING_DELAY_MS)
    })
    act(() => {
      jest.advanceTimersByTime(ESCALATED_AT_MS)
    })
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument()
  })

  it("offers a cancel once escalated when the caller supplied one", () => {
    const onCancel = jest.fn()
    setup({ onCancel })
    act(() => {
      jest.advanceTimersByTime(LOADING_DELAY_MS)
    })
    act(() => {
      jest.advanceTimersByTime(ESCALATED_AT_MS)
    })
    const button = screen.getByRole("button", { name: "Cancel" })
    act(() => {
      button.click()
    })
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it("does not double-announce the escalation copy", () => {
    // The visible line repeats what the live region already said, so it must
    // stay hidden from assistive tech.
    const { container } = setup()
    act(() => {
      jest.advanceTimersByTime(LOADING_DELAY_MS)
    })
    act(() => {
      jest.advanceTimersByTime(PROLONGED_AT_MS)
    })
    const visible = container.querySelector('span[aria-hidden="true"]')
    expect(visible).toHaveTextContent("Still working…")
  })

  it("drops busy once loading ends", () => {
    const { container, rerender } = setup()
    rerender(
      <LoadingRegion loading={false} fallback={<div data-testid="fallback" />}>
        <div data-testid="content" />
      </LoadingRegion>
    )
    expect(container.querySelector('[data-slot="loading-region"]')).not.toHaveAttribute("aria-busy")
  })
})
