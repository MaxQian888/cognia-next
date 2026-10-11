import { renderHook } from "@testing-library/react"

import type { SessionUsageRow } from "@/lib/db/session-usage"
import { activityRangeStart, GLANCE_ACTIVITY_DAYS } from "@/lib/glance/build-activity"
import { localDay } from "@/lib/usage/session-analytics"
import type { GlanceActivityRange, GlanceUsageScope } from "@/types/glance/layout"

jest.mock("dexie-react-hooks", () => ({ useLiveQuery: jest.fn() }))
jest.mock("@/lib/db/schema", () => ({ getDb: jest.fn() }))

import { useLiveQuery } from "dexie-react-hooks"

import { getDb } from "@/lib/db/schema"

import { useGlanceActivity } from "./use-glance-activity"

const useLiveQueryMock = useLiveQuery as unknown as jest.Mock
const getDbMock = getDb as unknown as jest.Mock

const NOW = new Date(2026, 9, 10, 12, 0, 0).getTime()
const HOUR = 3_600_000

function usageRow(
  partial: Partial<SessionUsageRow> & Pick<SessionUsageRow, "messageId">
): SessionUsageRow {
  return {
    sessionId: "s1",
    at: NOW - HOUR,
    inputTokens: 100,
    outputTokens: 50,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    costUsd: 0,
    durationMs: 0,
    ...partial,
  } as SessionUsageRow
}

