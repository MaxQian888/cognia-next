import { createTemplateDefinition } from "./contracts"
import type { TemplateDefinitionEnvelope, TemplateJson } from "./contracts"
import { inspectTemplatePackage } from "./package"
import {
  installSharedTemplateDefinition,
  sharedDefinitionPackageId,
} from "./install-shared-definition"

async function release(
  over: Partial<TemplateDefinitionEnvelope> = {}
): Promise<TemplateDefinitionEnvelope> {
  return createTemplateDefinition({
    id: "skill.review",
    domain: "skill",
    status: "published",
    revision: 1,
    version: "2.0.0",
    metadata: { name: "Review", description: "How we review" },
    payload: { name: "Review", content: "Look at the diff" } as TemplateJson,
    inputs: [],
    dependencies: [],
    capabilities: [],
    compatibility: { platforms: ["desktop"] },
    provenance: { source: "user", trust: "unsigned" },
    ...over,
  }) as Promise<TemplateDefinitionEnvelope>
}

describe("sharedDefinitionPackageId", () => {
  it("replaces characters a package id may not carry", () => {
    expect(sharedDefinitionPackageId("agentTeam:squad/one")).toBe("agentTeam-squad-one.link")
  })

  it("falls back when nothing usable survives", () => {
    expect(sharedDefinitionPackageId("///")).toBe("shared-template.link")
  })

  it("is deterministic, so re-importing replaces rather than duplicates", () => {
    expect(sharedDefinitionPackageId("skill.review")).toBe(
      sharedDefinitionPackageId("skill.review")
    )
  })
})

describe("installSharedTemplateDefinition", () => {
  it("builds a one-definition package the importer accepts, tagged as a link", async () => {
    const definition = await release()
    const importPackage = jest.fn(async (bytes: Uint8Array) => inspectTemplatePackage(bytes))
    await installSharedTemplateDefinition(
      { definition, sourceUrl: "https://share.example/share/view?c=abc" },
      { service: { importPackage } as never }
    )

    expect(importPackage).toHaveBeenCalledTimes(1)
    const [bytes, input] = importPackage.mock.calls[0] as unknown as [
      Uint8Array,
      { source: string; confirmed: boolean; sourceUrl?: string },
    ]
    expect(input).toEqual({
      source: "link",
      confirmed: true,
      sourceUrl: "https://share.example/share/view?c=abc",
    })

    const inspected = await inspectTemplatePackage(bytes)
    expect(inspected.trust).toBe("unsigned")
    expect(inspected.manifest.id).toBe("skill.review.link")
    expect(inspected.manifest.version).toBe("2.0.0")
    expect(inspected.definitions).toHaveLength(1)
    expect(inspected.definitions[0].contentHash).toBe(definition.contentHash)
  })

  it("omits sourceUrl when there is none to record", async () => {
    const importPackage = jest.fn(
      async (_bytes: Uint8Array, _input: Record<string, unknown>) => undefined as never
    )
    await installSharedTemplateDefinition(
      { definition: await release() },
      { service: { importPackage } as never }
    )
    expect(importPackage.mock.calls[0][1]).toEqual({ source: "link", confirmed: true })
  })

  it("refuses a definition with no version", async () => {
    await expect(
      installSharedTemplateDefinition(
        { definition: await release({ version: null, status: "draft" }) },
        { service: { importPackage: jest.fn() } as never }
      )
    ).rejects.toThrow(/published release/)
  })

  it("refuses a forged content hash, because the package reader re-checks it", async () => {
    const definition = { ...(await release()), contentHash: "0".repeat(64) }
    await expect(
      installSharedTemplateDefinition(
        { definition },
        { service: { importPackage: jest.fn() } as never }
      )
    ).rejects.toThrow(/forged content hash/)
  })
})
