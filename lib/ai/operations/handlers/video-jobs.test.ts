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
  videosContentOutput,
  videosGetOutput,
  type ProviderOperationId,
} from "@cognia/provider-types"
import type { ResolvedProvider } from "@/lib/ai/provider-consumption"

import { providerJobRegistry } from "../job-handle"
import { getProviderOperationDescriptor } from "../manifest"
import { handleFor } from "../resource-handle"
import { videosCancelHandler, videosContentHandler, videosGetHandler } from "./video-jobs"

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
const handlers = {
  "videos.get": videosGetHandler,
  "videos.cancel": videosCancelHandler,
  "videos.content": videosContentHandler,
}
function run(operationId: keyof typeof handlers, provider: ResolvedProvider, input: unknown) {
  return handlers[operationId].handler({
    descriptor: getProviderOperationDescriptor(operationId as ProviderOperationId)!,
    provider,
    settings,
    request: {
      operationId,
      scopes: ["provider:invoke"],
      surface: "sidecar",
      input: input as never,
      deploymentRef: "dep-1",
    },
  })
}

describe("video job handlers", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    providerJobRegistry.clear()
  })

  it("answers a locally completed job from the registry without a network call", async () => {
    const provider = resolved("doubao", "openai", "https://ark/v3")
    const handle = handleFor({
      kind: "video",
      id: "local-1",
      owner: provider,
      deploymentRef: "dep-1",
    })
    providerJobRegistry.register({
      handle,
      status: "succeeded",
      content: { base64: "dg==", mimeType: "video/mp4" },
    })
    expect(videosGetOutput.parse(await run("videos.get", provider, { handle }))).toEqual({
      handle,
      status: "succeeded",
      progress: 1,
    })
    expect(videosGetOutput.parse(await run("videos.cancel", provider, { handle }))).toMatchObject({
      status: "succeeded",
    })
    expect(videosContentOutput.parse(await run("videos.content", provider, { handle }))).toEqual({
      video: { base64: "dg==", mimeType: "video/mp4" },
    })
    expect(http.providerRequest).not.toHaveBeenCalled()
  })

  it("refuses an unknown job on a vendor without a wired job API, and a foreign handle", async () => {
    const provider = resolved("doubao", "openai", "https://ark/v3")
    const stranger = handleFor({
      kind: "video",
      id: "gone",
      owner: { providerId: "stepfun", apiKey: "k" },
    })
    await expect(run("videos.get", provider, { handle: stranger })).rejects.toMatchObject({
      failure: { code: "permission" },
    })
    const fal = resolved("fal", "openai", "https://fal.run")
    const unknown = handleFor({ kind: "video", id: "gone", owner: fal })
    http.providerRequest.mockResolvedValueOnce({ json: { id: "gone", status: "queued" } })
    await expect(run("videos.get", fal, { handle: unknown })).resolves.toMatchObject({
      status: "queued",
    })
    const bedrock = resolved("bedrock", "bedrock")
    const bedrockHandle = handleFor({ kind: "video", id: "gone", owner: bedrock })
    await expect(run("videos.get", bedrock, { handle: bedrockHandle })).rejects.toThrow(
      /no record of video job/
    )
  })

  it("reads, cancels and downloads OpenAI video jobs", async () => {
    const provider = resolved("openai", "openai", "https://api.openai.com/v1")
    const handle = handleFor({ kind: "video", id: "video_1", owner: provider })
    http.providerRequest.mockResolvedValueOnce({
      json: { id: "video_1", status: "in_progress", progress: 40 },
    })
    expect(videosGetOutput.parse(await run("videos.get", provider, { handle }))).toEqual({
      handle,
      status: "running",
      progress: 0.4,
    })
    http.providerRequest.mockResolvedValueOnce({ json: { id: "video_1", deleted: true } })
    expect(await run("videos.cancel", provider, { handle })).toEqual({
      handle,
      status: "cancelled",
    })
    expect(http.providerRequest).toHaveBeenLastCalledWith(
      provider,
      expect.objectContaining({ method: "DELETE", path: "videos/video_1" })
    )
    http.providerDownload.mockResolvedValueOnce({
      bytes: new Uint8Array([1]),
      mimeType: "video/mp4",
    })
    const content = videosContentOutput.parse(await run("videos.content", provider, { handle }))
    expect(content.video.mimeType).toBe("video/mp4")
    expect(http.providerDownload).toHaveBeenCalledWith(
      provider,
      expect.objectContaining({ path: "videos/video_1/content" })
    )
  })

  it("reads Veo operations, downloads the sample uri, and refuses to cancel", async () => {
    const provider = resolved("google", "google")
    const handle = handleFor({ kind: "video", id: "models/veo/operations/op1", owner: provider })
    http.providerRequest.mockResolvedValueOnce({ json: { name: handle.id, done: false } })
    expect(videosGetOutput.parse(await run("videos.get", provider, { handle }))).toEqual({
      handle,
      status: "running",
    })
    http.providerRequest.mockResolvedValueOnce({
      json: {
        name: handle.id,
        done: true,
        response: {
          generateVideoResponse: {
            generatedSamples: [{ video: { uri: "https://g/v1beta/files/v:download?alt=media" } }],
          },
        },
      },
    })
    http.providerDownload.mockResolvedValueOnce({ bytes: new Uint8Array([1]) })
    await run("videos.content", provider, { handle })
    expect(http.providerDownload).toHaveBeenCalledWith(
      provider,
      expect.objectContaining({ baseURL: "https://g/v1beta/files/v:download?alt=media", path: "" })
    )
    http.providerRequest.mockResolvedValueOnce({ json: { name: handle.id, done: false } })
    await expect(run("videos.content", provider, { handle })).rejects.toMatchObject({
      failure: { code: "model-unavailable", retryable: true },
    })
    await expect(run("videos.cancel", provider, { handle })).rejects.toMatchObject({
      failure: { code: "capability-unsupported" },
    })
  })
})
