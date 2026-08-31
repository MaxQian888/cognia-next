import {
  attachTwinProvenanceToLastAssistant,
  resolveSessionTwinProvenance,
} from "./export-provenance"

describe("resolveSessionTwinProvenance", () => {
  it("projects the bound Twin into structured export provenance", async () => {
    await expect(
      resolveSessionTwinProvenance({ id: "s1", characterId: "c1" } as never, [], async () => ({
        twinId: "twin-1",
      }))
    ).resolves.toEqual([{ source: "digital-twin", sourceId: "twin-1", disclosure: "ai-generated" }])
  })

  it("does not label an unbound session", async () => {
    await expect(resolveSessionTwinProvenance({ id: "s1" } as never)).resolves.toBeUndefined()
  })

  it("prefers durable message provenance over a later character rebind", async () => {
    await expect(
      resolveSessionTwinProvenance(
        { id: "s1", characterId: "other" } as never,
        [
          {
            metadata: {
              provenance: [
                { source: "digital-twin", sourceId: "twin-old", disclosure: "ai-generated" },
              ],
            },
          },
        ],
        async () => ({ twinId: "twin-new" })
      )
    ).resolves.toEqual([
      { source: "digital-twin", sourceId: "twin-old", disclosure: "ai-generated" },
    ])
  })

  it("stably deduplicates every Twin represented in durable history", async () => {
    const provenance = (sourceId: string) => ({
      source: "digital-twin" as const,
      sourceId,
      disclosure: "ai-generated" as const,
    })
    await expect(
      resolveSessionTwinProvenance({ id: "s1" } as never, [
        { metadata: { provenance: [provenance("twin-b")] } },
        { metadata: { provenance: [provenance("twin-a"), provenance("twin-b")] } },
      ])
    ).resolves.toEqual([provenance("twin-a"), provenance("twin-b")])
  })

  it("attaches provenance to the last assistant message", () => {
    const messages = attachTwinProvenanceToLastAssistant(
      [
        { id: "u", role: "user", parts: [] },
        { id: "a", role: "assistant", parts: [] },
      ] as never,
      "twin-1"
    )
    expect(messages[1]?.metadata).toMatchObject({
      provenance: [{ source: "digital-twin", sourceId: "twin-1" }],
    })
  })
})
