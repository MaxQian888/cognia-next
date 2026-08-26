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
  mediaModelPolicy: "local_extract_only",
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

  /**
   * The badge tier used to vanish here AND the dropdown was coerced to show
   * "card" — so this row, stored as `badge`, displayed a tier it was not set
   * to, while the runner published nothing. Both halves of that are fixed: the
   * stored mode is shown as stored, and the reason is on screen.
   */
  it("keeps a stored badge tier visible and inert on a platform without presence.status", async () => {
    await getDb().adapterInstances.put(
      baseRow({
        type: "telegram",
        presence: { enabled: true, mode: "badge", intervalMinutes: 5, window: "today" },
      })
    )
    render(<UsagePresence adapterId="ad-up" />)
    await waitFor(() => screen.getByTestId("usage-presence-mode"))
    expect(screen.getByTestId("usage-presence-badge-unavailable")).toHaveAttribute(
      "data-cause",
      "not_declared"
    )
    expect(screen.getByTestId("usage-presence-targets")).toBeDisabled()
  })

  // The stale stored mode is the actionable half: nothing at all is being
  // published, and one press makes the bot publish the tier it can serve.
  it("offers a one-press repair for a mode this bot cannot run", async () => {
    await getDb().adapterInstances.put(
      baseRow({
        type: "telegram",
        presence: { enabled: true, mode: "badge", intervalMinutes: 5, window: "today" },
      })
    )
    render(<UsagePresence adapterId="ad-up" />)
    fireEvent.click(await screen.findByTestId("usage-presence-switch-to-card"))
    await waitFor(async () => {
      const row = await getDb().adapterInstances.get("ad-up")
      expect(row?.presence?.mode).toBe("card")
    })
  })

  // A supported platform whose stored mode does not select the badge tier has
  // nothing stale to repair — only the reason it cannot be chosen.
  it("explains without offering a repair when the stored mode is already reachable", async () => {
    await getDb().adapterInstances.put(
      baseRow({
        type: "telegram",
        presence: { enabled: true, mode: "card", intervalMinutes: 5, window: "today" },
      })
    )
    render(<UsagePresence adapterId="ad-up" />)
    await waitFor(() => screen.getByTestId("usage-presence-badge-unavailable"))
    expect(screen.queryByTestId("usage-presence-switch-to-card")).toBeNull()
  })

  it("names the transport for a webhook-mode Discord bot — presence is a gateway op", async () => {
    // Discord declares presence.status, but `setPresenceStatus` needs the
    // gateway client and throws without one, so a webhook-mode instance could
    // only ever fail. The projection knows; the platform table could not. And
    // unlike Telegram this one IS fixable, which is why the two causes are
    // different sentences.
    await getDb().adapterInstances.put(
      baseRow({
        type: "discord",
        transportMode: "webhook",
        presence: { enabled: true, mode: "badge", intervalMinutes: 5, window: "today" },
      })
    )
    render(<UsagePresence adapterId="ad-up" />)
    await waitFor(() => screen.getByTestId("usage-presence-mode"))
    expect(screen.getByTestId("usage-presence-badge-unavailable")).toHaveAttribute(
      "data-cause",
      "transport_unsupported"
    )
    expect(screen.getByTestId("usage-presence-targets")).toBeDisabled()
  })

  it("shows it, enabled and unexplained, for the same bot on the gateway", async () => {
    await getDb().adapterInstances.put(
      baseRow({
        type: "discord",
        transportMode: "gateway",
        presence: { enabled: true, mode: "badge", intervalMinutes: 5, window: "today" },
      })
    )
    render(<UsagePresence adapterId="ad-up" />)
    expect(await screen.findByTestId("usage-presence-targets")).toBeEnabled()
    expect(screen.queryByTestId("usage-presence-badge-unavailable")).toBeNull()
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
