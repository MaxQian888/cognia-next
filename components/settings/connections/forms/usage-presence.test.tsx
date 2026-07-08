/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { UsagePresence, parseUserIdLines } from "./usage-presence"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"

const syncMock = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/connectors/presence/usage-status-runner", () => ({
  syncUsagePresenceSchedule: (...a: unknown[]) => syncMock(...a),
}))

beforeEach(async () => {
  syncMock.mockClear()
  await getDb().delete()
  __resetDbForTesting()
})

const baseRow = (overrides: Partial<AdapterInstanceRow> = {}): AdapterInstanceRow => ({
  id: "ad-up",
  type: "lark",
  displayName: "Lark",
  enabled: true,
  transportMode: "webhook",
  settings: {},
  credentialsRef: { keyringService: "com.cognia.platforms", accounts: [] },
  trigger: { rules: [{ kind: "private-default" }], blockers: [], storeUnmatchedInDraftMode: false },
  defaultMode: "auto",
  createdAt: 0,
  updatedAt: 0,
  ...overrides,
})

describe("parseUserIdLines", () => {
  it("trims, drops blanks, and splits on newlines", () => {
    expect(parseUserIdLines(" ou_1 \n\n ou_2 ")).toEqual(["ou_1", "ou_2"])
  })
})

describe("UsagePresence", () => {
  it("renders disabled by default and hides detail fields", async () => {
    await getDb().adapterInstances.put(baseRow())
    render(<UsagePresence adapterId="ad-up" />)
    await waitFor(() => {
      expect(screen.getByTestId("usage-presence-enabled")).toHaveAttribute(
        "data-state",
        "unchecked"
      )
    })
    expect(screen.queryByTestId("usage-presence-mode")).toBeNull()
  })

  it("enabling persists the config and reconciles the schedule", async () => {
    await getDb().adapterInstances.put(baseRow())
    render(<UsagePresence adapterId="ad-up" />)
    await waitFor(() => screen.getByTestId("usage-presence-enabled"))
    fireEvent.click(screen.getByTestId("usage-presence-enabled"))
    await waitFor(async () => {
      const row = await getDb().adapterInstances.get("ad-up")
      expect(row?.presence?.enabled).toBe(true)
    })
    expect(syncMock).toHaveBeenCalledWith("ad-up", expect.objectContaining({ enabled: true }))
  })

  it("shows badge targets for a presence-capable platform in badge mode", async () => {
    await getDb().adapterInstances.put(
      baseRow({
        presence: { enabled: true, mode: "badge", intervalMinutes: 5, window: "today" },
      })
    )
    render(<UsagePresence adapterId="ad-up" />)
    await waitFor(() => screen.getByTestId("usage-presence-targets"))
    expect(screen.queryByTestId("usage-presence-conversation")).toBeNull()
  })

  it("persists badge targets on blur", async () => {
    await getDb().adapterInstances.put(
      baseRow({
        presence: { enabled: true, mode: "badge", intervalMinutes: 5, window: "today" },
      })
    )
    render(<UsagePresence adapterId="ad-up" />)
    const targets = await screen.findByTestId("usage-presence-targets")
    fireEvent.change(targets, { target: { value: "ou_1\nou_2" } })
    fireEvent.blur(targets)
    await waitFor(async () => {
      const row = await getDb().adapterInstances.get("ad-up")
      expect(row?.presence?.targetUserIds).toEqual(["ou_1", "ou_2"])
    })
  })

  it("hides the badge tier on platforms without presence.status (telegram)", async () => {
    await getDb().adapterInstances.put(
      baseRow({
        type: "telegram",
        presence: { enabled: true, mode: "badge", intervalMinutes: 5, window: "today" },
      })
    )
    render(<UsagePresence adapterId="ad-up" />)
    await waitFor(() => screen.getByTestId("usage-presence-mode"))
    expect(screen.queryByTestId("usage-presence-targets")).toBeNull()
  })

  it("shows the card conversation field and persists it on blur", async () => {
    await getDb().adapterInstances.put(
      baseRow({
        presence: { enabled: true, mode: "card", intervalMinutes: 5, window: "today" },
      })
    )
    render(<UsagePresence adapterId="ad-up" />)
    const input = await screen.findByTestId("usage-presence-conversation")
    fireEvent.change(input, { target: { value: "lark:ad-up:oc_1" } })
    fireEvent.blur(input)
    await waitFor(async () => {
      const row = await getDb().adapterInstances.get("ad-up")
      expect(row?.presence?.cardConversationKey).toBe("lark:ad-up:oc_1")
    })
  })

  it("surfaces the last refresh error", async () => {
    await getDb().adapterInstances.put(
      baseRow({
        presence: { enabled: true, mode: "badge", intervalMinutes: 5, window: "today" },
        presenceState: { lastError: "badge: boom" },
      })
    )
    render(<UsagePresence adapterId="ad-up" />)
    await waitFor(() => {
      expect(screen.getByTestId("usage-presence-error").textContent).toContain("badge: boom")
    })
  })

  it("clamps the interval input to ≥1 and persists", async () => {
    await getDb().adapterInstances.put(
      baseRow({
        presence: { enabled: true, mode: "badge", intervalMinutes: 5, window: "today" },
      })
    )
    render(<UsagePresence adapterId="ad-up" />)
    const interval = await screen.findByTestId("usage-presence-interval")
    fireEvent.change(interval, { target: { value: "0" } })
    await waitFor(async () => {
      const row = await getDb().adapterInstances.get("ad-up")
      expect(row?.presence?.intervalMinutes).toBe(1)
    })
  })
})
