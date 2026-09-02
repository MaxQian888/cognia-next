/** @jest-environment node */
jest.mock("./http", () => ({
  ...jest.requireActual("./http"),
  providerRequest: jest.fn(),
  providerDownload: jest.fn(),
}))
const http = jest.requireMock("./http") as {
  providerRequest: jest.Mock
  providerDownload: jest.Mock
}

import {
  batchesCreateOutput,
  batchesListOutput,
  batchesResultsOutput,
  type ProviderOperationId,
} from "@cognia/provider-types"
import type { ResolvedProvider } from "@/lib/ai/provider-consumption"

import { getProviderOperationDescriptor } from "../manifest"
import { ProviderOperationHandlerRegistry } from "../registry"
import { handleFor } from "../resource-handle"
import { BATCHES_HANDLERS, anthropicBatchRequest } from "./batches"

const registry = new ProviderOperationHandlerRegistry()
for (const handler of BATCHES_HANDLERS) registry.register(handler)

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

describe("batch handlers", () => {
  beforeEach(() => jest.clearAllMocks())

  it("binds mistral by provider ahead of the openai protocol, anthropic as translated", () => {
    expect(registry.resolve("batches.create", "mistral", "openai")?.providerMatch).toEqual({
      kind: "provider",
      providerId: "mistral",
    })
    expect(registry.resolve("batches.create", "groq", "openai")?.providerMatch).toEqual({
      kind: "protocol",
      protocol: "openai",
    })
    expect(registry.resolve("batches.create", "anthropic", "anthropic")?.support).toBe("translated")
    expect(registry.resolve("batches.create", "cohere", "cohere")).toBeUndefined()
  })

  it("drives the OpenAI batch lifecycle and reads results back as file handles plus bytes", async () => {
    const provider = resolved("openai", "openai", "https://api.openai.com/v1")
    const inputFile = handleFor({ kind: "file", id: "file-in", owner: provider })
    http.providerRequest.mockResolvedValueOnce({
      json: {
        id: "batch-1",
        status: "validating",
        endpoint: "/v1/chat/completions",
        request_counts: { total: 3, completed: 0, failed: 0 },
        created_at: 1_700_000_000,
      },
    })
    const created = batchesCreateOutput.parse(
      await run("batches.create", provider, { inputFile, endpoint: "/v1/chat/completions" })
    )
    expect(created).toMatchObject({
      status: "running",
      endpoint: "/v1/chat/completions",
      counts: { total: 3, completed: 0, failed: 0 },
      createdAt: 1_700_000_000_000,
    })
    expect(created.handle).toMatchObject({ kind: "batch", id: "batch-1", deploymentRef: "dep-1" })
    expect(http.providerRequest).toHaveBeenCalledWith(
      provider,
      expect.objectContaining({
        path: "batches",
        body: {
          input_file_id: "file-in",
          endpoint: "/v1/chat/completions",
          completion_window: "24h",
        },
      })
    )

    http.providerRequest.mockResolvedValueOnce({
      json: { data: [{ id: "batch-1", status: "completed" }], has_more: false },
    })
    const listed = batchesListOutput.parse(await run("batches.list", provider, { limit: 10 }))
    expect(listed.items[0].status).toBe("succeeded")

    http.providerRequest.mockResolvedValueOnce({ json: { id: "batch-1", status: "cancelling" } })
    expect(
      batchesCreateOutput.parse(await run("batches.cancel", provider, { handle: created.handle }))
        .status
    ).toBe("cancelled")
    expect(http.providerRequest).toHaveBeenLastCalledWith(
      provider,
      expect.objectContaining({ method: "POST", path: "batches/batch-1/cancel" })
    )

    http.providerRequest.mockResolvedValueOnce({
      json: { id: "batch-1", status: "completed", output_file_id: "file-out", error_file_id: null },
    })
    http.providerDownload.mockResolvedValueOnce({
      bytes: new TextEncoder().encode('{"ok":1}\n'),
      mimeType: "application/jsonl",
    })
    const results = batchesResultsOutput.parse(
      await run("batches.results", provider, { handle: created.handle })
    )
    expect(results.outputFile).toMatchObject({ kind: "file", id: "file-out", providerId: "openai" })
    expect(results.errorFile).toBeUndefined()
    expect(results.content?.base64).toBe(Buffer.from('{"ok":1}\n').toString("base64"))
    expect(http.providerDownload).toHaveBeenCalledWith(
      provider,
      expect.objectContaining({ path: "files/file-out/content" })
    )
  })

  it("refuses an input file from another credential before any call", async () => {
    const provider = resolved("openai", "openai", "https://api.openai.com/v1")
    const rotated = handleFor({
      kind: "file",
      id: "f",
      owner: { providerId: "openai", apiKey: "other" },
    })
    await expect(
      run("batches.create", provider, { inputFile: rotated, endpoint: "/v1/chat/completions" })
    ).rejects.toMatchObject({ failure: { code: "authentication" } })
    expect(http.providerRequest).not.toHaveBeenCalled()
  })

  it("translates an anthropic batch: reads the JSONL back, posts inline, streams results", async () => {
    const provider = resolved("anthropic", "anthropic")
    const inputFile = handleFor({ kind: "file", id: "file_in", owner: provider })
    const jsonl = [
      JSON.stringify({ custom_id: "a", params: { model: "claude", max_tokens: 5, messages: [] } }),
      JSON.stringify({
        custom_id: "b",
        method: "POST",
        url: "/v1/messages",
        body: { model: "claude", max_tokens: 5, messages: [] },
      }),
    ].join("\n")
    http.providerDownload.mockResolvedValueOnce({ bytes: new TextEncoder().encode(jsonl) })
    http.providerRequest.mockResolvedValueOnce({
      json: {
        id: "msgbatch_1",
        processing_status: "in_progress",
        request_counts: { processing: 2, succeeded: 0, errored: 0, canceled: 0, expired: 0 },
        created_at: "2026-09-01T00:00:00Z",
      },
    })
    const created = batchesCreateOutput.parse(
      await run("batches.create", provider, { inputFile, endpoint: "/v1/messages" })
    )
    expect(created).toMatchObject({
      status: "running",
      counts: { total: 2, completed: 0, failed: 0 },
    })
    expect(http.providerDownload).toHaveBeenCalledWith(
      provider,
      expect.objectContaining({
        path: "files/file_in/content",
        headers: { "anthropic-beta": "files-api-2025-04-14" },
      })
    )
    const body = http.providerRequest.mock.calls[0][1].body as {
      requests: Array<{ custom_id: string }>
    }
    expect(body.requests.map((request) => request.custom_id)).toEqual(["a", "b"])
    expect(() => anthropicBatchRequest('{"custom_id":"x"}')).toThrow(/neither params nor body/)

    http.providerRequest.mockResolvedValueOnce({
      json: {
        id: "msgbatch_1",
        processing_status: "ended",
        request_counts: { processing: 0, succeeded: 1, errored: 1, canceled: 0, expired: 0 },
      },
    })
    expect(
      batchesCreateOutput.parse(await run("batches.get", provider, { handle: created.handle }))
    ).toMatchObject({ status: "succeeded", counts: { total: 2, completed: 1, failed: 1 } })

    http.providerDownload.mockResolvedValueOnce({
      bytes: new TextEncoder().encode('{"custom_id":"a"}\n'),
    })
    const results = batchesResultsOutput.parse(
      await run("batches.results", provider, { handle: created.handle })
    )
    expect(results.content?.mimeType).toBe("application/x-ndjson")
    expect(http.providerDownload).toHaveBeenLastCalledWith(
      provider,
      expect.objectContaining({ path: "messages/batches/msgbatch_1/results" })
    )
  })

  it("runs a gemini batch against the model named by the endpoint and downloads the responses file", async () => {
    const provider = resolved("google", "google")
    const inputFile = handleFor({ kind: "file", id: "files/in", owner: provider })
    http.providerRequest.mockResolvedValueOnce({
      json: {
        name: "batches/b1",
        metadata: {
          state: "BATCH_STATE_PENDING",
          createTime: "2026-09-01T00:00:00Z",
          model: "models/gemini-2.5-flash",
        },
      },
    })
    const created = batchesCreateOutput.parse(
      await run("batches.create", provider, { inputFile, endpoint: "models/gemini-2.5-flash" })
    )
    expect(created).toMatchObject({ status: "queued", endpoint: "models/gemini-2.5-flash" })
    expect(http.providerRequest).toHaveBeenCalledWith(
      provider,
      expect.objectContaining({
        path: "models/gemini-2.5-flash:batchGenerateContent",
        body: { batch: { inputConfig: { fileName: "files/in" } } },
      })
    )

    http.providerRequest.mockResolvedValueOnce({
      json: {
        name: "batches/b1",
        done: true,
        metadata: {
          state: "BATCH_STATE_SUCCEEDED",
          batchStats: { requestCount: "2", successfulRequestCount: "2", failedRequestCount: "0" },
        },
        response: { responsesFile: "files/out" },
      },
    })
    http.providerDownload.mockResolvedValueOnce({ bytes: new Uint8Array([123, 125]) })
    const results = batchesResultsOutput.parse(
      await run("batches.results", provider, { handle: created.handle })
    )
    expect(results.outputFile?.id).toBe("files/out")
    expect(http.providerDownload).toHaveBeenCalledWith(
      provider,
      expect.objectContaining({
        baseURL: "https://generativelanguage.googleapis.com",
        path: "download/v1beta/files/out:download?alt=media",
      })
    )

    http.providerRequest.mockResolvedValueOnce({ json: {} })
    http.providerRequest.mockResolvedValueOnce({
      json: { name: "batches/b1", metadata: { state: "BATCH_STATE_CANCELLED" } },
    })
    expect(
      batchesCreateOutput.parse(await run("batches.cancel", provider, { handle: created.handle }))
        .status
    ).toBe("cancelled")
  })

  it("pages mistral batch jobs by page number", async () => {
    const provider = resolved("mistral", "openai", "https://api.mistral.ai/v1")
    http.providerRequest.mockResolvedValueOnce({
      json: { data: [{ id: "j1", status: "QUEUED", total_requests: 1 }], total: 3 },
    })
    const listed = batchesListOutput.parse(await run("batches.list", provider, { limit: 1 }))
    expect(listed.items[0]).toMatchObject({
      status: "queued",
      counts: { total: 1, completed: 0, failed: 0 },
    })
    expect(listed.nextCursor).toBe("1")
    expect(http.providerRequest).toHaveBeenCalledWith(
      provider,
      expect.objectContaining({ path: "batch/jobs?page=0&page_size=1" })
    )
  })
})
