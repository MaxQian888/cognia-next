import { DEFAULT_REPOSITORY, MODELS, parseConfig } from "./config"

it("defaults to the requested repository and exact medium model", () => {
  expect(parseConfig({})).toEqual({
    repository: DEFAULT_REPOSITORY,
    model: "swe-2-medium",
    timeoutMs: 1_800_000,
    maxRepairAttempts: 2,
  })
})
it.each(MODELS)("accepts explicit model %s", (model) =>
  expect(parseConfig({ model }).model).toBe(model)
)
it.each([
  { repository: "https://github.com/a/b" },
  { model: "default" },
  { timeoutMinutes: 31 },
  { timeoutMinutes: 0.5 },
  { maxRepairAttempts: 3 },
])("rejects unsupported configuration %j", (raw) => expect(() => parseConfig(raw)).toThrow())
