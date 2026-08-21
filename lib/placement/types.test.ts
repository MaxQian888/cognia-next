import { PlacementWaitingError } from "./types"

describe("PlacementWaitingError", () => {
  it("describes an unavailable pinned candidate and exposes its diagnostics", () => {
    const error = new PlacementWaitingError(
      "pinned_candidate_unavailable",
      "device:offline",
      "offline"
    )

    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe("PlacementWaitingError")
    expect(error.message).toBe("Pinned placement target is unavailable: device:offline")
    expect(error).toMatchObject({
      waiting: "pinned_candidate_unavailable",
      ref: "device:offline",
      reason: "offline",
    })
  })

  it("uses the capacity message without inventing a candidate reference", () => {
    const error = new PlacementWaitingError("no_compatible_capacity")

    expect(error.name).toBe("PlacementWaitingError")
    expect(error.message).toBe("No compatible placement target has available capacity")
    expect(error).toMatchObject({
      waiting: "no_compatible_capacity",
      ref: undefined,
      reason: undefined,
    })
  })
})
