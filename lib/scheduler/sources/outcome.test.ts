import { requireSourceOutcome } from "./outcome"

describe("requireSourceOutcome", () => {
  it("turns a backend's 'no' into a rejection", () => {
    expect(() => requireSourceOutcome(false, "could not be paused")).toThrow("could not be paused")
    expect(() => requireSourceOutcome(null, "was not found")).toThrow("was not found")
  })

  it("lets every other answer through, including backends that return nothing", () => {
    expect(() => requireSourceOutcome(true, "x")).not.toThrow()
    expect(() => requireSourceOutcome({ id: "run-1" }, "x")).not.toThrow()
    expect(() => requireSourceOutcome(undefined, "x")).not.toThrow()
    expect(() => requireSourceOutcome(0, "x")).not.toThrow()
  })
})
