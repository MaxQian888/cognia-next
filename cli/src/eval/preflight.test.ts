/** @jest-environment node */

import type { EvalProject } from "@cognia/eval-core"
import { checkCliEvalPreflight } from "./preflight"

const project = (): EvalProject => ({
  id: "p",
  name: "CLI",
  mode: "model",
  dataset: {
    datasetId: "d",
    version: 1,
    digest: "sha256:d",
    caseIds: ["c"],
    holdoutCaseIds: [],
    requiredModalities: ["text"],
  },
  variants: ["a", "b"].map((id) => ({
    id,
    name: id,
    kind: "model" as const,
    providerId: `provider-${id}`,
    modelId: `model-${id}`,
    runtimeTarget: "web" as const,
    isLocal: false,
    price: { currency: "USD", inputPerMillion: 1, outputPerMillion: 1 },
    capabilities: ["text" as const],
    available: true,
    credentialReady: true,
  })),
  decisionPolicy: {
    formal: false,
    // A project with no weighted dimension cannot decide anything, and shared
    // preflight refuses it. This fixture used to carry an empty list, so every
    // case here reported a decision-policy failure and the credential and disk
    // assertions were reading an already-blocked result.
    dimensions: [{ metric: "quality", direction: "maximize", weight: 1 }],
    constraints: [],
    confidenceLevel: 0.95,
    minimumEffectiveCases: 30,
  },
  budget: { currency: "USD", hardCap: 1, confirmed: true },
  judgePolicy: {
    enabled: false,
    calibrated: false,
    anchorCount: 0,
    kappa: 0,
    accuracy: 0,
  },
  privacyPolicy: { cloudPiiMode: "redact", mediaClearance: "local-only" },
  retentionDays: 90,
  createdAt: 1,
  updatedAt: 1,
})

describe("CLI evaluation preflight", () => {
  it("checks provider credentials and filesystem capacity", async () => {
    const result = await checkCliEvalPreflight(project(), "/tmp/project.json", {
      env: {
        NODE_ENV: "test",
        COGNIA_PROVIDER_A_API_KEY: "a",
        COGNIA_PROVIDER_B_API_KEY: "b",
      },
      statfs: async () => ({ bavail: BigInt(1_000_000), bsize: BigInt(4096) }),
      now: () => 10,
    })

    expect(result.result.ok).toBe(true)
    expect(result.environmentCompatibility.storage.status).toBe("available")
  })

  it("blocks a cloud variant when its CLI credential is absent", async () => {
    const result = await checkCliEvalPreflight(project(), "/tmp/project.json", {
      env: { NODE_ENV: "test", COGNIA_PROVIDER_A_API_KEY: "a" },
      statfs: async () => ({ bavail: BigInt(1_000_000), bsize: BigInt(4096) }),
      now: () => 10,
    })

    expect(result.result.issues).toContainEqual(
      expect.objectContaining({ code: "CREDENTIAL_MISSING", variantId: "b" })
    )
  })

  it("blocks when the checkpoint filesystem cannot reserve artifacts", async () => {
    const result = await checkCliEvalPreflight(project(), "/tmp/project.json", {
      env: {
        NODE_ENV: "test",
        COGNIA_PROVIDER_A_API_KEY: "a",
        COGNIA_PROVIDER_B_API_KEY: "b",
      },
      statfs: async () => ({ bavail: BigInt(1), bsize: BigInt(1) }),
      now: () => 10,
    })

    expect(result.result.issues).toContainEqual(
      expect.objectContaining({ code: "DISK_QUOTA_INSUFFICIENT" })
    )
  })
})
