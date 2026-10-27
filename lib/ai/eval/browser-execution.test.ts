/** @jest-environment jsdom */

import "fake-indexeddb/auto"
import type { AppSettings } from "@cognia/agent-config-types"
import type { EvalExperimentManifest, EvalTask, EvalVariant } from "@cognia/eval-core"
import { llmScorers } from "@cognia/eval-core"
import type { EvalCase, EvalSample, Scorer } from "@/types/eval/eval"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { createEvalExperiment } from "@/lib/db/eval-lab"
import { digestEvalDependency } from "./project-service"
import {
  createBrowserEvalOrchestrator,
  createBrowserEvalTaskExecutor,
  DexieEvalOrchestratorRepository,
} from "./browser-execution"

const mockDefaultTargetRun = jest.fn(async (..._args: unknown[]): Promise<unknown> => undefined)
const mockCreatePureModelTarget = jest.fn((..._args: unknown[]) => ({
  label: "default model",
  run: (...args: unknown[]) => mockDefaultTargetRun(...args),
}))
const mockCreateAgentTarget = jest.fn((..._args: unknown[]) => ({
  label: "default agent",
  run: (...args: unknown[]) => mockDefaultTargetRun(...args),
}))
const mockRendererClient = jest.fn((..._args: unknown[]): unknown => undefined)
const mockDecryptArtifact = jest.fn(async (..._args: unknown[]): Promise<unknown> => undefined)

jest.mock("./targets/model", () => ({
  createPureModelEvalTarget: (...args: unknown[]) => mockCreatePureModelTarget(...args),
}))
jest.mock("./targets/create-from-spec", () => ({
  createTargetFromSpec: (...args: unknown[]) => mockCreateAgentTarget(...args),
}))
jest.mock("@/lib/ai/renderer-llm-client", () => ({
  buildRendererLlmClient: (...args: unknown[]) => mockRendererClient(...args),
}))
jest.mock("./artifact-crypto", () => ({
  ...jest.requireActual("./artifact-crypto"),
  decryptEvalArtifact: (...args: unknown[]) => mockDecryptArtifact(...args),
}))
jest.mock("@cognia/eval-core", () => {
  const actual = jest.requireActual("@cognia/eval-core")
  return { ...actual, llmScorers: jest.fn(actual.llmScorers) }
})

const variant: EvalVariant = {
  id: "variant-a",
  name: "A",
  kind: "model",
  providerId: "provider-a",
  modelId: "model-a",
  runtimeTarget: "web",
  isLocal: false,
  price: { inputPerMillion: 1, outputPerMillion: 2, currency: "USD" },
  capabilities: ["text"],
  available: true,
  credentialReady: true,
}

const manifest: EvalExperimentManifest = {
  id: "experiment-1",
  projectId: "project-1",
  projectRevision: "sha256:project",
  dataset: {
    datasetId: "dataset-1",
    version: 2,
    digest: "sha256:dataset",
    caseIds: ["case-1"],
    holdoutCaseIds: ["case-1"],
    requiredModalities: ["text"],
  },
  variants: [variant],
  mode: "model",
  appVersion: "test",
  scorerVersions: { exact: "2" },
  privacyPolicy: { cloudPiiMode: "redact", mediaClearance: "scanned" },
  randomSeed: 7,
  budget: { currency: "USD", hardCap: 1, confirmed: true },
  judgePolicy: {
    enabled: false,
    calibrated: false,
    anchorCount: 0,
    kappa: 0,
    accuracy: 0,
  },
  decisionPolicy: {
    formal: false,
    dimensions: [{ metric: "quality", direction: "maximize", weight: 1 }],
    constraints: [],
    confidenceLevel: 0.95,
    minimumEffectiveCases: 1,
  },
  retentionDays: 90,
  adaptiveRepetitions: { stageOne: 1, maximum: 3 },
  environmentCompatibility: {
    checkedAt: 1,
    runtimeByVariant: { a: { available: true } },
    storage: { status: "available", requiredBytes: 1, availableBytes: 100 },
  },
  createdAt: 1,
}

const task: EvalTask = {
  id: "task-1",
  experimentId: manifest.id,
  variantId: variant.id,
  caseId: "case-1",
  repetition: 1,
  state: "queued",
  attempt: 0,
  reservedCost: 0,
  estimatedWorstCaseCost: 0.5,
  updatedAt: 1,
}

