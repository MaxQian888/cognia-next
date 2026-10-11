/**
 * @jest-environment jsdom
 */

import React from "react"
import { render, screen } from "@testing-library/react"
import type { PluginAnalyticsRow } from "@/lib/db/plugin-types"

jest.mock("next-intl", () => ({
  useTranslations: () => {
    const t = (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key}:${JSON.stringify(vars)}` : key
    t.rich = (
      key: string,
      vars: { recorded: string; date: string; time: (chunks: string) => React.ReactNode }
    ) => (
      <>
        {`${key}:${vars.recorded} `}
        {vars.time(vars.date)}
      </>
    )
    return t
  },
  // Sentinel formatter: pins the last-event line to next-intl's locale-aware
  // formatting (and the options it asks for), not a raw UTC ISO slice.
  useFormatter: () => ({
    dateTime: (value: Date | number, options?: Intl.DateTimeFormatOptions) =>
      `fmt:${new Date(value).toISOString()}:${options?.dateStyle ?? "-"}/${options?.timeStyle ?? "-"}`,
  }),
}))

let mockRows: PluginAnalyticsRow[] | undefined = []

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => mockRows,
}))

jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({
    pluginAnalytics: {
      orderBy: () => ({
        reverse: () => ({ toArray: async () => mockRows }),
      }),
    },
  }),
}))

import { PluginResourceManager, rateWindow } from "./plugin-resource-manager"

const LIMITS = [
  { key: "network:fetch", limit: 60, windowMs: 60_000, burst: 60 },
  { key: "fs:read", limit: 120, windowMs: 60_000 },
]

beforeEach(() => {
  mockRows = [
    {
      pluginId: "alpha",
      key: "network:fetch",
      count: 42,
      lastEventAt: Date.UTC(2026, 4, 21, 14, 30, 45),
    },
  ]
})

describe("rateWindow", () => {
  it("picks the largest whole unit", () => {
    expect(rateWindow(60_000)).toEqual({ unit: "minute", count: 1 })
    expect(rateWindow(90_000)).toEqual({ unit: "second", count: 90 })
    expect(rateWindow(7_200_000)).toEqual({ unit: "hour", count: 2 })
    expect(rateWindow(86_400_000)).toEqual({ unit: "day", count: 1 })
    expect(rateWindow(250)).toEqual({ unit: "millisecond", count: 250 })
  })
})

describe("PluginResourceManager", () => {
  it("phrases each limit as a localized rate, with the burst where known", () => {
    render(<PluginResourceManager pluginId="alpha" limits={LIMITS} />)
    expect(screen.getByText("network:fetch")).toBeInTheDocument()
    expect(
      screen.getByText(
        'rateWithBurst:{"rate":"rate.minute:{\\"limit\\":60,\\"count\\":1}","burst":60}'
      )
    ).toBeInTheDocument()
    expect(screen.getByText('rate.minute:{"limit":120,"count":1}')).toBeInTheDocument()
  })

  it("reads a zero window as a total that never refills", () => {
    render(
      <PluginResourceManager pluginId="alpha" limits={[{ key: "x", limit: 5, windowMs: 0 }]} />
    )
    expect(screen.getByText('rate.total:{"limit":5}')).toBeInTheDocument()
  })

  it("labels the analytics counter as an all-time count and draws no usage bar", () => {
    const { container } = render(<PluginResourceManager pluginId="alpha" limits={LIMITS} />)
    expect(screen.getByText(/recorded:\{"count":42\}/)).toBeInTheDocument()
    // No "used / limit" comparison of an all-time total against a window.
    expect(container.textContent).not.toMatch(/\d+ \/ \d+/)
    expect(container.querySelector("[role='progressbar']")).toBeNull()
    expect(screen.getByText("note")).toBeInTheDocument()
  })

  it("shows a placeholder, not a zero, until analytics load", () => {
    mockRows = undefined
    const { container } = render(<PluginResourceManager pluginId="alpha" limits={LIMITS} />)
    expect(screen.getByTestId("rate-usage-loading-network:fetch")).toBeInTheDocument()
    // One announcement for the list, not one per skeleton.
    expect(screen.getByRole("status")).toHaveTextContent("loadingUsage")
    expect(screen.getByRole("list", { name: "title" })).toHaveAttribute("aria-busy", "true")
    const list = screen.getByRole("list", { name: "title" })
    expect(list.textContent).not.toContain("recorded")
    expect(list.textContent).not.toMatch(/\b0\b/)
    expect(container.querySelectorAll("time")).toHaveLength(0)
  })

  it("renders the last event time through the next-intl formatter, only where one exists", () => {
    const { container } = render(<PluginResourceManager pluginId="alpha" limits={LIMITS} />)
    const time = screen.getByText("fmt:2026-05-21T14:30:45.000Z:medium/medium")
    expect(time.tagName).toBe("TIME")
    expect(time).toHaveAttribute("dateTime", "2026-05-21T14:30:45.000Z")
    // fs:read has no analytics row, so it gets no count or time line.
    expect(container.querySelectorAll("time")).toHaveLength(1)
  })

  it("answers to its own container width", () => {
    render(<PluginResourceManager pluginId="alpha" limits={LIMITS} />)
    expect(screen.getByTestId("plugin-resource-manager")).toHaveClass("@container")
  })
})
