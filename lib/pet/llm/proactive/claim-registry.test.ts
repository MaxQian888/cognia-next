import { __resetProactiveClaims, claimKinds, isClaimed, releaseKinds } from "./claim-registry"

afterEach(() => {
  __resetProactiveClaims()
})

describe("claim-registry", () => {
  it("starts empty (proactive OFF default = zero behavior change)", () => {
    expect(isClaimed("levelUp")).toBe(false)
  })

  it("claims and releases kinds", () => {
    claimKinds(["levelUp", "evolved"])
    expect(isClaimed("levelUp")).toBe(true)
    expect(isClaimed("evolved")).toBe(true)
    expect(isClaimed("goalComplete")).toBe(false)

    releaseKinds(["levelUp"])
    expect(isClaimed("levelUp")).toBe(false)
    expect(isClaimed("evolved")).toBe(true)
  })

  it("reset clears everything", () => {
    claimKinds(["workflowRun"])
    __resetProactiveClaims()
    expect(isClaimed("workflowRun")).toBe(false)
  })
})
