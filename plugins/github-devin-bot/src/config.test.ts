import { DEFAULT_REPOSITORY, MODELS, parseConfig } from "./config"

it("defaults to the requested repository and exact medium model", () => {
  expect(parseConfig({})).toEqual({
    repository: DEFAULT_REPOSITORY,
    model: "swe-2-medium",
    executionMode: "approval",
    publicationMode: "approval",
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
  { executionMode: "automatic" },
  { publicationMode: "unattended" },
])("rejects unsupported configuration %j", (raw) => expect(() => parseConfig(raw)).toThrow())

it("accepts separately chosen unattended execution and automatic publication", () => {
  expect(parseConfig({ executionMode: "unattended", publicationMode: "automatic" })).toMatchObject({
    executionMode: "unattended",
    publicationMode: "automatic",
  })
})
