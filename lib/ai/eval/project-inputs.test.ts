import type { AppSettings } from "@cognia/agent-config-types"
import type { EvalCase, EvalDataset } from "@/types/eval/eval"
import type { EvalDatasetVersion } from "@/types/eval/version"
import { loadEvalDatasetSelection, resolveEvalVariantReadiness } from "./project-inputs"

const dataset: EvalDataset = {
  id: "dataset-1",
  name: "Mixed",
  capability: "chat.tool-use",
  version: 4,
  createdAt: 1,
  updatedAt: 2,
}

const cases: EvalCase[] = [
  {
    id: "case-text",
    datasetId: dataset.id,
    input: "hello",
    capability: "chat.qa",
    source: "handwritten",
    split: "train",
    createdAt: 1,
    updatedAt: 1,
  },
  {
    id: "case-image",
    datasetId: dataset.id,
    input: "inspect",
    contentParts: [
      { type: "text", text: "inspect" },
      { type: "asset", assetId: "a", mediaType: "image/png", privacy: "scanned" },
    ],
    capability: "chat.tool-use",
    source: "handwritten",
    split: "test",
    createdAt: 2,
    updatedAt: 2,
  },
]

describe("evaluation project inputs", () => {
  it("pins the real dataset version/digest and derives holdout/capability requirements", async () => {
    const version: EvalDatasetVersion = {
      id: "version-1",
      datasetId: dataset.id,
      version: dataset.version,
      caseIds: cases.map((item) => item.id),
      casesHash: "abc123",
      createdAt: 3,
    }
    const selected = await loadEvalDatasetSelection(dataset.id, {
      getDataset: async () => dataset,
      listCases: async () => cases,
      snapshotVersion: async () => version,
    })

    expect(selected).toEqual({
      datasetId: dataset.id,
      version: dataset.version,
      digest: "fnv1a:abc123",
      caseIds: ["case-text", "case-image"],
      holdoutCaseIds: ["case-image"],
      requiredModalities: ["text", "image", "tool"],
    })
  })

  it("uses the shared provider resolver instead of treating non-empty text as readiness", () => {
    const settings = {
      defaultProvider: "cloud",
      providerSettings: { cloud: { enabled: true, apiKey: "secret", defaultModel: "m" } },
      customProviders: [],
    } as unknown as AppSettings
    const ready = resolveEvalVariantReadiness(
      {
        id: "variant",
        name: "A",
        kind: "model",
        providerId: "cloud",
        modelId: "m",
        runtimeTarget: "web",
        isLocal: false,
        capabilities: ["text"],
        available: false,
        credentialReady: false,
      },
      settings
    )
    const missing = resolveEvalVariantReadiness(
      { ...ready, providerId: "missing", available: true, credentialReady: true },
      settings
    )

    expect(ready).toMatchObject({ available: true, credentialReady: true, isLocal: false })
    expect(missing).toMatchObject({ available: false, credentialReady: false })
  })

  it("derives locality from the resolved endpoint instead of the editable manifest flag", () => {
    const settings = {
      defaultProvider: "ollama",
      providerSettings: { ollama: { enabled: true, defaultModel: "qwen" } },
      customProviders: [],
    } as unknown as AppSettings

    const ready = resolveEvalVariantReadiness(
      {
        id: "variant",
        name: "Local",
        kind: "chat",
        providerId: "ollama",
        modelId: "qwen",
        runtimeTarget: "desktop",
        isLocal: false,
        capabilities: ["text"],
        available: false,
        credentialReady: false,
      },
      settings
    )

    expect(ready).toMatchObject({ available: true, credentialReady: true, isLocal: true })
  })

  it("derives declared image and tool capability from the shared model catalog", () => {
    const settings = {
      providerSettings: {
        openai: { enabled: true, apiKey: "secret", defaultModel: "gpt-4o" },
      },
      customProviders: [],
    } as unknown as AppSettings

    const ready = resolveEvalVariantReadiness(
      {
        id: "variant",
        name: "A",
        kind: "model",
        providerId: "openai",
        modelId: "gpt-4o",
        runtimeTarget: "web",
        isLocal: false,
        capabilities: ["text"],
        available: false,
        credentialReady: false,
      },
      settings
    )

    expect(ready.capabilities).toEqual(expect.arrayContaining(["text", "image", "tool"]))
    expect(ready.runtimeReady).toBe(true)
    expect(ready.catalogFingerprint).toMatch(/^fnv1a:[0-9a-f]{8}$/)
    expect(
      resolveEvalVariantReadiness({ ...ready, catalogFingerprint: undefined }, settings)
        .catalogFingerprint
    ).toBe(ready.catalogFingerprint)
  })
})
