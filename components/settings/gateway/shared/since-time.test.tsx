import { render, screen } from "@testing-library/react"

import { JUST_NOW_MS, SinceTime } from "./since-time"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  useFormatter: () => ({
    relativeTime: (date: Date, now: Date) => `rel:${now.getTime() - date.getTime()}`,
    dateTime: (date: Date) => `abs:${date.toISOString()}`,
  }),
}))

const now = new Date("2026-09-25T10:00:00.000Z")
const ago = (ms: number) => new Date(now.getTime() - ms)

describe("SinceTime", () => {
  it("formats an older instant relative to now, with the absolute time on hover", () => {
    render(<SinceTime date={ago(5 * 60_000)} now={now} />)

    const time = screen.getByText("rel:300000")
    expect(time.tagName).toBe("TIME")
    expect(time).toHaveAttribute("dateTime", "2026-09-25T09:55:00.000Z")
    expect(time).toHaveAttribute("title", "abs:2026-09-25T09:55:00.000Z")
  })

  it("says 'just now' inside the first minute instead of 'now'", () => {
    render(<SinceTime date={ago(JUST_NOW_MS - 1)} now={now} />)
    expect(screen.getByText("justNow")).toBeInTheDocument()
  })

  it("never reads as the future when the instant is newer than the clock tick", () => {
    // Status polls faster than `useNow` ticks, so this is reachable.
    render(<SinceTime date={ago(-4_000)} now={now} />)
    expect(screen.getByText("justNow")).toBeInTheDocument()
  })

  it("wraps the phrase in a sentence when asked", () => {
    render(<SinceTime date={ago(2 * 60_000)} now={now} label={(time) => `published ${time}`} />)
    expect(screen.getByText("published rel:120000")).toBeInTheDocument()
  })
})
