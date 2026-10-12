import {
  ALLOWLIST_REQUIRED_MESSAGE,
  configSchema,
  parseConfig,
  REPOSITORY_REQUIRED_MESSAGE,
  SetupError,
} from "./config"

const base = { repository: "acme/widgets", allowedAuthorIds: ["42"] }

it("applies safe defaults and nothing that names a repository, a person or a trigger", () => {
  expect(parseConfig(base)).toEqual({
    repository: "acme/widgets",
    allowedAuthorIds: ["42"],
    publicationMode: "automatic",
    agentPreset: "claude-code",
    timeoutMs: 15 * 60_000,
    commandMaxAgeMs: 24 * 3_600_000,
    pollIntervalMs: 60_000,
  })
  expect(configSchema.required).toEqual(["repository", "allowedAuthorIds"])
  expect(configSchema.properties).not.toHaveProperty("repository.default")
})

it("reports missing setup with stable codes instead of failing", () => {
  expect(() => parseConfig({ allowedAuthorIds: ["42"] })).toThrow(REPOSITORY_REQUIRED_MESSAGE)
  try {
    parseConfig({ repository: "acme/widgets", allowedAuthorIds: [] })
    throw new Error("unreachable")
  } catch (error) {
    expect(error).toBeInstanceOf(SetupError)
    expect((error as SetupError).code).toBe("allowlist_empty")
    expect((error as Error).message).toBe(ALLOWLIST_REQUIRED_MESSAGE)
  }
  expect(() => parseConfig({ allowedAuthorIds: ["42"] })).toThrow(
    expect.objectContaining({ code: "repository_missing" })
  )
})

it.each([
  [{ repository: "nope" }, "owner/repo"],
  [{ repository: "a/.." }, "owner/repo"],
  [{ allowedAuthorIds: ["octo-cat"] }, "numeric GitHub user ids"],
  [{ allowedAuthorIds: "42" }, "numeric GitHub user ids"],
  [{ trigger: "cognia" }, "mention"],
  [{ trigger: "@bad mention" }, "mention"],
  [{ publicationMode: "yolo" }, "automatic or approval"],
  [{ agentPreset: "../x" }, "preset"],
  [{ model: 7 }, "model id"],
  [{ timeoutMinutes: 31 }, "between 1 and 30"],
  [{ commandMaxAgeHours: 0 }, "between 1 and 168"],
  [{ pollIntervalMs: 1000 }, "between 30000"],
])("rejects %j", (patch, message) => {
  expect(() => parseConfig({ ...base, ...patch })).toThrow(message)
})

it("keeps explicit choices and deduplicates the allowlist", () => {
  expect(
    parseConfig({
      ...base,
      allowedAuthorIds: ["42", "42", "7"],
      trigger: " @team-bot ",
      publicationMode: "approval",
      agentPreset: "codex",
      model: " gpt-5 ",
      timeoutMinutes: 5,
      commandMaxAgeHours: 2,
      pollIntervalMs: 120_000,
    })
  ).toMatchObject({
    allowedAuthorIds: ["42", "7"],
    trigger: "@team-bot",
    publicationMode: "approval",
    agentPreset: "codex",
    model: "gpt-5",
    timeoutMs: 300_000,
    commandMaxAgeMs: 7_200_000,
    pollIntervalMs: 120_000,
  })
})
