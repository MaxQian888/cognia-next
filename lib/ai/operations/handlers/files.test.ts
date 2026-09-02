/** @jest-environment node */
jest.mock("./http", () => ({
  ...jest.requireActual("./http"),
  providerRequest: jest.fn(),
  providerUpload: jest.fn(),
  providerDownload: jest.fn(),
}))
const http = jest.requireMock("./http") as {
  providerRequest: jest.Mock
  providerUpload: jest.Mock
  providerDownload: jest.Mock
}

import {
  filesContentOutput,
  filesDeleteOutput,
  filesListOutput,
  filesUploadOutput,
  type ProviderOperationId,
} from "@cognia/provider-types"
import type { ResolvedProvider } from "@/lib/ai/provider-consumption"

import { getProviderOperationDescriptor } from "../manifest"
import { ProviderOperationHandlerRegistry } from "../registry"
import { handleFor } from "../resource-handle"
import { FILES_HANDLERS, geminiMultipartRelated, geminiRootOf } from "./files"

const registry = new ProviderOperationHandlerRegistry()
for (const handler of FILES_HANDLERS) registry.register(handler)

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
      scopes: ["provider:files"],
      surface: "sidecar",
      input,
      deploymentRef: "dep-1",
    },
  })
}

describe("files handlers", () => {
  beforeEach(() => jest.clearAllMocks())

  it("binds the OpenAI wire to the openai and azure protocols, anthropic and google to their own, and gives google no content read", () => {
    expect(registry.resolve("files.upload", "groq", "openai")?.providerMatch).toEqual({
      kind: "protocol",
      protocol: "openai",
    })
    expect(registry.resolve("files.upload", "azure", "azure")?.providerMatch).toEqual({
      kind: "protocol",
      protocol: "azure",
    })
    expect(registry.resolve("files.content", "anthropic", "anthropic")).toBeDefined()
    expect(registry.resolve("files.content", "google", "google")).toBeUndefined()
    expect(registry.resolve("files.upload", "mistral", "mistral")).toBeUndefined()
  })

  it("uploads, lists, reads and deletes over the OpenAI wire with pinned handles", async () => {
    const provider = resolved("openai", "openai", "https://api.openai.com/v1")
    http.providerUpload.mockResolvedValueOnce({
      json: {
        id: "file-1",
        filename: "a.txt",
        bytes: 2,
        purpose: "assistants",
        created_at: 1_700_000_000,
      },
    })
    const uploaded = await run("files.upload", provider, {
      filename: "a.txt",
      content: { base64: "aGk=", mimeType: "text/plain" },
    })
    const file = filesUploadOutput.parse(uploaded)
    expect(file).toMatchObject({
      filename: "a.txt",
      bytes: 2,
      purpose: "assistants",
      createdAt: 1_700_000_000_000,
    })
    expect(file.handle).toMatchObject({
      kind: "file",
      id: "file-1",
      providerId: "openai",
      deploymentRef: "dep-1",
    })
    expect(file.handle.credentialAffinity).not.toContain("k")
    const form = http.providerUpload.mock.calls[0][1].form as FormData
    expect(form.get("purpose")).toBe("assistants")
    expect((form.get("file") as File).name).toBe("a.txt")

    http.providerRequest.mockResolvedValueOnce({
      json: { data: [{ id: "file-1", filename: "a.txt" }], has_more: true, last_id: "file-1" },
    })
    const listed = filesListOutput.parse(
      await run("files.list", provider, { purpose: "assistants", limit: 5 })
    )
    expect(http.providerRequest).toHaveBeenLastCalledWith(
      provider,
      expect.objectContaining({ path: "files?purpose=assistants&limit=5" })
    )
    expect(listed.items).toHaveLength(1)
    expect(listed.nextCursor).toBe("file-1")

    http.providerRequest.mockResolvedValueOnce({
      json: { id: "file-1", filename: "a.txt", bytes: 2 },
    })
    expect(
      filesUploadOutput.parse(await run("files.get", provider, { handle: file.handle }))
    ).toMatchObject({ filename: "a.txt" })

    http.providerDownload.mockResolvedValueOnce({
      bytes: new Uint8Array([104, 105]),
      mimeType: "text/plain",
    })
    const content = filesContentOutput.parse(
      await run("files.content", provider, { handle: file.handle })
    )
    expect(content.content.base64).toBe("aGk=")
    expect(http.providerDownload).toHaveBeenCalledWith(
      provider,
      expect.objectContaining({ path: "files/file-1/content" })
    )

    http.providerRequest.mockResolvedValueOnce({ json: { id: "file-1", deleted: true } })
    expect(
      filesDeleteOutput.parse(await run("files.delete", provider, { handle: file.handle }))
    ).toEqual({ id: "file-1", deleted: true })
    expect(http.providerRequest).toHaveBeenLastCalledWith(
      provider,
      expect.objectContaining({ method: "DELETE", path: "files/file-1" })
    )
  })

  it("refuses a handle from another provider or credential before any call", async () => {
    const provider = resolved("openai", "openai", "https://api.openai.com/v1")
    const foreign = handleFor({ kind: "file", id: "f", owner: { providerId: "groq", apiKey: "k" } })
    await expect(run("files.get", provider, { handle: foreign })).rejects.toMatchObject({
      failure: { code: "permission" },
    })
    const rotated = handleFor({
      kind: "file",
      id: "f",
      owner: { providerId: "openai", apiKey: "other" },
    })
    await expect(run("files.delete", provider, { handle: rotated })).rejects.toMatchObject({
      failure: { code: "authentication" },
    })
    expect(http.providerRequest).not.toHaveBeenCalled()
  })

  it("sends the anthropic beta header on every files call", async () => {
    const provider = resolved("anthropic", "anthropic")
    http.providerUpload.mockResolvedValueOnce({
      json: { id: "file_x", filename: "a.txt", size_bytes: 2, created_at: "2026-09-01T00:00:00Z" },
    })
    const file = filesUploadOutput.parse(
      await run("files.upload", provider, { filename: "a.txt", content: { base64: "aGk=" } })
    )
    expect(file).toMatchObject({ bytes: 2, createdAt: Date.parse("2026-09-01T00:00:00Z") })
    expect(http.providerUpload.mock.calls[0][1].headers).toEqual({
      "anthropic-beta": "files-api-2025-04-14",
    })
    http.providerRequest.mockResolvedValueOnce({ json: { data: [], has_more: false } })
    await run("files.list", provider, { after: "file_x" })
    expect(http.providerRequest).toHaveBeenLastCalledWith(
      provider,
      expect.objectContaining({
        path: "files?after_id=file_x",
        headers: { "anthropic-beta": "files-api-2025-04-14" },
      })
    )
  })

  it("uploads to gemini as multipart/related under the upload root and uses resource names as ids", async () => {
    const provider = resolved("google", "google")
    expect(geminiRootOf(provider)).toBe("https://generativelanguage.googleapis.com")
    const related = geminiMultipartRelated({
      filename: "a.txt",
      content: { base64: "aGk=", mimeType: "text/plain" },
    })
    expect(related.contentType).toMatch(/^multipart\/related; boundary=/)
    const text = await related.body.text()
    expect(text).toContain('{"file":{"display_name":"a.txt"}}')
    expect(text).toContain("content-type: text/plain")
    expect(text).toContain("hi")

    http.providerRequest.mockResolvedValueOnce({
      json: {
        file: {
          name: "files/abc",
          displayName: "a.txt",
          sizeBytes: "2",
          createTime: "2026-09-01T00:00:00Z",
        },
      },
    })
    const file = filesUploadOutput.parse(
      await run("files.upload", provider, { filename: "a.txt", content: { base64: "aGk=" } })
    )
    expect(file.handle.id).toBe("files/abc")
    expect(file.bytes).toBe(2)
    expect(http.providerRequest).toHaveBeenCalledWith(
      provider,
      expect.objectContaining({
        baseURL: "https://generativelanguage.googleapis.com",
        path: "upload/v1beta/files?uploadType=multipart",
        rawBody: expect.objectContaining({
          contentType: expect.stringContaining("multipart/related"),
        }),
      })
    )

    http.providerRequest.mockResolvedValueOnce({
      json: { files: [{ name: "files/abc" }], nextPageToken: "tok" },
    })
    const listed = filesListOutput.parse(await run("files.list", provider, { limit: 10 }))
    expect(listed.nextCursor).toBe("tok")
    expect(http.providerRequest).toHaveBeenLastCalledWith(
      provider,
      expect.objectContaining({ path: "files?pageSize=10" })
    )

    http.providerRequest.mockResolvedValueOnce({ json: {} })
    expect(await run("files.delete", provider, { handle: file.handle })).toEqual({
      id: "files/abc",
      deleted: true,
    })
    expect(http.providerRequest).toHaveBeenLastCalledWith(
      provider,
      expect.objectContaining({ method: "DELETE", path: "files/abc" })
    )
  })
})
