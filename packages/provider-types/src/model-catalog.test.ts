import {
  CATALOG_SCHEMA_VERSION,
  isModelLifecycleAllowed,
  parseCatalogSnapshot,
  resolveModelLifecycle,
  type CatalogSnapshot,
} from "./model-catalog"

describe("model lifecycle governance", () => {
  it("keeps official retirements authoritative over stale active metadata", () => {
    expect(resolveModelLifecycle("deepseek", "deepseek-chat", "active")).toMatchObject({
      lifecycle: "retired",
      replacementModelId: "deepseek-flash",
      retiredAt: "2026-07-24",
    })
  })

  it("keeps first-party shutdown notices authoritative when a baseline still lists them", () => {
    expect(resolveModelLifecycle("xai", "grok-3", "active")).toMatchObject({
      lifecycle: "retired",
      retiredAt: "2026-05-15",
      replacementModelId: "grok-4.7",
    })
    expect(
      resolveModelLifecycle("google", "gemini-3.1-flash-image-preview", "active")
    ).toMatchObject({
      lifecycle: "retired",
      retiredAt: "2026-06-25",
      replacementModelId: "gemini-nano-banana-2.1",
    })
    expect(
      resolveModelLifecycle("siliconflow", "Qwen/Qwen3-Coder-480B-A35B-Instruct", "active")
        .lifecycle
    ).toBe("retired")
    expect(resolveModelLifecycle("openrouter", "x-ai/grok-3").lifecycle).toBe("active")
  })

  it("does not retire upcoming migrations or infer retirement from an absent id", () => {
    expect(resolveModelLifecycle("google", "veo-3.1-generate-preview").lifecycle).toBe("active")
    expect(resolveModelLifecycle("zhipu", "glm-5-turbo").lifecycle).toBe("active")
    expect(resolveModelLifecycle("perplexity", "sonar-pro")).toMatchObject({
      lifecycle: "deprecated",
      replacementModelId: "preset/fast",
    })
    expect(
      isModelLifecycleAllowed(resolveModelLifecycle("perplexity", "sonar-pro").lifecycle, "pinned")
    ).toBe(true)
  })

  it("scopes retirement to the serving provider rather than the model's brand", () => {
    expect(resolveModelLifecycle("openrouter", "deepseek/deepseek-chat").lifecycle).toBe("active")
    expect(resolveModelLifecycle("my-relay", "deepseek-chat").lifecycle).toBe("active")
  })

  it("preserves a stronger upstream retirement and normalizes lifecycle synonyms", () => {
    expect(resolveModelLifecycle("custom", "model", "active", "retired").lifecycle).toBe("retired")
    expect(resolveModelLifecycle("anthropic", "claude-sonnet-4-5", "retired").lifecycle).toBe(
      "retired"
    )
    expect(resolveModelLifecycle("custom", "model", "beta").lifecycle).toBe("preview")
    expect(resolveModelLifecycle("custom", "model", "legacy").lifecycle).toBe("deprecated")
  })

  it.each([
    ["active", true, true, true, true],
    ["preview", true, false, true, true],
    ["deprecated", false, false, true, true],
    ["retired", false, false, false, true],
  ] as const)(
    "uses one eligibility policy for %s",
    (lifecycle, fresh, auto, pinned, historical) => {
      expect(isModelLifecycleAllowed(lifecycle, "new")).toBe(fresh)
      expect(isModelLifecycleAllowed(lifecycle, "auto")).toBe(auto)
      expect(isModelLifecycleAllowed(lifecycle, "pinned")).toBe(pinned)
      expect(isModelLifecycleAllowed(lifecycle, "historical")).toBe(historical)
    }
  )
})

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
    if (result.ok) throw new Error("Expected future schema rejection")
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
