/**
 * The dormancy rule that decides whether a paired device costs a permanent WAN
 * socket. Pinned here because both the hub-facing filter and the device console
 * read it, and a divergence between them would have the console describing a
 * connection the desktop is not holding.
 */

import type { PairedDeviceRow } from "@/types/mobile/paired-device"

import {
  WAN_DORMANCY_WINDOW_MS,
  isWanBlocked,
  isWanDormant,
  lastWanEvidenceAt,
  wanIdleForMs,
} from "./wan-dormancy"

const NOW = 1_800_000_000_000
const DAY = 24 * 60 * 60 * 1000

function row(patch: Partial<PairedDeviceRow> = {}): PairedDeviceRow {
  return {
    deviceId: "d1",
    label: "Phone",
    platform: "ios",
    pubkey: "pk",
    appVersion: "1.0.0",
    pairedAt: NOW - DAY,
    lastSeenAt: NOW - DAY,
    allowRemoteTerminal: false,
    ...patch,
  } as PairedDeviceRow
}

describe("WAN_DORMANCY_WINDOW_MS", () => {
  it("is 30 days", () => {
    expect(WAN_DORMANCY_WINDOW_MS).toBe(30 * DAY)
  })
})

describe("lastWanEvidenceAt", () => {
  it("takes the most recent of lastSeenAt and pairedAt", () => {
    expect(lastWanEvidenceAt(row({ lastSeenAt: NOW - 10, pairedAt: NOW - 500 }))).toBe(NOW - 10)
    expect(lastWanEvidenceAt(row({ lastSeenAt: NOW - 500, pairedAt: NOW - 10 }))).toBe(NOW - 10)
  })

  it("falls back to pairedAt so a device that just paired is not born dormant", () => {
    // The pairing flow is itself waiting on the WAN connection, so a row whose
    // verifier has not stamped it yet must still be eligible.
    const justPaired = row({ pairedAt: NOW, lastSeenAt: 0 })
    expect(lastWanEvidenceAt(justPaired)).toBe(NOW)
    expect(isWanDormant(justPaired, NOW)).toBe(false)
  })

  it("returns 0 when neither timestamp is usable", () => {
    expect(
      lastWanEvidenceAt(row({ lastSeenAt: undefined as never, pairedAt: undefined as never }))
    ).toBe(0)
    expect(lastWanEvidenceAt(row({ lastSeenAt: NaN, pairedAt: NaN }))).toBe(0)
    expect(lastWanEvidenceAt(row({ lastSeenAt: -5, pairedAt: -9 }))).toBe(0)
  })
})

describe("wanIdleForMs", () => {
  it("measures the gap since the last evidence", () => {
    expect(wanIdleForMs(row({ lastSeenAt: NOW - 5 * DAY, pairedAt: 0 }), NOW)).toBe(5 * DAY)
  })

  it("clamps a future timestamp to zero rather than reporting negative idle time", () => {
    // A phone with a skewed clock, or a row written across a host's DST jump.
    expect(wanIdleForMs(row({ lastSeenAt: NOW + DAY, pairedAt: 0 }), NOW)).toBe(0)
  })
})

describe("isWanDormant", () => {
  it("keeps a device that spoke inside the window", () => {
    expect(isWanDormant(row({ lastSeenAt: NOW - 29 * DAY, pairedAt: 0 }), NOW)).toBe(false)
  })

  it("holds the boundary open: exactly 30 days idle is still eligible", () => {
    const exactly = row({ lastSeenAt: NOW - WAN_DORMANCY_WINDOW_MS, pairedAt: 0 })
    expect(isWanDormant(exactly, NOW)).toBe(false)
    expect(
      isWanDormant(row({ lastSeenAt: NOW - WAN_DORMANCY_WINDOW_MS - 1, pairedAt: 0 }), NOW)
    ).toBe(true)
  })

  it("marks a device silent past the window as dormant", () => {
    expect(isWanDormant(row({ lastSeenAt: NOW - 90 * DAY, pairedAt: NOW - 200 * DAY }), NOW)).toBe(
      true
    )
  })

  it("treats a row with no evidence at all as dormant, whatever the clock reads", () => {
    // Absence of evidence is not evidence of activity. The manual wake is the
    // recovery path, and the row itself is never touched. Pinned against a
    // small clock too, so the answer cannot come from `now` happening to sit
    // far enough past the epoch.
    const blank = row({ lastSeenAt: 0, pairedAt: 0 })
    expect(isWanDormant(blank, NOW)).toBe(true)
    expect(isWanDormant(blank, 10_000_000)).toBe(true)
  })

  it("accepts an explicit window so the boundary is testable without simulating a month", () => {
    const idleTwoDays = row({ lastSeenAt: NOW - 2 * DAY, pairedAt: 0 })
    expect(isWanDormant(idleTwoDays, NOW, DAY)).toBe(true)
    expect(isWanDormant(idleTwoDays, NOW, 3 * DAY)).toBe(false)
  })
})

/**
 * The other half of the shared decision. `selectSignalingDevices` and
 * `buildDeviceWan` both call this, so the console cannot describe a device as
 * connected that the hub push has already dropped.
 */
describe("isWanBlocked", () => {
  it("passes an ordinary active row", () => {
    expect(isWanBlocked(row())).toBe(false)
  })

  it("blocks a paused row", () => {
    expect(isWanBlocked(row({ pausedAt: NOW - DAY }))).toBe(true)
  })

  it("blocks a revoked row", () => {
    expect(isWanBlocked(row({ revokedAt: NOW - DAY }))).toBe(true)
  })

  it("reads a zero timestamp as blocked, not as absent", () => {
    // `!row.pausedAt` would call the epoch "not paused". Every other consumer
    // (`mirrorAdminState`, `roster.ts`, `mobile.ts`) tests for `undefined`, and
    // this is the predicate they all have to agree with.
    expect(isWanBlocked(row({ pausedAt: 0 }))).toBe(true)
    expect(isWanBlocked(row({ revokedAt: 0 }))).toBe(true)
  })
})
