/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, act } from "@testing-library/react"
import { agoBucket, RefreshStatus } from "./refresh-status"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${vars.count}` : key,
}))

describe("agoBucket", () => {
  it("buckets elapsed time", () => {
    expect(agoBucket(0)).toEqual({ key: "justNow", count: 0 })
    expect(agoBucket(4999)).toEqual({ key: "justNow", count: 0 })
    expect(agoBucket(12_000)).toEqual({ key: "secondsAgo", count: 12 })
    expect(agoBucket(90_000)).toEqual({ key: "minutesAgo", count: 1 })
    expect(agoBucket(3 * 3_600_000)).toEqual({ key: "hoursAgo", count: 3 })
  })
  it("clamps negatives to justNow", () => {
    expect(agoBucket(-500)).toEqual({ key: "justNow", count: 0 })
  })
})

describe("RefreshStatus", () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it("fires onRefresh when the button is clicked", () => {
    const onRefresh = jest.fn()
    render(<RefreshStatus lastUpdated={Date.now()} onRefresh={onRefresh} />)
    fireEvent.click(screen.getByTestId("manual-refresh"))
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it("shows a relative last-updated label once mounted", () => {
    jest.setSystemTime(100_000)
    render(<RefreshStatus lastUpdated={100_000 - 30_000} onRefresh={jest.fn()} />)
    // Mount effect stamps `now`; label reflects 30s elapsed.
    act(() => {
      jest.advanceTimersByTime(0)
    })
    expect(screen.getByTestId("last-updated")).toHaveTextContent("secondsAgo:30")
  })

  it("renders no label before a lastUpdated is available", () => {
    render(<RefreshStatus lastUpdated={null} onRefresh={jest.fn()} />)
    expect(screen.queryByTestId("last-updated")).not.toBeInTheDocument()
  })
})
