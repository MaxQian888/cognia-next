/**
 * @jest-environment node
 */
import { __resetFeatureRegistrationForTesting, registerFeatureCommands } from "./index"
import { __resetForTesting, getCommand } from "./registry"

beforeEach(() => {
  __resetForTesting()
  __resetFeatureRegistrationForTesting()
})

describe("registerFeatureCommands", () => {
  it("adds the Cognia runtime commands to the registry", () => {
    expect(getCommand("goal")).toBeUndefined()
    registerFeatureCommands()
    expect(getCommand("goal")?.category).toBe("cognia")
    expect(getCommand("workflow")).toBeDefined()
    expect(getCommand("wf")?.name).toBe("workflow")
  })

  it("is idempotent (a second call does not throw on duplicates)", () => {
    registerFeatureCommands()
    expect(() => registerFeatureCommands()).not.toThrow()
  })
})
