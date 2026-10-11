/**
 * @jest-environment jsdom
 */

import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { DEFAULT_GLANCE_PANEL_SETTINGS } from "@/lib/glance/presets"
import type { GlanceRequestBody } from "@/lib/glance/requests"
import {
  GLANCE_SNAPSHOT_VERSION,
  type GlanceActivityDay,
  type GlanceActivitySlice,
  type GlanceSnapshotV1,
} from "@/lib/glance/snapshot"
import type { GlanceActivityRange, GlanceWidthStep } from "@/types/glance/layout"

import { GlanceProvider, type GlanceContextValue, type GlancePlatform } from "../glance-context"
import { GlanceActivityModule, heatmapCellSize } from "./glance-activity-module"

const NOW = 1_700_000_000_000

function makeDays(count: number): GlanceActivityDay[] {
  return Array.from({ length: count }, (_, i) => {
    const date = new Date(Date.UTC(2026, 6, 1 + i))
    return {
      day: date.toISOString().slice(0, 10),
      tokens: i * 100,
      level: (i % 5) as GlanceActivityDay["level"],
    }
  })
}

function makeActivity(overrides: Partial<GlanceActivitySlice> = {}): GlanceActivitySlice {
  return {
    updatedAt: NOW,
    range: "3m",
    days: makeDays(91),
    activeDays: 12,
    currentStreak: 5,
    longestStreak: 9,
    peakHour: 14,
    ...overrides,
  }
}

function makeSnapshot(activity: GlanceActivitySlice | null): GlanceSnapshotV1 {
  return {
    version: GLANCE_SNAPSHOT_VERSION,
    epoch: 1,
    revision: 1,
    generatedAt: NOW,
    config: DEFAULT_GLANCE_PANEL_SETTINGS,
    workspace: null,
    when: {} as GlanceSnapshotV1["when"],
    actions: [],
    fleet: null,
    usage: null,
    quota: null,
    agenda: null,
    activity,
    recents: null,
    pet: null,
  }
}

function setup(
  activity: GlanceActivitySlice | null,
  size: "compact" | "standard" | "expanded" = "standard",
  env: { width?: GlanceWidthStep; platform?: GlancePlatform } = {}
) {
  const route = jest.fn<void, [GlanceRequestBody]>()
  const send = jest.fn<Promise<string | null>, [GlanceRequestBody]>(async () => null)
  const value: GlanceContextValue = {
    snapshot: makeSnapshot(activity),
    platform: env.platform ?? "desktop",
    width: env.width ?? "standard",
    now: NOW,
    send,
    route,
  }
  const utils = render(
    <GlanceProvider value={value}>
      <GlanceActivityModule size={size} />
    </GlanceProvider>
  )
  return { ...utils, route, send, user: userEvent.setup() }
}

function cells(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>("i"))
}

describe("heatmapCellSize", () => {
  it("fits the columns into the available width, minus the gaps", () => {
    // (352 - 12 * 2) / 13 = 25.2 -> 25, capped at the max
    expect(heatmapCellSize(13, 352, 100)).toBe(25)
    expect(heatmapCellSize(53, 352, 100)).toBe(4)
  })

  it("never exceeds the max", () => {
    expect(heatmapCellSize(13, 352, 11)).toBe(11)
    expect(heatmapCellSize(1, 1000, 14)).toBe(14)
  })

  it("never drops below 3px even when the columns do not fit", () => {
    expect(heatmapCellSize(200, 100, 11)).toBe(3)
    expect(heatmapCellSize(10, -50, 11)).toBe(3)
  })
})

