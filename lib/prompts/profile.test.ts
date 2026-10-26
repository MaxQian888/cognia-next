/** @jest-environment jsdom */

import { createDbTestFixture } from "@/lib/db/test-fixture"
import { BRIEF_MODE_PROMPT } from "@/lib/agent/prompts/brief-mode"
import { DIFFICULTY_JUDGE_PROMPT } from "@/lib/ai/routing/difficulty-judge"
import {
  PROMPT_PROFILE_KIND,
  PromptProfileFormatError,
  applyPromptProfileImport,
  exportPromptProfile,
  importTargetKey,
  parsePromptProfile,
  previewPromptProfileImport,
  serializePromptProfile,
  type PromptProfileV1,
} from "./profile"
import { publishPromptBody, readPromptSlot, shippedBodyDigest } from "./service"
import { invalidatePromptOverrideSnapshot } from "./snapshot"
import { resolvePrompt } from "./resolve"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  invalidatePromptOverrideSnapshot()
})
afterAll(dbFixture.dispose)

const account = { scope: "account" as const, targetId: "" }

async function profileWith(
  entries: Array<Partial<PromptProfileV1["entries"][number]>>
): Promise<PromptProfileV1> {
  const baseDigest = await shippedBodyDigest(BRIEF_MODE_PROMPT)
  return {
    kind: PROMPT_PROFILE_KIND,
    schemaVersion: 1,
    exportedAt: "2026-10-20T00:00:00.000Z",
    entries: entries.map((entry) => ({
      promptId: BRIEF_MODE_PROMPT.id,
      scope: "account",
      targetId: "",
      contractVersion: BRIEF_MODE_PROMPT.contractVersion,
      baseDigest,
      body: "Be terse.",
      ...entry,
    })),
  }
}

describe("exportPromptProfile", () => {
  it("exports published overrides only, sorted, with their contract and base digest", async () => {
    await publishPromptBody({
      def: BRIEF_MODE_PROMPT,
      target: { scope: "workspace", targetId: "ws-1" },
      body: "Workspace brevity.",
      expectedRev: 0,
    })
    await publishPromptBody({
      def: BRIEF_MODE_PROMPT,
      target: account,
      body: "Be terse.",
      expectedRev: 0,
    })
    const profile = await exportPromptProfile({ now: () => new Date("2026-10-20T08:00:00Z") })
    expect(profile.exportedAt).toBe("2026-10-20T08:00:00.000Z")
    expect(profile.entries.map((entry) => [entry.scope, entry.targetId, entry.body])).toEqual([
      ["account", "", "Be terse."],
      ["workspace", "ws-1", "Workspace brevity."],
    ])
    expect(profile.entries[0].baseDigest).toBe(await shippedBodyDigest(BRIEF_MODE_PROMPT))
    const accountOnly = await exportPromptProfile({ scopes: ["account"] })
    expect(accountOnly.entries).toHaveLength(1)
    // Round-trips through the file format.
    expect(parsePromptProfile(serializePromptProfile(profile))).toEqual(profile)
  })
})

describe("parsePromptProfile", () => {
  it("rejects text that is not a prompt profile", () => {
    expect(() => parsePromptProfile("{")).toThrow(PromptProfileFormatError)
    expect(() => parsePromptProfile(JSON.stringify({ kind: "other" }))).toThrow(
      PromptProfileFormatError
    )
    expect(() =>
      parsePromptProfile(
        JSON.stringify({ kind: PROMPT_PROFILE_KIND, schemaVersion: 2, exportedAt: "", entries: [] })
      )
    ).toThrow(PromptProfileFormatError)
  })
})

describe("previewPromptProfileImport", () => {
  it("classifies every entry without writing", async () => {
    await publishPromptBody({
      def: BRIEF_MODE_PROMPT,
      target: account,
      body: "Old.",
      expectedRev: 0,
    })
    const profile = await profileWith([
      { body: "Old." },
      { scope: "workspace", targetId: "far-ws", body: "Mapped." },
      { scope: "workspace", targetId: "unmapped-ws", body: "Unmapped." },
      { promptId: "nope.missing" },
      { contractVersion: 99 },
      { scope: "session", targetId: "s1" },
      { body: "Contact me at dana@example.com, card 4111 1111 1111 1111." },
      { promptId: DIFFICULTY_JUDGE_PROMPT.id, body: "no tier contract at all" },
    ])
    const preview = await previewPromptProfileImport(profile, {
      [importTargetKey({ scope: "workspace", targetId: "far-ws" })]: "ws-local",
    })
    expect(preview.map((item) => item.status)).toEqual([
      "unchanged",
      "new",
      "needs-target",
      "unknown-prompt",
      "contract-mismatch",
      "scope-unsupported",
      "invalid",
      "invalid",
    ])
    expect(preview[1].target).toEqual({ scope: "workspace", targetId: "ws-local" })
    expect(preview[6].issues.map((issue) => issue.code)).toContain("pii")
    expect(preview[7].issues.map((issue) => issue.code)).toContain("missing-fragment")
    // Nothing was published by the preview.
    expect(
      (await readPromptSlot(BRIEF_MODE_PROMPT.id, { scope: "workspace", targetId: "ws-local" }))
        .binding
    ).toBeUndefined()
  })

  it("flags text written against an older shipped default", async () => {
    const preview = await previewPromptProfileImport(
      await profileWith([{ baseDigest: "sha256:old" }])
    )
    expect(preview[0]).toMatchObject({ status: "new", upstreamChanged: true })
  })
})

describe("applyPromptProfileImport", () => {
  it("publishes only the selected applicable entries and makes them resolve", async () => {
    await publishPromptBody({
      def: BRIEF_MODE_PROMPT,
      target: account,
      body: "Old.",
      expectedRev: 0,
    })
    const profile = await profileWith([
      { body: "Imported brevity." },
      { scope: "workspace", targetId: "far-ws", body: "Mapped." },
      { promptId: "nope.missing" },
    ])
    const preview = await previewPromptProfileImport(profile, { "workspace:far-ws": "ws-local" })
    expect(preview.map((item) => item.status)).toEqual(["replace", "new", "unknown-prompt"])
    const result = await applyPromptProfileImport(preview, new Set([0, 2]))
    expect(result).toEqual({ applied: 1, conflicted: [] })
    expect(resolvePrompt(BRIEF_MODE_PROMPT).text).toBe("Imported brevity.")
    const slot = await readPromptSlot(BRIEF_MODE_PROMPT.id, account)
    expect(slot.active?.origin).toBe("import")
    expect(
      (await readPromptSlot(BRIEF_MODE_PROMPT.id, { scope: "workspace", targetId: "ws-local" }))
        .binding
    ).toBeUndefined()
  })

  it("reports a slot edited since the preview instead of overwriting it", async () => {
    const preview = await previewPromptProfileImport(await profileWith([{ body: "From file." }]))
    expect(preview[0].status).toBe("new")
    await publishPromptBody({
      def: BRIEF_MODE_PROMPT,
      target: account,
      body: "Typed meanwhile.",
      expectedRev: 0,
    })
    const result = await applyPromptProfileImport(preview, new Set([0]))
    expect(result.applied).toBe(0)
    expect(result.conflicted).toHaveLength(1)
    expect(resolvePrompt(BRIEF_MODE_PROMPT).text).toBe("Typed meanwhile.")
  })
})
