import { CATALOG_SCHEMA_VERSION, parseCatalogSnapshot, type CatalogSnapshot } from "./model-catalog"

function createSnapshot(): CatalogSnapshot {
  return {
    revision: {
      id: "2026-07-31-test",
      schemaVersion: CATALOG_SCHEMA_VERSION,
      generatedAt: "2026-07-31T00:00:00.000Z",
      sources: [{ kind: "official", id: "test-fixture" }],
      checksum: "sha256:test",
      integrity: "verified",
    },
    providers: [
      {
        id: "openai",
        name: "OpenAI",
        tier: "certified",
        source: { kind: "official", id: "openai" },
        modalities: ["language", "embedding", "image", "speech"],
        adapterFamilies: ["openai-compatible"],
        connectionSchema: { fields: [] },
      },
    ],
    models: [
      {
        id: "openai:gpt-test",
        name: "GPT Test",
        creator: "openai",
        family: "gpt",
        modalities: { input: ["text"], output: ["text"] },
        capabilities: {
          streaming: true,
          tools: true,
          structuredOutput: true,
        },
        limits: { context: 128_000, output: 16_384 },
        lifecycle: "active",
        provenance: {
          lifecycle: { kind: "official", id: "openai" },
          limits: { kind: "official", id: "openai" },
        },
      },
    ],
    offerings: [
      {
        id: "openai:gpt-test",
        providerRef: "openai",
        modelRef: "openai:gpt-test",
        upstreamId: "gpt-test",
        endpointType: "responses",
        lifecycle: "active",
        available: true,
        source: { kind: "official", id: "openai" },
      },
    ],
    aliases: [
      {
        id: "legacy:gpt-test-preview",
        kind: "legacy",
        target: { type: "offering", ref: "openai:gpt-test" },
        replacementRef: "openai:gpt-test",
      },
    ],
  }
}

describe("model catalog contracts", () => {
  it("accepts a complete secret-free multimodal snapshot", () => {
    const parsed = parseCatalogSnapshot(createSnapshot())

    expect(parsed).toEqual({ ok: true, value: createSnapshot() })
  })

  it("rejects dangling offering references", () => {
    const snapshot = createSnapshot()
    snapshot.offerings[0] = {
      ...snapshot.offerings[0],
      modelRef: "openai:missing",
    }

    const parsed = parseCatalogSnapshot(snapshot)

    expect(parsed.ok).toBe(false)
    if (!parsed.ok) {
      expect(parsed.errors).toContain(
        'offering "openai:gpt-test" references missing model "openai:missing"'
      )
    }
  })

  it("rejects alias cycles", () => {
    const snapshot = createSnapshot()
    snapshot.aliases = [
      {
        id: "friendly:a",
        kind: "friendly",
        target: { type: "alias", ref: "friendly:b" },
      },
      {
        id: "friendly:b",
        kind: "friendly",
        target: { type: "alias", ref: "friendly:a" },
      },
    ]

    const parsed = parseCatalogSnapshot(snapshot)

    expect(parsed.ok).toBe(false)
    if (!parsed.ok) {
      expect(parsed.errors).toContain('alias cycle detected at "friendly:a"')
    }
  })

  it("rejects credentials and invalid prices", () => {
    const snapshot = createSnapshot()
    snapshot.offerings[0] = {
      ...snapshot.offerings[0],
      pricing: { currency: "USD", inputPer1M: -1 },
    }
    Object.assign(snapshot.offerings[0], {
      overrides: { apiKey: "must-not-enter-catalog" },
    })

    const parsed = parseCatalogSnapshot(snapshot)

    expect(parsed.ok).toBe(false)
    if (!parsed.ok) {
      expect(parsed.errors.join("\n")).toContain("inputPer1M")
      expect(parsed.errors.join("\n")).toContain(">=0")
      expect(parsed.errors.join("\n")).toContain("secret material is not allowed")
    }
  })

  it("still parses a v1 snapshot under the v2 schema", () => {
    expect(CATALOG_SCHEMA_VERSION).toBe(2)
    const v1 = createSnapshot()
    v1.revision.schemaVersion = 1
    expect(parseCatalogSnapshot(v1).ok).toBe(true)
  })

  it("rejects a snapshot newer than the reader", () => {
    const future = createSnapshot()
    future.revision.schemaVersion = CATALOG_SCHEMA_VERSION + 1
    const result = parseCatalogSnapshot(future)
    expect(result.ok).toBe(false)
    expect(result.errors.some((e) => e.includes("newer than supported"))).toBe(true)
  })

  it("accepts the v2 modalities and endpoint types", () => {
    const snapshot = createSnapshot()
    snapshot.providers[0]!.modalities = ["language", "video", "transcription", "moderation"]
    snapshot.offerings[0]!.endpointType = "vector-store"
    const result = parseCatalogSnapshot(snapshot)
    expect(result.ok).toBe(true)
  })
})
