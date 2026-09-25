import { configSchema, MODELS, parseConfig, REPOSITORY_REQUIRED_MESSAGE } from "./config"

const repository = "acme/widgets"

it("requires a repository instead of defaulting to someone else's", () => {
  expect(() => parseConfig({})).toThrow(REPOSITORY_REQUIRED_MESSAGE)
  expect(() => parseConfig({ repository: "" })).toThrow(REPOSITORY_REQUIRED_MESSAGE)
  expect(configSchema.required).toEqual(["repository"])
  expect(configSchema.properties.repository).not.toHaveProperty("default")
  expect(configSchema.properties.repository.description).toMatch(/GitHub Enterprise Server/)
})

it("defaults the configured repository to the exact medium model", () => {
  expect(parseConfig({ repository })).toEqual({
    repository,
    model: "swe-2-medium",
    executionMode: "approval",
    publicationMode: "approval",
    timeoutMs: 1_800_000,
    maxRepairAttempts: 2,
  })
})
it.each(MODELS)("accepts explicit model %s", (model) =>
  expect(parseConfig({ repository, model }).model).toBe(model)
)
it.each([
  { repository: "https://github.com/a/b" },
  { model: "default" },
  { timeoutMinutes: 31 },
  { timeoutMinutes: 0.5 },
  { maxRepairAttempts: 3 },
  { executionMode: "automatic" },
  { publicationMode: "unattended" },
])("rejects unsupported configuration %j", (raw) =>
  expect(() => parseConfig({ repository, ...raw })).toThrow()
)

it("accepts separately chosen unattended execution and automatic publication", () => {
  expect(
    parseConfig({ repository, executionMode: "unattended", publicationMode: "automatic" })
  ).toMatchObject({
    executionMode: "unattended",
    publicationMode: "automatic",
  })
})
