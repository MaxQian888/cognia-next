/**
 * @jest-environment jsdom
 */
import { render } from "@testing-library/react"

import { InboxVisitTracker } from "./inbox-visit-tracker"

const saveMock: jest.Mock<Promise<void>, [Record<string, unknown>]> = jest.fn()
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (s: { save: typeof saveMock }) => unknown) =>
    selector({ save: saveMock }),
}))

beforeEach(() => {
  saveMock.mockReset()
  saveMock.mockResolvedValue(undefined)
})

describe("<InboxVisitTracker />", () => {
  it("bumps lastInboxViewedAt to a timestamp on mount", () => {
    const before = Date.now()
    render(<InboxVisitTracker />)
    const after = Date.now()
    expect(saveMock).toHaveBeenCalledTimes(1)
    const arg = saveMock.mock.calls[0][0] as { lastInboxViewedAt: number }
    expect(arg.lastInboxViewedAt).toBeGreaterThanOrEqual(before)
    expect(arg.lastInboxViewedAt).toBeLessThanOrEqual(after)
  })
})
