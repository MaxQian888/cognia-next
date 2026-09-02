/** @jest-environment node */
jest.mock("./http", () => ({ ...jest.requireActual("./http"), providerRequest: jest.fn() }))
const http = jest.requireMock("./http") as { providerRequest: jest.Mock }

import {
  fineTuningCheckpointsListOutput,
  fineTuningEventsListOutput,
  fineTuningJobsCreateOutput,
  fineTuningJobsListOutput,
  type ProviderOperationId,
} from "@cognia/provider-types"
import type { ResolvedProvider } from "@/lib/ai/provider-consumption"

import { getProviderOperationDescriptor } from "../manifest"
import { ProviderOperationHandlerRegistry } from "../registry"
import { handleFor } from "../resource-handle"
import { FINE_TUNING_HANDLERS } from "./fine-tuning"

const registry = new ProviderOperationHandlerRegistry()
for (const handler of FINE_TUNING_HANDLERS) registry.register(handler)

function resolved(
  providerId: string,
  protocol: ResolvedProvider["protocol"],
  baseURL?: string
): ResolvedProvider {
  return {
    kind: "resolved",
    providerId,
    protocol,
    apiKey: "k",
    baseURL,
    model: undefined,
    isCustomProvider: false,
    useProxy: false,
  }
}
const settings = { defaultProvider: undefined, providers: {}, customProviders: [] }
function run(operationId: ProviderOperationId, provider: ResolvedProvider, input: unknown) {
  const registration = registry.resolve(operationId, provider.providerId, provider.protocol)
  if (!registration) throw new Error(`no handler for ${operationId} on ${provider.providerId}`)
  return registration.handler({
    descriptor: getProviderOperationDescriptor(operationId)!,
    provider,
    settings,
    request: {
      operationId,
      scopes: ["provider:jobs"],
      surface: "sidecar",
      input,
      deploymentRef: "dep-1",
    },
  })
}