const evalCase: EvalCase = {
  id: "case-1",
  datasetId: "dataset-1",
  input: "private prompt",
  reference: { expectedOutput: "answer", grading: { mode: "exact" } },
  capability: "chat.qa",
  source: "handwritten",
  split: "test",
  createdAt: 1,
  updatedAt: 1,
}

const sample: EvalSample = {
  output: "answer",
  toolCalls: [],
  retrievedChunks: [],
  usage: {
    inputTokens: 10,
    outputTokens: 2,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  },
  costUsd: 0.000014,
  latencyMs: 25,
  stepCount: 1,
  degraded: false,
  redactionPolicy: "cloud-redacted",
  redactionDigest: "sha256:redacted",
}

describe("browser evaluation task execution", () => {
  beforeEach(() => {
    mockDefaultTargetRun.mockReset()
    mockDefaultTargetRun.mockResolvedValue(sample)
    mockCreatePureModelTarget.mockClear()
    mockCreateAgentTarget.mockClear()
    mockRendererClient.mockReset()
    mockDecryptArtifact.mockReset()
  })

  it("encrypts the complete case/sample evidence and scorer reasoning before persistence", async () => {
    const scorer: Scorer = {
      id: "exact",
      dimension: "response-quality",
      requiresLlm: false,
      gating: true,
      score: async () => ({
        scorerId: "exact",
        dimension: "response-quality",
        status: "scored",
        value: 1,
        passed: true,
        reasoning: "matched reference",
      }),
    }
    const encryptArtifact = jest.fn(async () => ({
      version: "cognia-eval-encrypted/v1" as const,
      algorithm: "AES-GCM" as const,
      iv: "iv",
      ciphertext: "ciphertext",
    }))
    let id = 0
    const execute = createBrowserEvalTaskExecutor(
      {
        appSettings: {} as AppSettings,
        artifactKey: new Uint8Array(32),
      },
      {
        loadExperiment: async () => ({
          id: manifest.id,
          projectId: manifest.projectId,
          manifest,
          state: "running",
          spentCost: 0,
          reservedCost: 0.5,
          createdAt: 1,
          updatedAt: 1,
        }),
        loadCase: async () => evalCase,
        buildTarget: () => ({ label: "A", run: async () => sample }),
        resolveScorers: () => [scorer],
        encryptArtifact,
        now: () => 1_000,
        newId: () => `id-${++id}`,
      }
    )

    const result = await execute(task, new AbortController().signal)

    expect(result.actualCost).toBe(sample.costUsd)
    expect(result.value.sample.expiresAt).toBe(1_000 + 90 * 24 * 60 * 60 * 1_000)
    expect(result.value.sample).toMatchObject({
      judgeRedactionPolicy: "redacted",
      judgeRedactionDigest: expect.stringMatching(/^sha256:/),
    })
    expect(result.value.sample.encryptedArtifact).not.toHaveProperty("output")
    expect(encryptArtifact).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      expect.objectContaining({
        case: expect.objectContaining({ input: "private prompt" }),
        sample: expect.objectContaining({ output: "answer" }),
      })
    )
    expect(result.value.scores[0]).toMatchObject({ scorerId: "exact", scorerVersion: "2" })
    expect(encryptArtifact).toHaveBeenCalledWith(expect.any(Uint8Array), {
      reasoning: "matched reference",
    })
  })

  it("uses the production pure-model adapter and deterministic scorer catalog", async () => {
    const configuredManifest = {
      ...manifest,
      variants: [
        {
          ...variant,
          parameters: {
            temperature: 0.2,
            topP: 0.8,
            maxOutputTokens: 512,
            systemPrompt: "Be concise",
          },
        },
      ],
    }
    const execute = createBrowserEvalTaskExecutor(
      { appSettings: {} as AppSettings, artifactKey: new Uint8Array(32) },
      {
        loadExperiment: async () => ({
          id: manifest.id,
          projectId: manifest.projectId,
          manifest: configuredManifest,
          state: "running",
          spentCost: 0,
          reservedCost: 0,
          createdAt: 1,
          updatedAt: 1,
        }),
        loadCase: async () => evalCase,
        encryptArtifact: async () => ({
          version: "cognia-eval-encrypted/v1",
          algorithm: "AES-GCM",
          iv: "iv",
          ciphertext: "ciphertext",
        }),
        now: () => 1_000,
        newId: () => crypto.randomUUID(),
      }
    )

    const result = await execute(task, new AbortController().signal)

    expect(mockCreatePureModelTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "provider-a",
        modelId: "model-a",
        systemPrompt: "Be concise",
        parameters: { temperature: 0.2, topP: 0.8, maxOutputTokens: 512 },
      }),
      expect.objectContaining({
        createSnapshot: expect.any(Function),
        resolveProvider: expect.any(Function),
        createModel: expect.any(Function),
        resolveAsset: expect.any(Function),
      })
    )
    expect(result.value.scores.length).toBeGreaterThan(0)

    const targetDependencies = mockCreatePureModelTarget.mock.calls[0][1] as {
      resolveAsset(id: string): Promise<{ data: string; mediaType: string }>
    }
    await expect(targetDependencies.resolveAsset("missing")).rejects.toThrow("unavailable")
    await getDb().evalAssets.add({
      digest: "asset",
      mediaType: "image/png",
      size: 1,
      encryptedBytes: {
        version: "cognia-eval-encrypted/v1",
        algorithm: "AES-GCM",
        iv: "iv",
        ciphertext: "ciphertext",
      },
      referenceCount: 1,
      createdAt: 1,
      expiresAt: 2,
    })
    mockDecryptArtifact.mockResolvedValue({ data: "base64", mediaType: "image/webp" })
    await expect(targetDependencies.resolveAsset("asset")).rejects.toThrow(
      "verified cloud-media clearance"
    )
    await getDb().evalAssets.update("asset", {
      clearance: { method: "scan", clearedAt: 1, contentDigest: "asset" },
    })
    await expect(targetDependencies.resolveAsset("asset")).resolves.toEqual({
      data: "base64",
      mediaType: "image/webp",
    })
  })

  it.each([
    ["chat", { modelId: "model-a", targetId: "character-a" }, "chat"],
    ["team", { targetId: "team-a" }, "team"],
    ["workflow", { targetId: "workflow-a" }, "workflow"],
    [
      "workflow",
      { targetId: "workflow-a", parameters: { workflowVersionId: "workflow-version-a" } },
      "workflow",
    ],
  ] as const)(
    "routes %s variants through isolated Agent adapters",
    async (kind, patch, targetKind) => {
      const agentVariant = { ...variant, ...patch, kind, runtimeTarget: "desktop" as const }
      const agentManifest = { ...manifest, mode: "agent" as const, variants: [agentVariant] }
      const execute = createBrowserEvalTaskExecutor(
        { appSettings: {} as AppSettings, artifactKey: new Uint8Array(32) },
        {
          loadExperiment: async () => ({
            id: manifest.id,
            projectId: manifest.projectId,
            manifest: agentManifest,
            state: "running",
            spentCost: 0,
            reservedCost: 0,
            createdAt: 1,
            updatedAt: 1,
          }),
          loadCase: async () => evalCase,
          encryptArtifact: async () => ({
            version: "cognia-eval-encrypted/v1",
            algorithm: "AES-GCM",
            iv: "iv",
            ciphertext: "ciphertext",
          }),
        }
      )

      await execute({ ...task, variantId: agentVariant.id }, new AbortController().signal)
      expect(mockCreateAgentTarget).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: targetKind,
          ...(kind === "workflow" && "parameters" in patch
            ? { versionId: "workflow-version-a" }
            : {}),
        }),
        expect.any(Object)
      )
    }
  )

  it("redacts every cloud Agent text surface before dispatch and records the policy", async () => {
    const agentVariant = {
      ...variant,
      kind: "chat" as const,
      modelId: "agent-model",
      targetId: "character-a",
      isLocal: true,
      runtimeTarget: "desktop" as const,
    }
    let dispatchedCase: EvalCase | undefined
    let encryptedPayload: unknown
    const execute = createBrowserEvalTaskExecutor(
      { appSettings: {} as AppSettings, artifactKey: new Uint8Array(32) },
      {
        loadExperiment: async () => ({
          id: manifest.id,
          projectId: manifest.projectId,
          manifest: { ...manifest, mode: "agent", variants: [agentVariant] },
          state: "running",
          spentCost: 0,
          reservedCost: 0,
          createdAt: 1,
          updatedAt: 1,
        }),
        loadCase: async () => ({
          ...evalCase,
          input: "Contact jane@example.com",
          history: [{ role: "user", content: "My phone is 13800138000" }],
          contentParts: [{ type: "text", text: "Account jane@example.com" }],
          inputVars: { email: "jane@example.com" },
        }),
        buildTarget: () => ({
          label: "agent",
          run: async (value) => {
            dispatchedCase = value
            return sample
          },
        }),
        encryptArtifact: async (_key, value) => {
          encryptedPayload = value
          return {
            version: "cognia-eval-encrypted/v1",
            algorithm: "AES-GCM",
            iv: "iv",
            ciphertext: "ciphertext",
          }
        },
      }
    )

    await execute(task, new AbortController().signal)

    expect(JSON.stringify(dispatchedCase)).not.toContain("jane@example.com")
    expect(JSON.stringify(dispatchedCase)).not.toContain("13800138000")
    expect(encryptedPayload).toEqual(
      expect.objectContaining({
        sample: expect.objectContaining({
          redactionPolicy: "cloud-redacted",
          redactionDigest: expect.stringMatching(/^sha256:/),
        }),
      })
    )
  })

  it("keeps uncleared Agent media local and rejects unsupported team attachments", async () => {
    const cloudChat = {
      ...variant,
      kind: "chat" as const,
      modelId: "agent-model",
      isLocal: false,
    }
    const loadCase = async () => ({
      ...evalCase,
      contentParts: [
        {
          type: "asset" as const,
          assetId: "private",
          mediaType: "image/png",
          privacy: "local-only" as const,
        },
      ],
    })
    const loadExperiment = async (agentVariant: EvalVariant) => ({
      id: manifest.id,
      projectId: manifest.projectId,
      manifest: { ...manifest, mode: "agent" as const, variants: [agentVariant] },
      state: "running" as const,
      spentCost: 0,
      reservedCost: 0,
      createdAt: 1,
      updatedAt: 1,
    })
    const options = { appSettings: {} as AppSettings, artifactKey: new Uint8Array(32) }

    await expect(
      createBrowserEvalTaskExecutor(options, {
        loadExperiment: () => loadExperiment(cloudChat),
        loadCase,
      })(task, new AbortController().signal)
    ).rejects.toThrow("privacy clearance")

    await expect(
      createBrowserEvalTaskExecutor(options, {
        loadExperiment: () =>
          loadExperiment({ ...cloudChat, kind: "team", isLocal: true, targetId: "team-a" }),
        loadCase,
      })(task, new AbortController().signal)
    ).rejects.toThrow("do not accept attachment")
  })

  it("surfaces missing manifests, variants, cases, and required target identifiers", async () => {
    const options = { appSettings: {} as AppSettings, artifactKey: new Uint8Array(32) }
    await expect(
      createBrowserEvalTaskExecutor(options, { loadExperiment: async () => undefined })(
        task,
        new AbortController().signal
      )
    ).rejects.toThrow("experiment")
    await expect(
      createBrowserEvalTaskExecutor(options, {
        loadExperiment: async () => ({
          id: manifest.id,
          projectId: manifest.projectId,
          manifest: { ...manifest, variants: [] },
          state: "running",
          spentCost: 0,
          reservedCost: 0,
          createdAt: 1,
          updatedAt: 1,
        }),
      })(task, new AbortController().signal)
    ).rejects.toThrow("variant")
    await expect(
      createBrowserEvalTaskExecutor(options, {
        loadExperiment: async () => ({
          id: manifest.id,
          projectId: manifest.projectId,
          manifest,
          state: "running",
          spentCost: 0,
          reservedCost: 0,
          createdAt: 1,
          updatedAt: 1,
        }),
        loadCase: async () => undefined,
      })(task, new AbortController().signal)
    ).rejects.toThrow("case")

    const invalidVariant = { ...variant, kind: "team" as const, targetId: undefined }
    const invalidManifest = { ...manifest, mode: "agent" as const, variants: [invalidVariant] }
    await expect(
      createBrowserEvalTaskExecutor(options, {
        loadExperiment: async () => ({
          id: manifest.id,
          projectId: manifest.projectId,
          manifest: invalidManifest,
          state: "running",
          spentCost: 0,
          reservedCost: 0,
          createdAt: 1,
          updatedAt: 1,
        }),
        loadCase: async () => evalCase,
      })(task, new AbortController().signal)
    ).rejects.toThrow("Team id")
  })

  it("converts scorer exceptions into persisted errored evidence", async () => {
    const execute = createBrowserEvalTaskExecutor(
      { appSettings: {} as AppSettings, artifactKey: new Uint8Array(32) },
      {
        loadExperiment: async () => ({
          id: manifest.id,
          projectId: manifest.projectId,
          manifest,
          state: "running",
          spentCost: 0,
          reservedCost: 0,
          createdAt: 1,
          updatedAt: 1,
        }),
        loadCase: async () => evalCase,
        buildTarget: () => ({ label: "A", run: async () => sample }),
        resolveScorers: () => [
          {
            id: "broken",
            dimension: "response-quality",
            requiresLlm: true,
            gating: true,
            score: async () => {
              throw new Error("judge malformed")
            },
          },
        ],
        encryptArtifact: async () => ({
          version: "cognia-eval-encrypted/v1",
          algorithm: "AES-GCM",
          iv: "iv",
          ciphertext: "ciphertext",
        }),
      }
    )

    const result = await execute(task, new AbortController().signal)
    expect(result.value.scores[0]).toMatchObject({
      scorerId: "broken",
      status: "errored",
      error: "judge malformed",
    })
  })

  it("constructs the independent judge tier and blocks when the configured judge is unavailable", async () => {
    const judgedManifest = {
      ...manifest,
      judgePolicy: {
        enabled: true,
        providerId: "judge-provider",
        modelId: "judge-model",
        isLocal: false,
        price: { currency: "USD", inputPerMillion: 10, outputPerMillion: 20 },
        secondJudgeProviderId: "second-provider",
        secondJudgeModelId: "second-model",
        secondJudgeIsLocal: false,
        secondJudgePrice: { currency: "USD", inputPerMillion: 10, outputPerMillion: 20 },
        calibrated: true,
        anchorCount: 30,
        kappa: 0.7,
        accuracy: 0.9,
      },
    }
    const loadExperiment = async () => ({
      id: manifest.id,
      projectId: manifest.projectId,
      manifest: judgedManifest,
      state: "running" as const,
      spentCost: 0,
      reservedCost: 0,
      createdAt: 1,
      updatedAt: 1,
    })
    const overrides = {
      loadExperiment,
      loadCase: async () => evalCase,
      buildTarget: () => ({ label: "A", run: async () => sample }),
      encryptArtifact: async () => ({
        version: "cognia-eval-encrypted/v1" as const,
        algorithm: "AES-GCM" as const,
        iv: "iv",
        ciphertext: "ciphertext",
      }),
    }
    const getUsageSnapshot = jest
      .fn()
      .mockReturnValueOnce({ inputTokens: 0, outputTokens: 0, totalTokens: 0 })
      .mockReturnValue({ inputTokens: 100, outputTokens: 50, totalTokens: 150 })
    const completeJudge = jest.fn(async () =>
      JSON.stringify({ pass: true, reasoning: "ok", score: 1, relevant: true, faithful: true })
    )
    mockRendererClient
      .mockReturnValueOnce({ complete: completeJudge, getUsageSnapshot })
      .mockReturnValueOnce({
        complete: completeJudge,
        getUsageSnapshot: jest
          .fn()
          .mockReturnValueOnce({ inputTokens: 0, outputTokens: 0, totalTokens: 0 })
          .mockReturnValue({ inputTokens: 100, outputTokens: 50, totalTokens: 150 }),
      })
    const judgeController = new AbortController()
    const result = await createBrowserEvalTaskExecutor(
      { appSettings: {} as AppSettings, artifactKey: new Uint8Array(32) },
      overrides
    )(task, judgeController.signal)
    expect(completeJudge).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        abortSignal: judgeController.signal,
        maxRetries: 0,
        maxTokens: expect.any(Number),
      })
    )
    expect(result.value.scores.some((score) => score.scorerId.startsWith("judge-"))).toBe(true)
    expect(result.value.sample).toMatchObject({
      judgeInputTokens: 200,
      judgeOutputTokens: 100,
      judgeCost: 0.004,
      actualCost: sample.costUsd + 0.004,
    })
    expect(result.actualCost).toBe(sample.costUsd + 0.004)

    mockRendererClient.mockReset()
    mockRendererClient
      .mockReturnValueOnce({
        complete: async () => JSON.stringify({ pass: true, reasoning: "primary" }),
        getUsageSnapshot: () => ({ inputTokens: 10, outputTokens: 5, totalTokens: 15 }),
      })
      .mockReturnValueOnce({
        complete: async () => JSON.stringify({ pass: false, reasoning: "second" }),
        getUsageSnapshot: () => ({ inputTokens: 10, outputTokens: 5, totalTokens: 15 }),
      })
    const conflicting = await createBrowserEvalTaskExecutor(
      { appSettings: {} as AppSettings, artifactKey: new Uint8Array(32) },
      overrides
    )(task, new AbortController().signal)
    expect(conflicting.value.scores).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scorerId: "judge-task-completion",
          status: "errored",
          error: expect.stringMatching(/human review/i),
        }),
      ])
    )

    mockRendererClient.mockReturnValue(null)
    const ungraded = await createBrowserEvalTaskExecutor(
      { appSettings: {} as AppSettings, artifactKey: new Uint8Array(32) },
      overrides
    )(task, new AbortController().signal)
    expect(ungraded.value.sample.actualCost).toBeGreaterThan(0)
    expect(ungraded.value.scores).toEqual([
      expect.objectContaining({
        scorerId: "evaluation-configuration",
        status: "errored",
        error: expect.stringContaining("judge is unavailable"),
      }),
    ])
  })

  it("retains a returned sample and measured spend when cancellation arrives during execution", async () => {
    const controller = new AbortController()
    const score = jest.fn()
    const result = await createBrowserEvalTaskExecutor(
      { appSettings: {} as AppSettings, artifactKey: new Uint8Array(32) },
      {
        loadExperiment: async () => ({
          id: manifest.id,
          projectId: manifest.projectId,
          manifest,
          state: "running",
          spentCost: 0,
          reservedCost: 0,
          createdAt: 1,
          updatedAt: 1,
        }),
        loadCase: async () => evalCase,
        buildTarget: () => ({
          label: "late",
          run: async () => {
            controller.abort()
            return { ...sample, costUsd: 0.25 }
          },
        }),
        resolveScorers: score,
        encryptArtifact: async () => ({
          version: "cognia-eval-encrypted/v1",
          algorithm: "AES-GCM",
          iv: "iv",
          ciphertext: "ciphertext",
        }),
      }
    )(task, controller.signal)
    expect(result.actualCost).toBe(0.25)
    expect(result.executionStatus).toBe("cancelled")
    expect(result.value.sample.executionStatus).toBe("cancelled")
    expect(score).not.toHaveBeenCalled()
  })

  it("refuses judge calls before dispatch when captured target spend exhausts the reservation", async () => {
    const complete = jest.fn(async () => JSON.stringify({ pass: true }))
    mockRendererClient.mockReturnValue({
      complete,
      getUsageSnapshot: () => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
    })
    const judged = {
      ...manifest,
      judgePolicy: {
        ...manifest.judgePolicy,
        enabled: true,
        providerId: "judge",
        modelId: "judge-model",
        isLocal: false,
        price: { inputPerMillion: 1, outputPerMillion: 2, currency: "USD" },
      },
    }
    const result = await createBrowserEvalTaskExecutor(
      { appSettings: {} as AppSettings, artifactKey: new Uint8Array(32) },
      {
        loadExperiment: async () => ({
          id: manifest.id,
          projectId: manifest.projectId,
          manifest: judged,
          state: "running",
          spentCost: 0,
          reservedCost: 0,
          createdAt: 1,
          updatedAt: 1,
        }),
        loadCase: async () => evalCase,
        buildTarget: () => ({ label: "captured", run: async () => ({ ...sample, costUsd: 0.1 }) }),
        encryptArtifact: async () => ({
          version: "cognia-eval-encrypted/v1",
          algorithm: "AES-GCM",
          iv: "iv",
          ciphertext: "ciphertext",
        }),
      }
    )({ ...task, reservedCost: 0.05 }, new AbortController().signal)
    expect(complete).not.toHaveBeenCalled()
    expect(result.value.sample.actualCost).toBe(0.1)
    expect(result.value.scores).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "errored",
          error: expect.stringContaining("reserved budget"),
        }),
      ])
    )
  })

  it("PII-gates the final composed judge prompt immediately before the provider call", async () => {
    const complete = jest.fn(async () => "unexpected")
    mockRendererClient.mockReturnValue({ complete })
    jest.mocked(llmScorers).mockImplementationOnce(({ client }) => [
      {
        id: "judge-controlled",
        dimension: "response-quality",
        requiresLlm: true,
        gating: true,
        score: async () => {
          await client.complete("Contact jane@example.com before scoring.")
          return {
            scorerId: "judge-controlled",
            dimension: "response-quality",
            status: "scored",
            value: 1,
            passed: true,
          }
        },
      },
    ])
    const judged = {
      ...manifest,
      judgePolicy: {
        ...manifest.judgePolicy,
        enabled: true,
        providerId: "judge",
        modelId: "judge-model",
        isLocal: false,
        price: { inputPerMillion: 1, outputPerMillion: 2, currency: "USD" },
      },
    }
    const result = await createBrowserEvalTaskExecutor(
      { appSettings: {} as AppSettings, artifactKey: new Uint8Array(32) },
      {
        loadExperiment: async () => ({
          id: manifest.id,
          projectId: manifest.projectId,
          manifest: judged,
          state: "running",
          spentCost: 0,
          reservedCost: 0,
          createdAt: 1,
          updatedAt: 1,
        }),
        loadCase: async () => evalCase,
        buildTarget: () => ({ label: "safe", run: async () => sample }),
        encryptArtifact: async () => ({
          version: "cognia-eval-encrypted/v1",
          algorithm: "AES-GCM",
          iv: "iv",
          ciphertext: "ciphertext",
        }),
      }
    )(task, new AbortController().signal)
    expect(complete).not.toHaveBeenCalled()
    expect(result.value.scores).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scorerId: "judge-controlled",
          status: "errored",
          error: expect.stringContaining("PII gate"),
        }),
      ])
    )
  })

  it.each(["case", "target"] as const)(
    "refuses a changed %s dependency before dispatch",
    async (kind) => {
      const pinned = { revision: "pinned" }
      const frozenManifest = {
        ...manifest,
        ...(kind === "case"
          ? {
              caseDigests: {
                [evalCase.id]: await digestEvalDependency({ ...evalCase, input: "old" }),
              },
            }
          : { targetDigests: { [variant.id]: await digestEvalDependency(pinned) } }),
      }
      const run = jest.fn(async () => sample)
      await expect(
        createBrowserEvalTaskExecutor(
          { appSettings: {} as AppSettings, artifactKey: new Uint8Array(32) },
          {
            loadExperiment: async () => ({
              id: manifest.id,
              projectId: manifest.projectId,
              manifest: frozenManifest,
              state: "running",
              spentCost: 0,
              reservedCost: 0,
              createdAt: 1,
              updatedAt: 1,
            }),
            loadCase: async () => evalCase,
            readTargetDependency: async () => ({ revision: "changed" }),
            buildTarget: () => ({ label: "unreachable", run }),
          }
        )(task, new AbortController().signal)
      ).rejects.toThrow("changed since the manifest")
      expect(run).not.toHaveBeenCalled()
    }
  )

  it("constructs the durable browser orchestrator with production dependencies", () => {
    expect(
      createBrowserEvalOrchestrator({
        appSettings: {} as AppSettings,
        artifactKey: new Uint8Array(32),
      })
    ).toBeDefined()
  })
})

