import type { OnlineEvalPolicyV1 } from "@cognia/eval-core"
import {
  __setOnlineEvalPolicyCacheForTests,
  getCachedOnlineEvalPolicies,
  refreshOnlineEvalPolicyCache,
} from "./policy-cache"

function policy(overrides: Partial<OnlineEvalPolicyV1> = {}): OnlineEvalPolicyV1 {
  return {
    schema: "cognia-online-eval-policy/v1",
    id: "p1",
    versionId: "p1@1",
    name: "n",
    enabled: true,
    shadow: false,
    selector: {},
    deterministicEvaluatorVersionIds: ["det@1"],
    judgeEvaluatorVersionIds: [],
    sampling: { judgeRate: 0.05, judgeDailyMax: 200 },
    budget: { dailyUsdCap: 5 },
    escalation: {
      thresholdBand: 0.1,
      onEvaluatorConflict: true,
      onJudgeParseFailure: true,
      onNegativeFeedback: true,
    },
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

beforeEach(() => __setOnlineEvalPolicyCacheForTests([]))

describe("refreshOnlineEvalPolicyCache", () => {
  it("caches only the enabled policies", async () => {
    const count = await refreshOnlineEvalPolicyCache({
      listPolicies: async () =>
        [policy({ id: "on" }), policy({ id: "off", enabled: false })] as never,
      isEnabled: () => true,
    })
    expect(count).toBe(1)
    expect(getCachedOnlineEvalPolicies().map((row) => row.id)).toEqual(["on"])
  })

  it("stays empty while the Eval Lab flag is down — that is the off switch", async () => {
    const listPolicies = jest.fn()
    const count = await refreshOnlineEvalPolicyCache({
      listPolicies: listPolicies as never,
      isEnabled: () => false,
    })
    expect(count).toBe(0)
    expect(listPolicies).not.toHaveBeenCalled()
    expect(getCachedOnlineEvalPolicies()).toEqual([])
  })

  it("clears the cache when the flag goes down after policies were loaded", async () => {
    await refreshOnlineEvalPolicyCache({
      listPolicies: async () => [policy()] as never,
      isEnabled: () => true,
    })
    expect(getCachedOnlineEvalPolicies()).toHaveLength(1)
    await refreshOnlineEvalPolicyCache({
      listPolicies: async () => [policy()] as never,
      isEnabled: () => false,
    })
    expect(getCachedOnlineEvalPolicies()).toEqual([])
  })

  it("keeps the previous cache when the read fails, switching nothing on or off", async () => {
    await refreshOnlineEvalPolicyCache({
      listPolicies: async () => [policy({ id: "kept" })] as never,
      isEnabled: () => true,
    })
    const count = await refreshOnlineEvalPolicyCache({
      listPolicies: async () => {
        throw new Error("db closed")
      },
      isEnabled: () => true,
    })
    expect(count).toBe(1)
    expect(getCachedOnlineEvalPolicies().map((row) => row.id)).toEqual(["kept"])
  })
})
