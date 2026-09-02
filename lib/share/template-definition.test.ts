import { createTemplateDefinition, verifyTemplateDefinitionHash } from "@/lib/templates/contracts"
import type { TemplateDefinitionEnvelope, TemplateJson } from "@/lib/templates/contracts"
import {
  buildSharedTemplateDefinition,
  hasCredentialKey,
  parseSharedTemplateDefinition,
  serializeSharedTemplateDefinition,
  sharedTemplateDefinitionHasPii,
} from "./template-definition"

async function release(
  over: Partial<TemplateDefinitionEnvelope> = {}
): Promise<TemplateDefinitionEnvelope> {
  return createTemplateDefinition({
    id: "skill.review",
    domain: "skill",
    status: "published",
    revision: 1,
    version: "1.2.0",
    metadata: { name: "Review", description: "How we review" },
    payload: { name: "Review", content: "Look at the diff" } as TemplateJson,
    inputs: [],
    dependencies: [],
    capabilities: [],
    compatibility: { platforms: ["desktop"] },
    provenance: { source: "user", trust: "unsigned", sourceUrl: "https://local/only" },
    ...over,
  }) as Promise<TemplateDefinitionEnvelope>
}

describe("buildSharedTemplateDefinition", () => {
  it("wraps a published release and neutralises local provenance", async () => {
    const built = buildSharedTemplateDefinition(await release())
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.shared.kind).toBe("template-definition")
    expect(built.shared.definition.provenance).toEqual({ source: "user", trust: "unsigned" })
  })

  it("leaves the hashed body untouched, so the receiver can still verify it", async () => {
    const definition = await release()
    const built = buildSharedTemplateDefinition(definition)
    if (!built.ok) throw new Error("expected a shareable release")
    await expect(verifyTemplateDefinitionHash(built.shared.definition)).resolves.toBe(true)
    expect(built.shared.definition.contentHash).toBe(definition.contentHash)
  })

  it("refuses a draft", async () => {
    const draft = await release({ status: "draft", version: null })
    expect(buildSharedTemplateDefinition(draft)).toEqual({ ok: false, reason: "unpublished" })
  })

  it("refuses a conflict draft", async () => {
    const draft = await release({ status: "conflict", version: null })
    expect(buildSharedTemplateDefinition(draft)).toEqual({ ok: false, reason: "unpublished" })
  })

  it("refuses a withdrawn release", async () => {
    for (const status of ["deprecated", "yanked", "tombstone"] as const) {
      expect(buildSharedTemplateDefinition(await release({ status }))).toEqual({
        ok: false,
        reason: "withdrawn",
      })
    }
  })

  it("refuses a payload that still carries a credential key", async () => {
    const definition = await release({
      payload: { name: "Review", config: { defaultApiKey: "sk-live" } } as TemplateJson,
    })
    expect(buildSharedTemplateDefinition(definition)).toEqual({
      ok: false,
      reason: "non-portable",
    })
  })

  it("does not mistake a workflow graph's node ids for a portability failure", async () => {
    const definition = await release({
      domain: "workflow",
      payload: {
        name: "Flow",
        nodes: [{ id: "node-a", type: "action.noop" }],
        edges: [],
      } as TemplateJson,
    })
    expect(buildSharedTemplateDefinition(definition).ok).toBe(true)
  })
})

describe("hasCredentialKey", () => {
  it("matches stems, not only exact names", () => {
    expect(hasCredentialKey({ defaultApiKey: "x" })).toBe(true)
    expect(hasCredentialKey({ nested: [{ webhookSecret: "x" }] })).toBe(true)
    expect(hasCredentialKey({ maxTokens: 4, cacheKey: "x" })).toBe(false)
  })
})

describe("parseSharedTemplateDefinition", () => {
  it("round-trips a built envelope", async () => {
    const built = buildSharedTemplateDefinition(await release())
    if (!built.ok) throw new Error("expected a shareable release")
    const parsed = parseSharedTemplateDefinition(serializeSharedTemplateDefinition(built.shared))
    expect(parsed?.definition.id).toBe("skill.review")
    expect(parsed?.definition.version).toBe("1.2.0")
  })

  it("returns null for junk, a wrong kind, or a versionless definition", async () => {
    expect(parseSharedTemplateDefinition("not json")).toBeNull()
    expect(parseSharedTemplateDefinition(JSON.stringify({ kind: "discover-item" }))).toBeNull()
    const built = buildSharedTemplateDefinition(await release())
    if (!built.ok) throw new Error("expected a shareable release")
    const versionless = {
      ...built.shared,
      definition: { ...built.shared.definition, version: null },
    }
    expect(parseSharedTemplateDefinition(JSON.stringify(versionless))).toBeNull()
  })
})

describe("sharedTemplateDefinitionHasPii", () => {
  it("flags an email in the payload and passes a clean one", async () => {
    const clean = buildSharedTemplateDefinition(await release())
    if (!clean.ok) throw new Error("expected a shareable release")
    expect(sharedTemplateDefinitionHasPii(clean.shared)).toBe(false)

    const leaky = buildSharedTemplateDefinition(
      await release({
        payload: { name: "Review", content: "ping alice@example.com" } as TemplateJson,
      })
    )
    if (!leaky.ok) throw new Error("expected a shareable release")
    expect(sharedTemplateDefinitionHasPii(leaky.shared)).toBe(true)
  })
})
