import type { TransportTier } from "@/lib/tauri/transport-companion"

import {
  TRANSPORT_TIER_ORDER,
  TRANSPORT_TIER_TONES,
  transportTierTone,
} from "./transport-tier-visuals"

const TIERS: TransportTier[] = ["rtc-direct", "rtc-relay", "ws-lan", "ws-tunnel", "offline"]

describe("transport tier visuals", () => {
  it("covers every tier with all three shapes", () => {
    for (const tier of TIERS) {
      const tone = TRANSPORT_TIER_TONES[tier]
      expect(tone.text).toMatch(/^text-/)
      expect(tone.dot).toMatch(/^fill-/)
      expect(tone.chip).toMatch(/^border-/)
    }
    expect(TRANSPORT_TIER_ORDER).toHaveLength(TIERS.length)
    expect([...TRANSPORT_TIER_ORDER].sort()).toEqual([...TIERS].sort())
  })

  /**
   * The drift this module ends: the `/me` row painted a TURN relay emerald
   * while the pill and the diagnostics sheet painted it amber. A relay is a
   * working-but-degraded path and must read as one everywhere.
   */
  it("reads a relay as degraded, not as the best case", () => {
    expect(TRANSPORT_TIER_TONES["rtc-relay"].dot).not.toBe(TRANSPORT_TIER_TONES["rtc-direct"].dot)
    expect(TRANSPORT_TIER_TONES["rtc-relay"].text).toContain("amber")
  })

  it("falls back to the offline tone for an unknown tier", () => {
    expect(transportTierTone("nonsense" as TransportTier)).toBe(TRANSPORT_TIER_TONES.offline)
  })
})
