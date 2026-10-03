/**
 * @jest-environment jsdom
 */

import { act, renderHook } from "@testing-library/react"

import { useSessionSummaryCardPrefs } from "./use-session-summary-card-prefs"
import { useSettingsStore } from "@/stores/settings/settings-store"
import {
  DEFAULT_SUMMARY_CARD_ROWS,
  type SessionSummaryCardSettings,
} from "@/types/shell/session-summary-card"

const saveMock = jest.fn(async (_patch?: { sessionSummaryCard?: SessionSummaryCardSettings }) => {})

function setStored(sessionSummaryCard?: SessionSummaryCardSettings) {
  useSettingsStore.setState({
    settings: { sessionSummaryCard } as never,
    save: saveMock as never,
  })
}

beforeEach(() => {
  saveMock.mockClear()
  setStored(undefined)
})

it("resolves the shipped rows when nothing is stored", () => {
  const { result } = renderHook(() => useSessionSummaryCardPrefs())
  expect(result.current.rows).toEqual(DEFAULT_SUMMARY_CARD_ROWS)
  expect(result.current.isDefault).toBe(true)
})

it("reads stored rows over the defaults", () => {
  setStored({ rows: { changes: "never" } })
  const { result } = renderHook(() => useSessionSummaryCardPrefs())
  expect(result.current.rows.changes).toBe("never")
  expect(result.current.rows.sources).toBe("always")
  expect(result.current.isDefault).toBe(false)
})

it("writes one row without dropping the others", async () => {
  setStored({ rows: { changes: "never" } })
  const { result } = renderHook(() => useSessionSummaryCardPrefs())
  await act(() => result.current.setRow("progress", "always"))
  expect(saveMock).toHaveBeenLastCalledWith({
    sessionSummaryCard: { rows: { changes: "never", progress: "always" } },
  })
})

it("resets to the defaults by clearing stored rows", async () => {
  setStored({ rows: { changes: "never" } })
  const { result } = renderHook(() => useSessionSummaryCardPrefs())
  await act(() => result.current.reset())
  expect(saveMock).toHaveBeenLastCalledWith({ sessionSummaryCard: { rows: {} } })
})