describe("fine-tuning handlers", () => {
  beforeEach(() => jest.clearAllMocks())

  it("binds mistral and together by provider, the OpenAI wire by protocol, and nothing for cohere or google", () => {
    expect(registry.resolve("fine-tuning.jobs.create", "mistral", "openai")?.providerMatch).toEqual(
      { kind: "provider", providerId: "mistral" }
    )
    expect(
      registry.resolve("fine-tuning.jobs.create", "togetherai", "openai")?.providerMatch
    ).toEqual({ kind: "provider", providerId: "togetherai" })
    expect(registry.resolve("fine-tuning.jobs.create", "groq", "openai")?.providerMatch).toEqual({
      kind: "protocol",
      protocol: "openai",
    })
    expect(registry.resolve("fine-tuning.jobs.create", "cohere", "cohere")).toBeUndefined()
    expect(registry.resolve("fine-tuning.jobs.create", "google", "google")).toBeUndefined()
  })

  it("drives the OpenAI job lifecycle, events and checkpoints", async () => {
    const provider = resolved("openai", "openai", "https://api.openai.com/v1")
    const training = handleFor({ kind: "file", id: "file-train", owner: provider })
    http.providerRequest.mockResolvedValueOnce({
      json: {
        id: "ftjob-1",
        status: "validating_files",
        model: "gpt-base",
        fine_tuned_model: null,
        created_at: 1_700_000_000,
      },
    })
    const created = fineTuningJobsCreateOutput.parse(
      await run("fine-tuning.jobs.create", provider, {
        baseModel: "gpt-base",
        trainingFile: training,
        hyperparameters: { n_epochs: 2 },
        suffix: "kb",
      })
    )
    expect(created).toMatchObject({
      status: "queued",
      baseModel: "gpt-base",
      fineTunedModel: null,
      createdAt: 1_700_000_000_000,
    })
    expect(created.handle).toMatchObject({ kind: "fine-tuning-job", id: "ftjob-1" })
    expect(http.providerRequest).toHaveBeenCalledWith(
      provider,
      expect.objectContaining({
        path: "fine_tuning/jobs",
        body: {
          model: "gpt-base",
          training_file: "file-train",
          hyperparameters: { n_epochs: 2 },
          suffix: "kb",
        },
      })
    )

    http.providerRequest.mockResolvedValueOnce({
      json: {
        data: [
          {
            id: "ftjob-1",
            status: "succeeded",
            model: "gpt-base",
            fine_tuned_model: "ft:gpt-base:kb",
          },
        ],
        has_more: false,
      },
    })
    const listed = fineTuningJobsListOutput.parse(await run("fine-tuning.jobs.list", provider, {}))
    expect(listed.items[0]).toMatchObject({ status: "succeeded", fineTunedModel: "ft:gpt-base:kb" })

    http.providerRequest.mockResolvedValueOnce({
      json: { id: "ftjob-1", status: "cancelled", model: "gpt-base" },
    })
    expect(
      fineTuningJobsCreateOutput.parse(
        await run("fine-tuning.jobs.cancel", provider, { handle: created.handle })
      ).status
    ).toBe("cancelled")
    expect(http.providerRequest).toHaveBeenLastCalledWith(
      provider,
      expect.objectContaining({ method: "POST", path: "fine_tuning/jobs/ftjob-1/cancel" })
    )

    http.providerRequest.mockResolvedValueOnce({
      json: {
        data: [{ id: "ev1", created_at: 1_700_000_001, level: "info", message: "started" }],
        has_more: true,
      },
    })
    const events = fineTuningEventsListOutput.parse(
      await run("fine-tuning.events.list", provider, { handle: created.handle, limit: 1 })
    )
    expect(events.items).toEqual([
      { id: "ev1", createdAt: 1_700_000_001_000, level: "info", message: "started" },
    ])
    expect(events.nextCursor).toBe("ev1")
    expect(http.providerRequest).toHaveBeenLastCalledWith(
      provider,
      expect.objectContaining({ path: "fine_tuning/jobs/ftjob-1/events?limit=1" })
    )

    http.providerRequest.mockResolvedValueOnce({
      json: {
        data: [
          {
            id: "ck1",
            step_number: 10,
            fine_tuned_model_checkpoint: "ft:gpt-base:kb:ckpt-step-10",
            created_at: 1_700_000_002,
          },
        ],
        has_more: false,
      },
    })
    const checkpoints = fineTuningCheckpointsListOutput.parse(
      await run("fine-tuning.checkpoints.list", provider, { handle: created.handle })
    )
    expect(checkpoints.items).toEqual([
      {
        id: "ck1",
        stepNumber: 10,
        fineTunedModelCheckpoint: "ft:gpt-base:kb:ckpt-step-10",
        createdAt: 1_700_000_002_000,
      },
    ])
  })

  it("refuses a training file from another credential and a handle of the wrong kind", async () => {
    const provider = resolved("openai", "openai", "https://api.openai.com/v1")
    const rotated = handleFor({
      kind: "file",
      id: "f",
      owner: { providerId: "openai", apiKey: "other" },
    })
    await expect(
      run("fine-tuning.jobs.create", provider, { baseModel: "m", trainingFile: rotated })
    ).rejects.toMatchObject({ failure: { code: "authentication" } })
    const file = handleFor({ kind: "file", id: "f", owner: provider })
    await expect(run("fine-tuning.events.list", provider, { handle: file })).rejects.toThrow(
      /expected a fine-tuning-job handle/
    )
    expect(http.providerRequest).not.toHaveBeenCalled()
  })

  it("posts mistral training files as objects and reads events and checkpoints off the job", async () => {
    const provider = resolved("mistral", "openai", "https://api.mistral.ai/v1")
    const training = handleFor({ kind: "file", id: "file-m", owner: provider })
    http.providerRequest.mockResolvedValueOnce({
      json: { id: "job-m", status: "QUEUED", model: "open-mistral-7b", created_at: 1_700_000_000 },
    })
    const created = fineTuningJobsCreateOutput.parse(
      await run("fine-tuning.jobs.create", provider, {
        baseModel: "open-mistral-7b",
        trainingFile: training,
      })
    )
    expect(created.status).toBe("queued")
    expect(http.providerRequest).toHaveBeenCalledWith(
      provider,
      expect.objectContaining({
        body: {
          model: "open-mistral-7b",
          training_files: [{ file_id: "file-m" }],
          auto_start: true,
        },
      })
    )
    http.providerRequest.mockResolvedValueOnce({
      json: {
        id: "job-m",
        status: "SUCCESS",
        model: "open-mistral-7b",
        fine_tuned_model: "ft:open-mistral-7b:abc",
        events: [
          { name: "status-updated", data: { status: "RUNNING" }, created_at: 1_700_000_001 },
        ],
        checkpoints: [{ metrics: { train_loss: 0.1 }, step_number: 5, created_at: 1_700_000_002 }],
      },
    })
    const events = fineTuningEventsListOutput.parse(
      await run("fine-tuning.events.list", provider, { handle: created.handle })
    )
    expect(events.items[0]).toMatchObject({
      createdAt: 1_700_000_001_000,
      message: 'status-updated {"status":"RUNNING"}',
    })
    http.providerRequest.mockResolvedValueOnce({
      json: {
        id: "job-m",
        fine_tuned_model: "ft:open-mistral-7b:abc",
        checkpoints: [{ step_number: 5, created_at: 1_700_000_002 }],
      },
    })
    const checkpoints = fineTuningCheckpointsListOutput.parse(
      await run("fine-tuning.checkpoints.list", provider, { handle: created.handle })
    )
    expect(checkpoints.items[0]).toMatchObject({
      stepNumber: 5,
      fineTunedModelCheckpoint: "ft:open-mistral-7b:abc",
    })
  })

  it("drives together jobs under /fine-tunes with ISO timestamps", async () => {
    const provider = resolved("togetherai", "openai", "https://api.together.xyz/v1")
    const training = handleFor({ kind: "file", id: "file-t", owner: provider })
    http.providerRequest.mockResolvedValueOnce({
      json: {
        id: "ft-t",
        status: "pending",
        model: "meta/llama",
        created_at: "2026-09-01T00:00:00Z",
      },
    })
    const created = fineTuningJobsCreateOutput.parse(
      await run("fine-tuning.jobs.create", provider, {
        baseModel: "meta/llama",
        trainingFile: training,
        hyperparameters: { n_epochs: 1 },
      })
    )
    expect(created).toMatchObject({
      status: "queued",
      createdAt: Date.parse("2026-09-01T00:00:00Z"),
    })
    expect(http.providerRequest).toHaveBeenCalledWith(
      provider,
      expect.objectContaining({
        path: "fine-tunes",
        body: { model: "meta/llama", training_file: "file-t", n_epochs: 1 },
      })
    )
    http.providerRequest.mockResolvedValueOnce({
      json: { data: [{ name: "ft-t-step-3", step: 3, timestamp: "2026-09-01T01:00:00Z" }] },
    })
    const checkpoints = fineTuningCheckpointsListOutput.parse(
      await run("fine-tuning.checkpoints.list", provider, { handle: created.handle })
    )
    expect(checkpoints.items[0]).toEqual({
      id: "ft-t-step-3",
      stepNumber: 3,
      fineTunedModelCheckpoint: "ft-t-step-3",
      createdAt: Date.parse("2026-09-01T01:00:00Z"),
    })
  })
})
