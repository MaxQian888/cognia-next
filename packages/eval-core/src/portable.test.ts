import { parsePortableManifest, serializePortableManifest } from "./portable"
import type { EvalPortableManifest } from "./types"

describe("cognia-eval/v2 portable manifest", () => {
  const manifest: EvalPortableManifest = {
    schema: "cognia-eval/v2",
    exportedAt: "2026-07-31T00:00:00.000Z",
    project: {
      id: "p1",
      name: "Project",
      mode: "model",
      datasetDigest: "sha256:data",
    },
    experiment: {
      id: "e1",
      status: "completed",
      randomSeed: 42,
      appVersion: "1.0.0",
    },
    variants: [{ id: "v1", name: "Variant", providerId: "openai", modelId: "gpt" }],
    aggregates: [],
  }

  it("round-trips a versioned manifest", () => {
    expect(parsePortableManifest(serializePortableManifest(manifest))).toEqual(manifest)
  })

  it("rejects credential and secret references at any depth", () => {
    expect(() =>
      parsePortableManifest({ ...manifest, metadata: { providerApiKey: "secret" } })
    ).toThrow(/secret/i)
  })
})
