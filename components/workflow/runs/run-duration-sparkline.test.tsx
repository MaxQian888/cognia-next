/**
 * @jest-environment jsdom
 */

import React from "react"
import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

let mockLiveData: Array<{ startedAt: number; duration: number; status: string }> = []
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => mockLiveData,
}))

jest.mock("@/lib/db/schema", () => ({
  getDb: jest.fn(),
}))

jest.mock("recharts", () => {
  const captured: Array<{
    initialDimension?: { width: number; height: number }
    minWidth?: number
    minHeight?: number
  }> = []
  return {
    __captured: captured,
    ResponsiveContainer: ({
      children,
      initialDimension,
      minWidth,
      minHeight,
    }: {
      children: React.ReactNode
      initialDimension?: { width: number; height: number }
      minWidth?: number
      minHeight?: number
    }) => {
      captured.push({ initialDimension, minWidth, minHeight })
      return <div data-testid="duration-chart">{children}</div>
    },
    LineChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    Line: () => null,
    Tooltip: () => null,
    YAxis: () => null,
  }
})

import { RunDurationSparkline } from "./run-duration-sparkline"

const rechartsMock = jest.requireMock("recharts") as {
  __captured: Array<{
    initialDimension?: { width: number; height: number }
    minWidth?: number
    minHeight?: number
  }>
}

beforeEach(() => {
  mockLiveData = []
  rechartsMock.__captured.length = 0
})

describe("RunDurationSparkline", () => {
  it("does not render a chart until two completed runs are available", () => {
    render(<RunDurationSparkline workflowId="workflow-1" />)
    expect(screen.queryByTestId("duration-chart")).not.toBeInTheDocument()
  })

  it("uses non-zero fallback dimensions for the compact chart", () => {
    mockLiveData = [
      { startedAt: 1_000, duration: 100, status: "completed" },
      { startedAt: 2_000, duration: 200, status: "completed" },
    ]

    render(<RunDurationSparkline workflowId="workflow-1" />)

    expect(screen.getByTestId("duration-chart")).toBeInTheDocument()
    expect(rechartsMock.__captured[0]).toEqual({
      initialDimension: { width: 128, height: 32 },
      minWidth: 1,
      minHeight: 1,
    })
  })
})