describe("GlanceActivityModule", () => {
  it("shows a loading line while the slice is null", () => {
    setup(null)
    expect(screen.getByText("Reading activity…")).toBeInTheDocument()
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
  })

  describe("compact", () => {
    it("shows the last 28 days as a strip with the streak", () => {
      const { container } = setup(makeActivity(), "compact")
      expect(cells(container)).toHaveLength(28)
      expect(screen.getByText("5 day streak")).toBeInTheDocument()
    })

    it("shows every day when there are fewer than 28", () => {
      const { container } = setup(makeActivity({ days: makeDays(10) }), "compact")
      expect(cells(container)).toHaveLength(10)
    })

    it("says no streak at zero", () => {
      setup(makeActivity({ currentStreak: 0 }), "compact")
      expect(screen.getByText("No streak")).toBeInTheDocument()
    })

    it("routes to the usage page", async () => {
      const { route, user } = setup(makeActivity(), "compact")
      await user.click(screen.getByRole("button", { name: "Open usage" }))
      expect(route).toHaveBeenCalledWith({ kind: "open-owner", owner: "usage" })
    })
  })

  describe("standard", () => {
    it("renders one grid cell per day", () => {
      const { container } = setup(makeActivity({ days: makeDays(91) }))
      expect(cells(container)).toHaveLength(91)
    })

    it("sizes cells from the width step", () => {
      // 380 - 28 padding = 352; 13 columns -> 25, capped at 11 for standard.
      const { container } = setup(makeActivity({ days: makeDays(91) }))
      expect(cells(container)[0]).toHaveStyle({ width: "11px", height: "11px" })
    })

    it("shrinks cells so a year fits a narrow panel", () => {
      // 320 - 28 = 292; 53 columns -> floor((292 - 104) / 53) = 3
      const { container } = setup(makeActivity({ range: "1y", days: makeDays(365) }), "standard", {
        width: "narrow",
      })
      expect(cells(container)[0]).toHaveStyle({ width: "3px", height: "3px" })
    })

    it("lays the grid out in seven rows", () => {
      const { container } = setup(makeActivity())
      const grid = container.querySelector<HTMLElement>("span.grid")
      expect(grid?.style.gridTemplateRows).toBe("repeat(7, 11px)")
    })

    it("uses the phone's width on mobile", () => {
      // 390 - 40 = 350; 13 columns -> 25, capped at 11.
      const { container } = setup(makeActivity(), "standard", {
        platform: "mobile",
        width: "narrow",
      })
      expect(cells(container)[0]).toHaveStyle({ width: "11px" })
    })

    it("titles each cell with its day and tokens", () => {
      const { container } = setup(makeActivity({ days: makeDays(3) }))
      expect(cells(container)[2]).toHaveAttribute("title", expect.stringContaining("200 tokens"))
    })

    it("summarises active days and the current streak", () => {
      setup(makeActivity())
      expect(screen.getByText("12 active days · 5 day streak")).toBeInTheDocument()
    })

    it("does not show the peak hour or longest streak", () => {
      setup(makeActivity())
      expect(screen.queryByText(/Busiest hour/)).not.toBeInTheDocument()
      expect(screen.queryByText(/Longest streak/)).not.toBeInTheDocument()
    })

    it("routes the heatmap to the usage page", async () => {
      const { route, user } = setup(makeActivity())
      await user.click(screen.getByRole("button", { name: "Open usage" }))
      expect(route).toHaveBeenCalledWith({ kind: "open-owner", owner: "usage" })
    })
  })

  describe("range switch", () => {
    it("exposes 1M, 3M and 1Y radios reflecting the current range", () => {
      setup(makeActivity({ range: "3m" }))
      const group = screen.getByRole("radiogroup", { name: "Activity range" })
      expect(within(group).getAllByRole("radio")).toHaveLength(3)
      expect(within(group).getByRole("radio", { name: "3M" })).toBeChecked()
      expect(within(group).getByRole("radio", { name: "1M" })).not.toBeChecked()
      expect(within(group).getByRole("radio", { name: "1Y" })).not.toBeChecked()
    })

    it.each<[string, GlanceActivityRange]>([
      ["1M", "1m"],
      ["1Y", "1y"],
    ])("sends set-activity-range for %s", async (label, range) => {
      const { send, user } = setup(makeActivity({ range: "3m" }))
      await user.click(screen.getByRole("radio", { name: label }))
      expect(send).toHaveBeenCalledWith({ kind: "set-activity-range", range })
    })

    it("does not send when the current range is picked again", async () => {
      const { send, user } = setup(makeActivity({ range: "3m" }))
      await user.click(screen.getByRole("radio", { name: "3M" }))
      expect(send).not.toHaveBeenCalled()
    })
  })

  describe("expanded", () => {
    it("shows the peak hour and longest streak", () => {
      setup(makeActivity({ peakHour: 14, longestStreak: 9 }), "expanded")
      expect(screen.getByText("Busiest hour 14:00")).toBeInTheDocument()
      expect(screen.getByText("Longest streak 9 days")).toBeInTheDocument()
    })

    it("omits the peak hour when unknown but keeps the longest streak", () => {
      setup(makeActivity({ peakHour: null }), "expanded")
      expect(screen.queryByText(/Busiest hour/)).not.toBeInTheDocument()
      expect(screen.getByText(/Longest streak/)).toBeInTheDocument()
    })

    it("shows peak hour zero (midnight) rather than treating it as missing", () => {
      setup(makeActivity({ peakHour: 0 }), "expanded")
      expect(screen.getByText("Busiest hour 0:00")).toBeInTheDocument()
    })

    it("uses larger cells than standard", () => {
      const { container } = setup(makeActivity(), "expanded")
      expect(cells(container)[0]).toHaveStyle({ width: "14px" })
    })
  })
})
