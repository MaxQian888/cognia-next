import { presenceFailure } from "./vault-errors"

describe("presenceFailure", () => {
  it.each([
    ["user_presence_denied", "denied"],
    ["reveal refused: user_presence_unavailable", "unavailable"],
    [new Error("user_presence_cancelled"), "cancelled"],
    [new Error("user_presence_failed: pkcheck exited 3"), "failed"],
    ["user_presence: LAContext error", "failed"],
  ] as const)("maps %p to %p", (error, expected) => {
    expect(presenceFailure(error)).toBe(expected)
  })

  it.each([new Error("credential_not_found"), "boom", null, { message: "user_presence_denied" }])(
    "returns null for non-presence error %p",
    (error) => {
      expect(presenceFailure(error)).toBeNull()
    }
  )
})
