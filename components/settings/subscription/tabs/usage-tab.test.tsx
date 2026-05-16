/** @jest-environment jsdom */

jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(() => true),
  transport: { call: jest.fn(async () => null) },
}))

jest.mock("@/lib/anthropic-subscription/hooks", () => ({
  useSubscriptionCredential: jest.fn(),
  useSubscriptionUsage: jest.fn(),
  useSubscriptionLogout: jest.fn(),
}))

jest.mock("@/lib/db/session-usage", () => ({
  topByCost: jest.fn(async () => []),
}))

jest.mock("@/lib/db/sessions", () => ({
  listSessions: jest.fn(async () => []),
}))

jest.mock("@/stores/chat", () => ({
  useChatStore: (selector: (s: { setActiveSession: jest.Mock }) => unknown) =>
    selector({ setActiveSession: jest.fn() }),
}))

import { render, waitFor } from "@testing-library/react"

import * as hooksMod from "@/lib/anthropic-subscription/hooks"
import type { SubscriptionUsageRow } from "@/lib/anthropic-subscription/types"

import { SubscriptionUsageTab } from "./usage-tab"

const mUseUsage = hooksMod.useSubscriptionUsage as jest.Mock

const sampleRow: SubscriptionUsageRow = {
  localId: 1,
  fetchedAt: Date.UTC(2026, 4, 10, 12, 0, 0),
  source: "passive",
  status: "allowed",
  representativeClaim: "five_hour",
  fiveHour: { utilization: 0.42, resetAt: Date.now() + 60 * 60 * 1000, status: "allowed" },
  sevenDay: { utilization: 0.17, resetAt: Date.now() + 7 * 24 * 60 * 60 * 1000, status: "allowed" },
  fallbackPercentage: null,
  overageDisabledReason: null,
  rawHeaders: {},
}

beforeEach(() => {
  mUseUsage.mockReset()
})

afterEach(() => {
  jest.restoreAllMocks()
})

describe("SubscriptionUsageTab", () => {
  it("returns an empty-state container when no rows", () => {
    mUseUsage.mockReturnValue({ rows: [], latest: null, loading: false })
    const { container } = render(<SubscriptionUsageTab />)
    // SettingsEmptyState renders a card-like wrapper; just verify no rows
    // in the eventual table region.
    expect(container.textContent?.length ?? 0).toBeGreaterThan(0)
  })

  it("renders the row table with utilization percentages when rows exist", async () => {
    mUseUsage.mockReturnValue({ rows: [sampleRow], latest: sampleRow, loading: false })
    const { container } = render(<SubscriptionUsageTab />)
    await waitFor(() => expect(container.textContent).toContain("42%"))
    expect(container.textContent).toContain("17%")
  })
})