describe("Dexie evaluation orchestrator repository", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    getDb()
    await whenSeeded()
    await getDb().evalExperiments.clear()
    await getDb().evalTasks.clear()
    await createEvalExperiment(manifest)
    await getDb().evalExperiments.update(manifest.id, { state: "queued" })
  }, 30_000)

  it("restores the persisted balanced protocol concurrency limit", async () => {
    const balancedManifest: EvalExperimentManifest = {
      ...manifest,
      id: "balanced-experiment",
      mode: "agent",
      executionProtocol: { kind: "balanced", repetitions: 3, outerConcurrency: 1 },
    }
    await createEvalExperiment(balancedManifest)
    const repository = new DexieEvalOrchestratorRepository()

    await expect(repository.getExperiment(balancedManifest.id)).resolves.toMatchObject({
      hardCap: 1,
      concurrencyLimit: 1,
    })
  })

  it("atomically reserves only work that fits under the hard cap", async () => {
    await getDb().evalTasks.bulkAdd([
      task,
      { ...task, id: "task-2", caseId: "case-2" },
      { ...task, id: "task-3", caseId: "case-3", estimatedWorstCaseCost: 0.01 },
    ])
    const repository = new DexieEvalOrchestratorRepository()

    await expect(repository.reserveTask("task-1", 0.5)).resolves.toBe(true)
    await expect(repository.reserveTask("task-1", 0.5)).resolves.toBe(false)
    await expect(repository.reserveTask("task-2", 0.6)).resolves.toBe(false)
    await expect(repository.reserveTask("task-3", 0.01)).resolves.toBe(true)

    expect(await getDb().evalExperiments.get(manifest.id)).toMatchObject({ reservedCost: 0.51 })
    expect(await getDb().evalTasks.get("task-2")).toMatchObject({ reservedCost: 0 })
  })

  it("fences late updates after another window cancels an experiment", async () => {
    await getDb().evalTasks.add({ ...task, state: "cancelled" })
    await getDb().evalExperiments.update(manifest.id, { state: "cancelled" })
    const repository = new DexieEvalOrchestratorRepository()
    await repository.updateTask(task.id, { state: "running", attempt: 2 })
    await repository.setExperimentState(manifest.id, "running")
    await repository.setExperimentState(manifest.id, "completed")
    expect((await getDb().evalTasks.get(task.id))?.state).toBe("cancelled")
    expect((await getDb().evalExperiments.get(manifest.id))?.state).toBe("cancelled")
  })

  it("rejects a scope change between repository access and the transaction write", async () => {
    await getDb().evalTasks.add(task)
    let checks = 0
    const repository = new DexieEvalOrchestratorRepository(undefined, {
      db: getDb(),
      assertActive() {
        if (++checks > 1) throw new Error("scope changed")
      },
    })
    await expect(repository.reserveTask(task.id, 0.4)).rejects.toThrow("scope changed")
    expect((await getDb().evalTasks.get(task.id))?.reservedCost).toBe(0)
    expect((await getDb().evalExperiments.get(manifest.id))?.reservedCost).toBe(0)
  })

  it("persists repository state, completion ordering, and reservation release", async () => {
    await getDb().evalTasks.add({ ...task, reservedCost: 0.25 })
    await getDb().evalExperiments.update(manifest.id, { reservedCost: 0.25 })
    const repository = new DexieEvalOrchestratorRepository()

    await expect(repository.getExperiment(manifest.id)).resolves.toMatchObject({ hardCap: 1 })
    await expect(repository.listTasks(manifest.id)).resolves.toHaveLength(1)
    await repository.setExperimentState(manifest.id, "paused", { pauseReason: "user" })
    await repository.updateTask(task.id, { attempt: 2, lastError: "retry" })
    await repository.releaseTaskReservation(task.id)
    expect(await getDb().evalTasks.get(task.id)).toMatchObject({
      attempt: 2,
      lastError: "retry",
      reservedCost: 0,
    })
    expect(await getDb().evalExperiments.get(manifest.id)).toMatchObject({
      state: "paused",
      reservedCost: 0,
    })

    await getDb().evalTasks.update(task.id, { state: "running", reservedCost: 0.1 })
    await getDb().evalExperiments.update(manifest.id, { reservedCost: 0.1 })
    await repository.completeTask(
      { ...task, attempt: 2, state: "running", reservedCost: 0.1 },
      {
        actualCost: sample.costUsd,
        value: {
          sample: {
            id: "sample-repository",
            experimentId: manifest.id,
            taskId: task.id,
            variantId: variant.id,
            caseId: evalCase.id,
            repetition: 1,
            encryptedArtifact: {
              version: "cognia-eval-encrypted/v1",
              algorithm: "AES-GCM",
              iv: "iv",
              ciphertext: "ciphertext",
            },
            latencyMs: 1,
            actualCost: sample.costUsd,
            createdAt: 1,
            expiresAt: 2,
          },
          scores: [],
        },
      }
    )
    expect(await getDb().evalSamples.get("sample-repository")).toBeDefined()
    expect(await getDb().evalTasks.get(task.id)).toMatchObject({ state: "completed" })
  })

  it("returns false for missing/terminal reservations and no-ops released tasks", async () => {
    const repository = new DexieEvalOrchestratorRepository()
    await expect(repository.getExperiment("missing")).resolves.toBeUndefined()
    await expect(repository.reserveTask("missing", 1)).resolves.toBe(false)
    await getDb().evalTasks.add({ ...task, state: "completed" })
    await expect(repository.reserveTask(task.id, 1)).resolves.toBe(false)
    await expect(repository.releaseTaskReservation(task.id)).resolves.toBeUndefined()
  })

  it("delegates adaptive/recommendation finalization to the persisted stage planner", async () => {
    const repository = new DexieEvalOrchestratorRepository()
    await expect(repository.prepareNextStage(manifest.id)).resolves.toBe(false)
    expect(
      await getDb().evalRecommendations.where("experimentId").equals(manifest.id).count()
    ).toBe(1)
  })
})
