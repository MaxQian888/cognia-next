/**
 * Tests the inbox / connector suppression branch added to
 * `resolveSendOptions` in §B of the IM completion plan. Focused on the
 * gate semantics — the rest of the resolver is exercised by the existing
 * `build-options.test.ts` suite.
 *
 * Why a separate file: the gate's only job is to read `ctx.inboxPolicy`
 * and stamp `opts.suppressedReason`. Co-locating the cases keeps the
 * blast radius small if either side of that contract changes.
 */

import { resolveSendOptions } from "./build-options"

// Mock minimal deps the resolver pulls in. None of the code paths
// exercised below touch characters, skills, MCP, or routing — but the
// resolver imports them eagerly, so we stub them to no-op.
jest.mock("@/lib/db/characters", () => ({
  getCharacter: jest.fn(async () => null),
  listCharactersByIds: jest.fn(async () => []),
}))
jest.mock("@/lib/db/skills", () => ({
  listEnabledSkillsByIds: jest.fn(async () => []),
  recordSkillUsage: jest.fn(async () => undefined),
  renderSkillsSection: jest.fn(() => ""),
}))
jest.mock("@/lib/db/mcp-servers", () => ({
  buildMcpServerMap: jest.fn(() => ({})),
  listEnabledMcpServers: jest.fn(async () => []),
}))
jest.mock("@/lib/db/teams", () => ({
  getTeam: jest.fn(async () => null),
}))

// Fix Date.now so the cross-midnight quiet-hours assertion is deterministic.
const FIXED_NOW = Date.UTC(2026, 4, 15, 22, 30, 0) // 2026-05-15 22:30:00Z

describe("resolveSendOptions — inbox suppression gate", () => {
  beforeEach(() => {
    jest.useFakeTimers()
    jest.setSystemTime(FIXED_NOW)
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it("returns no suppressedReason when inboxPolicy is omitted (direct chat)", async () => {
    const opts = await resolveSendOptions({})
    expect(opts.suppressedReason).toBeUndefined()
  })

  it("returns no suppressedReason when inboxPolicy is null (explicit opt-out)", async () => {
    const opts = await resolveSendOptions({ inboxPolicy: null })
    expect(opts.suppressedReason).toBeUndefined()
  })

  it("returns no suppressedReason when policy fields are all empty", async () => {
    const opts = await resolveSendOptions({ inboxPolicy: {} })
    expect(opts.suppressedReason).toBeUndefined()
  })

  it("forces manual_mode_override before checking other gates", async () => {
    // Even with a muted adapter inside its quiet window, manual wins —
    // the user has taken the wheel.
    const opts = await resolveSendOptions({
      inboxPolicy: {
        forcedMode: "manual",
        muted: true,
        quietHours: { from: "00:00", to: "23:59", tz: "UTC" },
      },
    })
    expect(opts.suppressedReason).toBe("manual_mode_override")
  })

  it("does not force suppression for forcedMode auto or draft", async () => {
    const auto = await resolveSendOptions({ inboxPolicy: { forcedMode: "auto" } })
    expect(auto.suppressedReason).toBeUndefined()
    const draft = await resolveSendOptions({ inboxPolicy: { forcedMode: "draft" } })
    expect(draft.suppressedReason).toBeUndefined()
  })

  it("returns muted when adapter is muted (and not in manual)", async () => {
    const opts = await resolveSendOptions({
      inboxPolicy: {
        muted: true,
        quietHours: { from: "00:00", to: "23:59", tz: "UTC" },
      },
    })
    expect(opts.suppressedReason).toBe("muted")
  })

  it("returns quiet_hours when wall-clock is inside same-day window", async () => {
    // FIXED_NOW = 22:30 UTC. Window 09:00–23:00 UTC contains it.
    const opts = await resolveSendOptions({
      inboxPolicy: {
        quietHours: { from: "09:00", to: "23:00", tz: "UTC" },
      },
    })
    expect(opts.suppressedReason).toBe("quiet_hours")
  })

  it("does not stamp quiet_hours when wall-clock is outside the window", async () => {
    // FIXED_NOW = 22:30 UTC. Window 09:00–17:00 UTC is fully past.
    const opts = await resolveSendOptions({
      inboxPolicy: {
        quietHours: { from: "09:00", to: "17:00", tz: "UTC" },
      },
    })
    expect(opts.suppressedReason).toBeUndefined()
  })

  it("handles cross-midnight quiet windows (22:00–06:00 in UTC)", async () => {
    // FIXED_NOW = 22:30 UTC. Window 22:00–06:00 wraps midnight; we are inside.
    const inside = await resolveSendOptions({
      inboxPolicy: { quietHours: { from: "22:00", to: "06:00", tz: "UTC" } },
    })
    expect(inside.suppressedReason).toBe("quiet_hours")

    // Now move to 12:00 UTC — outside that window.
    jest.setSystemTime(Date.UTC(2026, 4, 15, 12, 0, 0))
    const outside = await resolveSendOptions({
      inboxPolicy: { quietHours: { from: "22:00", to: "06:00", tz: "UTC" } },
    })
    expect(outside.suppressedReason).toBeUndefined()
  })

  it("evaluates quiet hours in the adapter's tz, not UTC", async () => {
    // FIXED_NOW = 22:30 UTC = 18:30 America/New_York (EDT = UTC-4 in
    // mid-May). Window 18:00–19:00 NY-time should hit.
    const opts = await resolveSendOptions({
      inboxPolicy: {
        quietHours: { from: "18:00", to: "19:00", tz: "America/New_York" },
      },
    })
    expect(opts.suppressedReason).toBe("quiet_hours")
  })

  it("passes through context fields without mutating them", async () => {
    // conversationKey + platformBinding are metadata-only; the resolver
    // does not echo them on opts. Just confirm it doesn't crash and the
    // gate still fires when the policy says so.
    const opts = await resolveSendOptions({
      conversationKey: "telegram:tg-1:42",
      platformBinding: {
        platform: "telegram",
        adapterId: "tg-1",
        conversationKey: "telegram:tg-1:42",
        conversationRef: { platform: "telegram", adapterId: "tg-1", chatId: 42 },
      },
      inboxPolicy: { muted: true },
    })
    expect(opts.suppressedReason).toBe("muted")
  })
})
