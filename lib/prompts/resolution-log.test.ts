import {
  __resetPromptResolutionsForTests,
  lastPromptResolution,
  recentPromptResolutions,
  recordPromptResolution,
  subscribePromptResolutions,
} from "./resolution-log"

beforeEach(__resetPromptResolutionsForTests)

it("keeps the latest record per prompt and a newest-first recent list", () => {
  recordPromptResolution({ promptId: "a", source: { kind: "default" }, context: {}, at: 1 })
  recordPromptResolution({ promptId: "b", source: { kind: "default" }, context: {}, at: 2 })
  recordPromptResolution({
    promptId: "a",
    source: { kind: "override", scope: "account", bindingId: "pob", revisionId: "por" },
    context: {},
    at: 3,
  })
  expect(lastPromptResolution("a")?.at).toBe(3)
  expect(recentPromptResolutions().map((record) => record.at)).toEqual([3, 2, 1])
})

it("bounds the recent list", () => {
  for (let i = 0; i < 250; i++) {
    recordPromptResolution({ promptId: "a", source: { kind: "default" }, context: {}, at: i })
  }
  expect(recentPromptResolutions()).toHaveLength(200)
  expect(recentPromptResolutions()[0].at).toBe(249)
})

it("notifies subscribers and isolates a throwing one", () => {
  const good = jest.fn()
  const offBad = subscribePromptResolutions(() => {
    throw new Error("ui broke")
  })
  const off = subscribePromptResolutions(good)
  expect(() =>
    recordPromptResolution({ promptId: "a", source: { kind: "default" }, context: {}, at: 1 })
  ).not.toThrow()
  expect(good).toHaveBeenCalledTimes(1)
  off()
  offBad()
})
