const redactText = jest.fn((text: string) => ({ redacted: text, map: {} }))
const hasNoLeakingPii = jest.fn(() => true)

jest.mock("@cognia/redact", () => ({
  redactText: (...args: unknown[]) => redactText(...(args as [string])),
  hasNoLeakingPii: (...args: unknown[]) => hasNoLeakingPii(...(args as [])),
}))

import type { Character, TeamMember } from "@cognia/agent-config-types"
import {
  DEFAULT_TEAM_RESPONSE_CAP,
  duplicateTeamResponseIds,
  MAX_TEAM_RESPONSE_CAP,
  resolveTeamResponseCap,
  selectPrimaryResponder,
} from "./team-primary-router"

const members = [
  { id: "research", name: "Alice", description: "Find evidence" },
  { id: "writer", name: "Bob", description: "Draft clear prose" },
] as Character[]
const slots = new Map<string, TeamMember>([
  ["research", { characterId: "research", role: "Researcher" }],
  ["writer", { characterId: "writer", role: "Writer" }],
])

beforeEach(() => {
  redactText.mockClear()
  hasNoLeakingPii.mockReset().mockReturnValue(true)
})

describe("resolveTeamResponseCap", () => {
  it("defaults legacy values and clamps persisted input", () => {
    expect(resolveTeamResponseCap(undefined)).toBe(DEFAULT_TEAM_RESPONSE_CAP)
    expect(resolveTeamResponseCap(0)).toBe(1)
    expect(resolveTeamResponseCap(99)).toBe(MAX_TEAM_RESPONSE_CAP)
    expect(resolveTeamResponseCap(3)).toBe(3)
  })
})

describe("duplicateTeamResponseIds", () => {
  it("suppresses only new normalized duplicates and preserves existing history", () => {
    expect(
      duplicateTeamResponseIds([
        { id: "old", text: "Ship the fix", existing: true },
        { id: "new-duplicate", text: "  ship   THE fix ", existing: false },
        { id: "new-unique", text: "Add tests", existing: false },
      ])
    ).toEqual(new Set(["new-duplicate"]))
  })
})

describe("selectPrimaryResponder", () => {
  it("uses the utility model's stable roster token", async () => {
    const complete = jest.fn(async () => "A2")

    await expect(
      selectPrimaryResponder({
        client: { complete },
        userText: "Write a release note",
        members,
        memberByCharId: slots,
      })
    ).resolves.toBe(members[1])

    expect(complete).toHaveBeenCalledWith(
      expect.stringContaining("A2 | Writer | Draft clear prose"),
      expect.objectContaining({ temperature: 0, maxTokens: 8 })
    )
    expect(redactText).toHaveBeenCalledWith(expect.any(String), ["Alice", "Bob"])
  })

  it("fails closed before the model call when redaction still leaks", async () => {
    hasNoLeakingPii.mockReturnValue(false)
    const complete = jest.fn(async () => "A2")

    await expect(
      selectPrimaryResponder({
        client: { complete },
        userText: "secret",
        members,
        memberByCharId: slots,
      })
    ).resolves.toBe(members[0])
    expect(complete).not.toHaveBeenCalled()
  })

  it.each([
    null,
    { complete: jest.fn(async () => "invalid") },
    { complete: jest.fn(async () => "A99") },
  ])(
    "falls back to the first declared member for unavailable or invalid utility output",
    async (client) => {
      await expect(
        selectPrimaryResponder({ client, userText: "help", members, memberByCharId: slots })
      ).resolves.toBe(members[0])
    }
  )

  it("falls back when the utility request fails", async () => {
    const complete = jest.fn(async () => {
      throw new Error("offline")
    })
    await expect(
      selectPrimaryResponder({
        client: { complete },
        userText: "help",
        members,
        memberByCharId: slots,
      })
    ).resolves.toBe(members[0])
  })
})
