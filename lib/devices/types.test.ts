import { DEVICE_GRANT_IDS } from "./grant-capabilities"
import { placementKindFor } from "./placement-directory"
import type { DeviceGrantId, DeviceKind } from "./types"
import type { PlacementCandidateKind } from "@/lib/placement/types"

/**
 * The invariant the whole console rests on, in its exact current form: **every
 * placement candidate has a row, but not every row is a candidate.**
 *
 * `DeviceKind` used to equal `PlacementCandidateKind` and `placementKindFor`
 * was the identity function. Adding `ssh-host` broke that on purpose. An SSH
 * box can give you a shell and nothing else, so letting `evaluatePlacement`
 * pick one to run an agent would be a promise the transport cannot keep.
 *
 * The direction that still must hold is one-way containment: if
 * `PlacementCandidateKind` ever gains a member (a new kind of machine that
 * CAN run work) and the console does not, this fails to compile, which is the
 * point — a console that silently cannot show one kind of candidate is worse
 * than one that will not build.
 */
type AssertExtends<A, B> = [A] extends [B] ? true : never
const EVERY_CANDIDATE_HAS_A_ROW: AssertExtends<PlacementCandidateKind, DeviceKind> = true

/** Rows that ARE candidates, and must round-trip unchanged. */
const PLACEABLE_KINDS: readonly DeviceKind[] = ["local", "paired-device", "remote-host", "worker"]

/** Rows the console lists but placement must never choose. */
const UNPLACEABLE_KINDS: readonly DeviceKind[] = ["ssh-host"]

describe("DeviceKind", () => {
  it("covers every placement candidate kind", () => {
    expect(EVERY_CANDIDATE_HAS_A_ROW).toBe(true)
  })

  it("round-trips every placeable member through the placement projection", () => {
    for (const kind of PLACEABLE_KINDS) {
      expect(placementKindFor(kind)).toBe(kind)
    }
  })

  /**
   * The guard that matters. A `null` here is what keeps `deviceCandidates`
   * from handing the resolver a machine that can only open a shell.
   */
  it("refuses to project a row that cannot run work", () => {
    for (const kind of UNPLACEABLE_KINDS) {
      expect(placementKindFor(kind)).toBeNull()
    }
  })

  it("accounts for every member", () => {
    const all: DeviceKind[] = [...PLACEABLE_KINDS, ...UNPLACEABLE_KINDS]
    // A sweep that scanned nothing also passes an emptiness assertion.
    expect(all.length).toBeGreaterThan(0)
    expect(new Set(all).size).toBe(all.length)
  })
})

describe("DeviceGrantId", () => {
  /**
   * Four of these mirror `GrantKind` in `device_grants.rs`. The fifth, Locked
   * Use, is a separate allow list with no SecurityStore capability. Pinning the
   * list here means adding a grant forces a decision about both.
   */
  it("covers every grant the Access surface can show", () => {
    const expected: readonly DeviceGrantId[] = [
      "control",
      "agentControl",
      "terminal",
      "sshFiles",
      "lockedComputerUse",
    ]
    expect(DEVICE_GRANT_IDS).toEqual(expected)
  })
})
