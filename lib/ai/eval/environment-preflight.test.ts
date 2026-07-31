import type { EvalProject } from "@cognia/eval-core"

jest.mock("@/lib/db/workflows", () => ({
  getWorkflow: jest.fn(async (id: string) => (id === "workflow-1" ? { id } : undefined)),
}))

import {
  applyEnvironmentReadiness,
  checkEvalEnvironmentCompatibility,
  estimateEvalArtifactReservation,
} from "./environment-preflight"

const project = (): EvalProject => ({
  id: "project",
  name: "Project",
  mode: "agent",
  dataset: {
    datasetId: "dataset",
    version: 1,
    digest: "sha256:test",
    caseIds: ["one", "two"],
    holdoutCaseIds: [],
    requiredModalities: ["text"],
  },
  variants: [
    {
      id: "team",
      name: "Team",
      kind: "team",
      targetId: "team-1",
      runtimeTarget: "desktop",
      isLocal: true,
      capabilities: ["text", "tool", "trajectory"],
      available: true,
      credentialReady: true,
    },
    {
      id: "workflow",
      name: "Workflow",
      kind: "workflow",
      targetId: "workflow-1",
      runtimeTarget: "desktop",
      isLocal: true,
      capabilities: ["text", "tool", "trajectory"],
      available: true,
      credentialReady: true,
    },
  ],
  decisionPolicy: {
    formal: false,
    dimensions: [],
    constraints: [],
    confidenceLevel: 0.95,
    minimumEffectiveCases: 30,
  },
  budget: { currency: "USD", hardCap: 10, confirmed: true },
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

describe("evaluation environment preflight", () => {
  it("reserves three repetitions of artifact capacity with a safe minimum", () => {
    expect(estimateEvalArtifactReservation(project())).toBe(64 * 1024 * 1024)
  })

  it("checks concrete Agent targets, desktop availability, and free storage", async () => {
    const result = await checkEvalEnvironmentCompatibility(project(), {
      hasTeam: async (id) => id === "team-1",
      hasWorkflow: async (id) => id === "workflow-1",
      isDesktop: () => true,
      estimateStorage: async () => ({ usage: 10, quota: 256 * 1024 * 1024 }),
      now: () => 42,
    })

    expect(result.checkedAt).toBe(42)
    expect(result.runtimeByVariant).toEqual({
      team: { available: true },
      workflow: { available: true },
    })
    expect(result.storage).toMatchObject({ status: "available" })
  })

  it("reports missing targets and insufficient quota without dispatching", async () => {
    const result = await checkEvalEnvironmentCompatibility(project(), {
      hasTeam: async () => false,
      hasWorkflow: async () => true,
      isDesktop: () => false,
      estimateStorage: async () => ({ usage: 90, quota: 100 }),
      now: () => 42,
    })

    expect(result.runtimeByVariant.team).toEqual({
      available: false,
      reason: "desktop-runtime-unavailable",
    })
    expect(result.runtimeByVariant.workflow.available).toBe(false)
    expect(result.storage.status).toBe("insufficient")
  })

  it("records unknown storage when the platform cannot measure quota", async () => {
    const input = project()
    input.variants = []
    const result = await checkEvalEnvironmentCompatibility(input, {
      hasTeam: async () => true,
      hasWorkflow: async () => true,
      isDesktop: () => true,
      estimateStorage: async () => undefined,
      now: () => 42,
    })

    expect(result.storage).toEqual({
      status: "unknown",
      requiredBytes: 64 * 1024 * 1024,
    })
  })

  it("uses the production target, runtime, storage, and clock probes by default", async () => {
    const input = project()
    input.variants = input.variants.map((variant) => ({
      ...variant,
      runtimeTarget: "web",
    }))

    const result = await checkEvalEnvironmentCompatibility(input)

    expect(result.checkedAt).toBeGreaterThan(0)
    expect(result.runtimeByVariant).toMatchObject({
      team: { available: false, reason: "team-target-unavailable" },
      workflow: { available: true },
    })
    expect(result.storage.status).toBe("unknown")
  })

  it("records unknown storage when quota estimation rejects", async () => {
    const result = await checkEvalEnvironmentCompatibility(project(), {
      hasTeam: async () => true,
      hasWorkflow: async () => true,
      isDesktop: () => true,
      estimateStorage: async () => {
        throw new Error("private mode")
      },
      now: () => 42,
    })

    expect(result.storage.status).toBe("unknown")
  })

  it("distinguishes missing team/workflow targets and applies runtime readiness", async () => {
    const input = project()
    input.variants.push({
      id: "model",
      name: "Model",
      kind: "model",
      providerId: "local",
      modelId: "model",
      runtimeTarget: "web",
      isLocal: true,
      capabilities: ["text"],
      available: true,
      credentialReady: true,
      runtimeReady: false,
    })
    const result = await checkEvalEnvironmentCompatibility(input, {
      hasTeam: async () => false,
      hasWorkflow: async () => false,
      isDesktop: () => true,
      estimateStorage: async () => ({ usage: 0, quota: 256 * 1024 * 1024 }),
      now: () => 42,
    })

    expect(result.runtimeByVariant).toMatchObject({
      team: { available: false, reason: "team-target-unavailable" },
      workflow: { available: false, reason: "workflow-target-unavailable" },
      model: { available: false, reason: "variant-runtime-unavailable" },
    })
    expect(applyEnvironmentReadiness(input, result).variants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "team", runtimeReady: false }),
        expect.objectContaining({ id: "workflow", runtimeReady: false }),
        expect.objectContaining({ id: "model", runtimeReady: false }),
      ])
    )
  })
})