describe("useGlanceActivity", () => {
  let liveRows: SessionUsageRow[]

  beforeEach(() => {
    jest.clearAllMocks()
    liveRows = []
    useLiveQueryMock.mockImplementation(() => liveRows)
  })

  function render(
    enabled: boolean,
    range: GlanceActivityRange = "1m",
    scope: GlanceUsageScope = "cognia",
    sessionFilter: ReadonlySet<string> | null = null
  ) {
    return renderHook(
      (props: {
        enabled: boolean
        range: GlanceActivityRange
        scope: GlanceUsageScope
        sessionFilter: ReadonlySet<string> | null
      }) => useGlanceActivity(props.enabled, props.range, props.scope, props.sessionFilter, NOW),
      { initialProps: { enabled, range, scope, sessionFilter } }
    )
  }

  describe("disabled", () => {
    it("returns null", () => {
      const { result } = render(false)
      expect(result.current).toBeNull()
    })

    it("returns null even when the live query holds rows", () => {
      liveRows = [usageRow({ messageId: "m1" })]
      const { result } = render(false)
      expect(result.current).toBeNull()
    })

    it("reads nothing from the database", async () => {
      const toArray = jest.fn().mockResolvedValue([])
      getDbMock.mockReturnValue({
        sessionUsage: { where: jest.fn(() => ({ aboveOrEqual: jest.fn(() => ({ toArray })) })) },
      })
      render(false)
      const [querier, , initial] = useLiveQueryMock.mock.calls[0]
      expect(initial).toEqual([])
      await expect(querier()).resolves.toEqual([])
      expect(getDbMock).not.toHaveBeenCalled()
      expect(toArray).not.toHaveBeenCalled()
    })
  })

  describe("query", () => {
    function mockDb(rows: SessionUsageRow[] = []) {
      const toArray = jest.fn().mockResolvedValue(rows)
      const aboveOrEqual = jest.fn(() => ({ toArray }))
      const where = jest.fn(() => ({ aboveOrEqual }))
      getDbMock.mockReturnValue({ sessionUsage: { where } })
      return { where, aboveOrEqual, toArray }
    }

    it("queries sessionUsage over the at index from the start of the range", async () => {
      const db = mockDb([usageRow({ messageId: "m1" })])
      render(true, "3m")
      const [querier] = useLiveQueryMock.mock.calls[0]
      await expect(querier()).resolves.toHaveLength(1)
      expect(db.where).toHaveBeenCalledWith("at")
      expect(db.aboveOrEqual).toHaveBeenCalledWith(activityRangeStart("3m", NOW))
      expect(db.toArray).toHaveBeenCalledTimes(1)
    })

    it.each(["1m", "3m", "1y"] as const)("uses the range start for %s", async (range) => {
      const db = mockDb()
      render(true, range)
      const [querier] = useLiveQueryMock.mock.calls[0]
      await querier()
      expect(db.aboveOrEqual).toHaveBeenCalledWith(activityRangeStart(range, NOW))
    })

    it("keys the live query on enabled and the range's first day, not on now", () => {
      const { rerender } = render(true, "1m")
      const firstDeps = useLiveQueryMock.mock.calls.at(-1)![1]
      expect(firstDeps).toEqual([true, activityRangeStart("1m", NOW)])

      rerender({ enabled: true, range: "1y", scope: "cognia", sessionFilter: null })
      const yearDeps = useLiveQueryMock.mock.calls.at(-1)![1]
      expect(yearDeps).toEqual([true, activityRangeStart("1y", NOW)])
      expect(yearDeps[1]).toBeLessThan(firstDeps[1])
    })

    it("seeds the live query with an empty array", () => {
      render(true)
      expect(useLiveQueryMock.mock.calls[0][2]).toEqual([])
    })
  })

  describe("enabled", () => {
    it("builds a slice for the range with one zero-filled entry per day, ending today", () => {
      const { result } = render(true, "1m")
      expect(result.current).toMatchObject({
        updatedAt: NOW,
        range: "1m",
        activeDays: 0,
        currentStreak: 0,
        longestStreak: 0,
      })
      expect(result.current?.days).toHaveLength(GLANCE_ACTIVITY_DAYS["1m"])
      expect(result.current?.days.at(-1)?.day).toBe(localDay(NOW))
      expect(result.current?.days.every((d) => d.tokens === 0 && d.level === 0)).toBe(true)
    })

    it.each(["1m", "3m", "1y"] as const)("covers %s of days", (range) => {
      const { result } = render(true, range)
      expect(result.current?.days).toHaveLength(GLANCE_ACTIVITY_DAYS[range])
      expect(result.current?.range).toBe(range)
    })

    it("sums input and output tokens into today's cell", () => {
      liveRows = [
        usageRow({ messageId: "m1", inputTokens: 100, outputTokens: 50 }),
        usageRow({ messageId: "m2", inputTokens: 10, outputTokens: 5, at: NOW - 2 * HOUR }),
      ]
      const { result } = render(true)
      const today = result.current?.days.at(-1)
      expect(today?.tokens).toBe(165)
      // A single active day is every quartile at once, so it earns level 1.
      expect(today?.level).toBe(1)
      expect(result.current?.activeDays).toBe(1)
    })

    it("drops rows that predate the range", () => {
      liveRows = [usageRow({ messageId: "old", at: activityRangeStart("1m", NOW) - HOUR })]
      const { result } = render(true, "1m")
      expect(result.current?.activeDays).toBe(0)
      expect(result.current?.days.every((d) => d.tokens === 0)).toBe(true)
    })

    it("excludes external rows under the cognia scope and keeps them for all-tools", () => {
      liveRows = [
        usageRow({ messageId: "own", inputTokens: 10, outputTokens: 0 }),
        usageRow({ messageId: "ext", inputTokens: 1000, outputTokens: 0, sourceId: "claude-code" }),
      ]
      const cognia = render(true, "1m", "cognia")
      expect(cognia.result.current?.days.at(-1)?.tokens).toBe(10)

      const all = render(true, "1m", "all-tools")
      expect(all.result.current?.days.at(-1)?.tokens).toBe(1010)
    })

    it("counts only the filtered sessions when a session filter is given", () => {
      liveRows = [
        usageRow({ messageId: "a", sessionId: "keep", inputTokens: 7, outputTokens: 0 }),
        usageRow({ messageId: "b", sessionId: "drop", inputTokens: 900, outputTokens: 0 }),
      ]
      const { result } = render(true, "1m", "cognia", new Set(["keep"]))
      expect(result.current?.days.at(-1)?.tokens).toBe(7)
    })

    it("yields an empty heatmap for an empty session filter", () => {
      liveRows = [usageRow({ messageId: "a", sessionId: "s1" })]
      const { result } = render(true, "1m", "cognia", new Set())
      expect(result.current?.activeDays).toBe(0)
      expect(result.current?.days.every((d) => d.tokens === 0)).toBe(true)
    })

    it("returns the same slice object while its inputs are unchanged", () => {
      const sessionFilter = new Set(["s1"])
      const { result, rerender } = render(true, "1m", "cognia", sessionFilter)
      const first = result.current
      rerender({ enabled: true, range: "1m", scope: "cognia", sessionFilter })
      expect(result.current).toBe(first)
    })

    it("turns null again when disabled after having been enabled", () => {
      const { result, rerender } = render(true)
      expect(result.current).not.toBeNull()
      rerender({ enabled: false, range: "1m", scope: "cognia", sessionFilter: null })
      expect(result.current).toBeNull()
    })
  })
})
