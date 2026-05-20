/**
 * Tests for the edit-time PII guard.
 *
 * `assertDraftBodyClean` is the red-line check the workbench runs when a
 * reviewer saves an edited draft. The guard must catch raw PII pasted
 * into any of the user-facing string fields without flagging the
 * `<KIND_NNN>` placeholder tokens that the redactor emits.
 */

import {
  assertDraftBodyClean,
  assertFieldsClean,
  DraftPiiError,
} from "@/lib/twin/distill/draft-pii-guard"
import type { TwinDraftPayload } from "@/types/twin"

function characterPayload(overrides: Partial<Record<string, string>> = {}): TwinDraftPayload {
  return {
    kind: "character",
    data: {
      name: "Test character",
      description: "short summary",
      systemPrompt: "You are helpful.",
      voiceSummary: "calm and concise",
      ...overrides,
    },
  }
}

function skillPayload(overrides: Partial<Record<string, string>> = {}): TwinDraftPayload {
  return {
    kind: "skill",
    data: {
      name: "Test skill",
      description: "short summary",
      content: "Imperative title — do the thing.",
      ...overrides,
    },
  }
}

describe("assertDraftBodyClean", () => {
  it("passes a clean character payload", () => {
    expect(() => assertDraftBodyClean(characterPayload())).not.toThrow()
  })

  it("passes a clean skill payload", () => {
    expect(() => assertDraftBodyClean(skillPayload())).not.toThrow()
  })

  it("passes placeholders — they are not leaks", () => {
    // The redactor replaces real PII with `<KIND_NNN>` tokens; those
    // tokens are designed to pass the red-line check.
    expect(() =>
      assertDraftBodyClean(
        characterPayload({
          systemPrompt:
            "You report to <NAME_001> on the <PROJECT_001> team. Reach out via <EMAIL_001>.",
        })
      )
    ).not.toThrow()
  })

  it("rejects a raw email address in the system prompt", () => {
    let caught: unknown
    try {
      assertDraftBodyClean(
        characterPayload({
          systemPrompt: "Email me at alice@example.com for questions.",
        })
      )
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(DraftPiiError)
    expect((caught as DraftPiiError).violations.map((v) => v.field)).toContain("systemPrompt")
  })

  it("rejects a public IPv4 address in the description", () => {
    // `hasNoLeakingPii` checks EMAIL / CN_ID / API_KEY / PASSPORT / IPV4 /
    // IPV6 / BANK_CARD — not phone (phones are often intentional in
    // drafts like "call our office at …"). Use a public IPv4 to verify
    // the IP path is wired.
    expect(() =>
      assertDraftBodyClean(
        characterPayload({ description: "Production API at 198.51.100.7 has been migrated." })
      )
    ).toThrow(DraftPiiError)
  })

  it("rejects an API-key-shaped value in skill content", () => {
    expect(() =>
      assertDraftBodyClean(
        skillPayload({
          content: "Use sk-ant-api03-abcdefghijklmnop1234567890 to authenticate.",
        })
      )
    ).toThrow(DraftPiiError)
  })

  it("aggregates violations across multiple fields", () => {
    let caught: unknown
    try {
      assertDraftBodyClean(
        characterPayload({
          name: "Test character",
          description: "Reach me on alice@example.com",
          systemPrompt: "Backup contact: bob@example.com",
        })
      )
    } catch (err) {
      caught = err
    }
    const violations = (caught as DraftPiiError).violations.map((v) => v.field).sort()
    expect(violations).toEqual(["description", "systemPrompt"])
  })

  it("ignores empty / missing fields", () => {
    expect(() =>
      assertDraftBodyClean({
        kind: "character",
        data: { name: "", description: "", systemPrompt: "" },
      })
    ).not.toThrow()
  })
})

describe("assertFieldsClean (Persona browser red-line)", () => {
  it("passes when every field is clean", () => {
    expect(() =>
      assertFieldsClean({
        name: "Alice",
        description: "trusted advisor on platform topics",
        relation: "ex-colleague",
      })
    ).not.toThrow()
  })

  it("throws DraftPiiError listing the offending field", () => {
    let thrown: DraftPiiError | null = null
    try {
      assertFieldsClean({
        name: "Alice",
        description: "email her at alice@example.com",
      })
    } catch (err) {
      thrown = err as DraftPiiError
    }
    expect(thrown).toBeInstanceOf(DraftPiiError)
    expect(thrown?.violations.map((v) => v.field)).toEqual(["description"])
  })

  it("ignores undefined / null / empty-string fields", () => {
    expect(() =>
      assertFieldsClean({
        name: "Alice",
        description: undefined,
        relation: null,
        notes: "",
      })
    ).not.toThrow()
  })
})
