import { DEVICE_GRANT_IDS } from "./grant-capabilities"
import { placementKindFor } from "./placement-directory"
import type { DeviceGrantId, DeviceKind } from "./types"
import type { PlacementCandidateKind } from "@/lib/placement/types"

/**
 * The invariant the whole console rests on: a device row and a placement
 * candidate name the same thing. If `PlacementCandidateKind` ever gains a
 * member (a new kind of machine that can run work) this fails to compile,
 * which is the point — a console that silently cannot show one kind of
 * candidate is worse than one that will not build.
 */
type AssertEqual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never
const KINDS_MATCH: AssertEqual<DeviceKind, PlacementCandidateKind> = true

const ALL_KINDS: readonly DeviceKind[] = ["local", "paired-device", "remote-host", "worker"]

describe("DeviceKind", () => {
  it("is exactly PlacementCandidateKind", () => {
    expect(KINDS_MATCH).toBe(true)
  })

  it("round-trips every member through the placement projection", () => {
    for (const kind of ALL_KINDS) {
      expect(placementKindFor(kind)).toBe(kind)
    }
  })
})

describe("DeviceGrantId", () => {
  /**
   * Three of these mirror `GrantKind` in `device_grants.rs`; the fourth,
   * Locked Use, is a separate allow list with no SecurityStore capability.
   * Pinning the list here means adding a grant forces a decision about both.
   */
  it("covers every grant the Access surface can show", () => {
    const expected: readonly DeviceGrantId[] = [
      "control",
      "agentControl",
      "terminal",
      "lockedComputerUse",
    ]
    expect(DEVICE_GRANT_IDS).toEqual(expected)
  })
})
