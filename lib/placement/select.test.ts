import { selectPlacement } from "./select"
import { PlacementWaitingError, type PlacementCandidate } from "./types"

const NOW = 1_000_000

function candidate(overrides: Partial<PlacementCandidate> = {}): PlacementCandidate {
  return {
    ref: "device:a",
    kind: "worker",
    liveness: { online: true, lastSeenAt: NOW, source: "socket" },
    provides: [],
    activeUnits: 0,
    maxUnits: 2,
    ...overrides,
  }
}

describe("selectPlacement", () => {
  it("fills the least loaded candidate first", () => {
    const picked = selectPlacement(
      [
        candidate({ ref: "device:a", activeUnits: 2, maxUnits: 4 }),
        candidate({ ref: "device:b", activeUnits: 1, maxUnits: 4 }),
      ],
      { mode: "auto" },
      [],
      NOW
    )
    expect(picked.candidate.ref).toBe("device:b")
  })

  it("breaks a tie the same way on every host", () => {
    // Two hosts resolving the same placement at the same instant must reach the
    // same answer; a random or insertion-order tiebreak has them each pick a
    // different target and both believe they won.
    const forward = selectPlacement(
      [candidate({ ref: "device:b" }), candidate({ ref: "device:a" })],
      { mode: "auto" },
      [],
      NOW
    )
    const reverse = selectPlacement(
      [candidate({ ref: "device:a" }), candidate({ ref: "device:b" })],
      { mode: "auto" },
      [],
      NOW
    )
    expect(forward.candidate.ref).toBe("device:a")
    expect(reverse.candidate.ref).toBe("device:a")
  })

  it("waits rather than failing when nothing has capacity", () => {
    // "Come back in a moment" and "this will never work" are different answers,
    // and collapsing them turns a transient condition into a failed run.
    expect(() =>
      selectPlacement([candidate({ activeUnits: 2, maxUnits: 2 })], { mode: "auto" }, [], NOW)
    ).toThrow(PlacementWaitingError)
  })

  it("reports why a pinned target is unavailable", () => {
    const offline = candidate({
      ref: "device:pin",
      liveness: { online: false, lastSeenAt: NOW, source: "socket" },
    })
    try {
      selectPlacement([offline], { mode: "pinned", ref: "device:pin" }, [], NOW)
      throw new Error("expected a waiting error")
    } catch (error) {
      expect(error).toBeInstanceOf(PlacementWaitingError)
      expect(error).toMatchObject({
        waiting: "pinned_candidate_unavailable",
        ref: "device:pin",
        reason: "offline",
      })
    }
  })

  it("separates a pinned target that is absent from one that is incompatible", () => {
    expect(() =>
      selectPlacement([candidate({ ref: "device:a" })], { mode: "pinned", ref: "ghost" }, [], NOW)
    ).toThrow(/unavailable: ghost/)

    try {
      selectPlacement(
        [candidate({ ref: "device:a", provides: [] })],
        { mode: "pinned", ref: "device:a" },
        [{ dimension: "agent", value: "tools" }],
        NOW
      )
      throw new Error("expected a waiting error")
    } catch (error) {
      expect(error).toMatchObject({
        waiting: "no_compatible_capacity",
        reason: "capability_mismatch",
      })
    }
  })

  it("colocates on the local candidate and never wanders to a remote one", () => {
    // `colocate` is the zero-configuration default and must behave exactly as
    // it did before placement existed: here, or nowhere.
    const picked = selectPlacement(
      [
        candidate({ ref: "device:remote" }),
        candidate({
          ref: "local",
          kind: "local",
          liveness: { online: true, lastSeenAt: NOW, source: "local" },
          maxUnits: Number.POSITIVE_INFINITY,
        }),
      ],
      { mode: "colocate" },
      [],
      NOW
    )
    expect(picked.candidate.ref).toBe("local")

    expect(() =>
      selectPlacement([candidate({ ref: "device:remote" })], { mode: "colocate" }, [], NOW)
    ).toThrow(PlacementWaitingError)
  })

  it("returns every verdict considered so the audit can explain the choice", () => {
    const selection = selectPlacement(
      [
        candidate({ ref: "device:a", provides: [] }),
        candidate({ ref: "device:b", provides: [{ dimension: "agent", value: "tools" }] }),
      ],
      { mode: "auto" },
      [{ dimension: "agent", value: "tools" }],
      NOW
    )
    expect(selection.candidate.ref).toBe("device:b")
    expect(selection.considered).toEqual([
      { ref: "device:a", verdict: expect.objectContaining({ reason: "capability_mismatch" }) },
      { ref: "device:b", verdict: { ready: true } },
    ])
  })

  it("lets a caller with a richer vocabulary keep its own verdicts", () => {
    // An execution worker reports which of runtime / model / deployment failed,
    // and those reasons are persisted — flattening them into the generic
    // vocabulary would rewrite history. Ordering and the tiebreak are still
    // shared, which is where the real duplication risk lives.
    const selection = selectPlacement(
      [
        candidate({ ref: "device:b", activeUnits: 1 }),
        candidate({ ref: "device:a", activeUnits: 0 }),
      ],
      { mode: "auto" },
      [],
      NOW,
      {
        evaluate: (target) =>
          target.ref === "device:a"
            ? { ready: false, reason: "capability_mismatch" }
            : { ready: true },
      }
    )
    expect(selection.candidate.ref).toBe("device:b")
    expect(selection.considered).toContainEqual({
      ref: "device:a",
      verdict: { ready: false, reason: "capability_mismatch" },
    })
  })
})
