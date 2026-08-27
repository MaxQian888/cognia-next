/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("next-intl", () => ({ useLocale: () => "en" }))

import type { SreHistogramBucket, SreLogPattern } from "../providers/types"
import type { SreRuntime } from "../runtime"
import { createIncident, type SreIncident } from "../incident/model"
import { baselineWindow, coversWindow, LogLens } from "./log-lens"

const WINDOW = { startTime: "2026-08-04T12:02:00.000Z", endTime: "2026-08-04T12:05:20.000Z" }

function bucket(total: number, error = 0): SreHistogramBucket {
  return {
    startTime: `2026-08-04T12:0${total}:00.000Z`,
    endTime: `2026-08-04T12:0${total}:30.000Z`,
    total,
    byLevel: { debug: 0, info: total - error, warn: 0, error },
  }
}

function pattern(overrides: Partial<SreLogPattern> = {}): SreLogPattern {
  return {
    id: "tpl_1",
    template: "gateway provider.timeout provider=<*>",
    count: 184,
    baselineCount: 10,
    changeRatio: 17.4,
    services: ["gateway"],
    levels: ["error"],
    firstSeen: WINDOW.startTime,
    lastSeen: WINDOW.endTime,
    evidenceIds: ["log_003"],
    ...overrides,
  }
}

function runtimeWith(options: {
  buckets?: SreHistogramBucket[]
  patterns?: SreLogPattern[]
  coverage?: { startTime: string; endTime: string } | null
  fail?: Error
}): SreRuntime {
  return {
    provider: () => ({ id: "stub", kind: "fixture", coverage: options.coverage ?? null }),
    histogram: async () => {
      if (options.fail) throw options.fail
      return options.buckets ?? []
    },
    patterns: async () => {
      if (options.fail) throw options.fail
      return options.patterns ?? []
    },
  } as unknown as SreRuntime
}

function incident(): SreIncident {
  return createIncident({
    id: "inc",
    now: "n",
    title: "t",
    environment: "prod",
    window: WINDOW,
  })
}

describe("baselineWindow", () => {
  it("is the window immediately before, of the same length", () => {
    expect(baselineWindow(WINDOW)).toEqual({
      startTime: "2026-08-04T11:58:40.000Z",
      endTime: WINDOW.startTime,
    })
  })
})

describe("coversWindow", () => {
  it("treats an unbounded backend as covering anything", () => {
    expect(coversWindow(null, WINDOW)).toBe(true)
  })

  it("detects a window entirely outside the backend's coverage", () => {
    expect(coversWindow(WINDOW, WINDOW)).toBe(true)
    expect(
      coversWindow(
        { startTime: "2026-08-04T13:00:00.000Z", endTime: "2026-08-04T14:00:00.000Z" },
        WINDOW
      )
    ).toBe(false)
  })
})

describe("LogLens", () => {
  const defaults = {
    incident: incident(),
    wide: false,
    enabled: true,
    pinnedIds: [] as string[],
    onPin: jest.fn(),
  }

  it("reports totals and errors once the backend answers", async () => {
    render(
      <LogLens
        {...defaults}
        runtime={runtimeWith({ buckets: [bucket(4, 1), bucket(6, 2)], patterns: [pattern()] })}
      />
    )
    expect(screen.getByText("Querying…")).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText("10 records")).toBeInTheDocument())
    expect(screen.getByText("3 errors")).toBeInTheDocument()
    expect(screen.getByTestId("sre-lens-histogram").children).toHaveLength(2)
  })

  it("never queries while another panel is in front", () => {
    render(
      <LogLens {...defaults} enabled={false} runtime={runtimeWith({ buckets: [bucket(4)] })} />
    )
    expect(screen.queryByText("Querying…")).not.toBeInTheDocument()
    expect(screen.queryByTestId("sre-lens-histogram")).not.toBeInTheDocument()
  })

  it("labels a template with no baseline as new instead of inventing a ratio", async () => {
    render(
      <LogLens
        {...defaults}
        runtime={runtimeWith({
          patterns: [
            pattern({ id: "a", baselineCount: 0, changeRatio: null }),
            pattern({ id: "b", template: "b", baselineCount: null, changeRatio: null }),
            pattern({ id: "c", template: "c", baselineCount: 10, changeRatio: 17.4 }),
          ],
        })}
      />
    )
    await waitFor(() => expect(screen.getAllByTestId("sre-lens-pattern")).toHaveLength(3))
    expect(screen.getByText("new")).toBeInTheDocument()
    expect(screen.getByText("no baseline")).toBeInTheDocument()
    expect(screen.getByText("+1740%")).toBeInTheDocument()
  })

  it("pins a whole template group, and locks the control once it is pinned", async () => {
    const onPin = jest.fn()
    const { rerender } = render(
      <LogLens
        {...defaults}
        onPin={onPin}
        runtime={runtimeWith({ patterns: [pattern({ evidenceIds: ["log_003", "log_004"] })] })}
      />
    )
    await waitFor(() => expect(screen.getByTestId("sre-lens-pattern")).toBeInTheDocument())
    await userEvent.click(screen.getByRole("button", { name: "Pin group" }))
    expect(onPin).toHaveBeenCalledWith(["log_003", "log_004"])

    rerender(
      <LogLens
        {...defaults}
        onPin={onPin}
        pinnedIds={["log_003", "log_004"]}
        runtime={runtimeWith({ patterns: [pattern({ evidenceIds: ["log_003", "log_004"] })] })}
      />
    )
    await waitFor(() => expect(screen.getByRole("button", { name: "Pinned" })).toBeDisabled())
  })

  it("warns when the window falls outside what the backend holds", async () => {
    render(
      <LogLens
        {...defaults}
        runtime={runtimeWith({
          coverage: { startTime: "2026-08-04T13:00:00.000Z", endTime: "2026-08-04T14:00:00.000Z" },
        })}
      />
    )
    expect(screen.getByTestId("sre-lens-coverage")).toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId("sre-lens-empty")).toBeInTheDocument())
  })

  it("shows the backend's own refusal rather than an empty window", async () => {
    render(
      <LogLens {...defaults} runtime={runtimeWith({ fail: new Error("startTime invalid") })} />
    )
    await waitFor(() =>
      expect(screen.getByTestId("sre-lens-error")).toHaveTextContent("startTime invalid")
    )
  })

  it("offers the widen affordance only while the panel is narrow", async () => {
    const onRequestWide = jest.fn()
    const runtime = runtimeWith({})
    const { rerender } = render(
      <LogLens {...defaults} runtime={runtime} onRequestWide={onRequestWide} />
    )
    await waitFor(() => expect(screen.getByTestId("sre-lens-empty")).toBeInTheDocument())
    await userEvent.click(screen.getByTestId("sre-lens-widen"))
    expect(onRequestWide).toHaveBeenCalledTimes(1)

    rerender(<LogLens {...defaults} wide runtime={runtime} onRequestWide={onRequestWide} />)
    await waitFor(() => expect(screen.queryByTestId("sre-lens-widen")).not.toBeInTheDocument())
  })
})
