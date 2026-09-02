/** @jest-environment node */
jest.mock("./http", () => ({ ...jest.requireActual("./http"), providerRequest: jest.fn() }))
const http = jest.requireMock("./http") as { providerRequest: jest.Mock }

import {
  vectorStoresCreateOutput,
  vectorStoresDeleteOutput,
  vectorStoresFilesAddOutput,
  vectorStoresListOutput,
  type ProviderOperationId,
} from "@cognia/provider-types"
import type { ResolvedProvider } from "@/lib/ai/provider-consumption"

import { getProviderOperationDescriptor } from "../manifest"
import { ProviderOperationHandlerRegistry } from "../registry"
import { handleFor } from "../resource-handle"
import { VECTOR_STORES_HANDLERS } from "./vector-stores"

const registry = new ProviderOperationHandlerRegistry()
for (const handler of VECTOR_STORES_HANDLERS) registry.register(handler)

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
      scopes: ["provider:write", "provider:files"],
      surface: "sidecar",
      input,
      deploymentRef: "dep-1",
    },
  })
}

describe("vector store handlers", () => {
  beforeEach(() => jest.clearAllMocks())

  it("binds the OpenAI wire to openai and azure and the File Search wire to google, nothing to anthropic", () => {
    expect(registry.resolve("vector-stores.create", "openai", "openai")).toBeDefined()
    expect(registry.resolve("vector-stores.create", "azure", "azure")).toBeDefined()
    expect(registry.resolve("vector-stores.create", "google", "google")).toBeDefined()
    expect(registry.resolve("vector-stores.create", "anthropic", "anthropic")).toBeUndefined()
  })

  it("drives the OpenAI vector store lifecycle with pinned handles", async () => {
    const provider = resolved("openai", "openai", "https://api.openai.com/v1")
    const file = handleFor({ kind: "file", id: "file-1", owner: provider })
    http.providerRequest.mockResolvedValueOnce({
      json: {
        id: "vs-1",
        name: "kb",
        status: "in_progress",
        file_counts: { total: 1 },
        created_at: 1_700_000_000,
      },
    })
    const created = vectorStoresCreateOutput.parse(
      await run("vector-stores.create", provider, { name: "kb", fileHandles: [file] })
    )
    expect(created).toMatchObject({ name: "kb", fileCount: 1, status: "in_progress" })
    expect(created.handle).toMatchObject({
      kind: "vector-store",
      id: "vs-1",
      providerId: "openai",
      deploymentRef: "dep-1",
    })
    expect(http.providerRequest).toHaveBeenCalledWith(
      provider,
      expect.objectContaining({ path: "vector_stores", body: { name: "kb", file_ids: ["file-1"] } })
    )

    http.providerRequest.mockResolvedValueOnce({
      json: { data: [{ id: "vs-1" }], has_more: false },
    })
    const listed = vectorStoresListOutput.parse(
      await run("vector-stores.list", provider, { limit: 20 })
    )
    expect(listed.items[0].handle.id).toBe("vs-1")
    expect(listed.nextCursor).toBeNull()

    http.providerRequest.mockResolvedValueOnce({ json: { id: "vs-1", status: "completed" } })
    expect(
      vectorStoresCreateOutput.parse(
        await run("vector-stores.get", provider, { handle: created.handle })
      ).status
    ).toBe("completed")

    http.providerRequest.mockResolvedValueOnce({ json: { id: "file-2", status: "in_progress" } })
    const file2 = handleFor({ kind: "file", id: "file-2", owner: provider })
    const added = vectorStoresFilesAddOutput.parse(
      await run("vector-stores.files.add", provider, { handle: created.handle, file: file2 })
    )
    expect(added).toMatchObject({ file: { id: "file-2" }, status: "in_progress" })
    expect(http.providerRequest).toHaveBeenLastCalledWith(
      provider,
      expect.objectContaining({ path: "vector_stores/vs-1/files", body: { file_id: "file-2" } })
    )

    http.providerRequest.mockResolvedValueOnce({ json: { id: "file-2", deleted: true } })
    expect(
      vectorStoresDeleteOutput.parse(
        await run("vector-stores.files.remove", provider, { handle: created.handle, file: file2 })
      )
    ).toEqual({ id: "file-2", deleted: true })
    expect(http.providerRequest).toHaveBeenLastCalledWith(
      provider,
      expect.objectContaining({ method: "DELETE", path: "vector_stores/vs-1/files/file-2" })
    )

    http.providerRequest.mockResolvedValueOnce({ json: { id: "vs-1", deleted: true } })
    expect(await run("vector-stores.delete", provider, { handle: created.handle })).toEqual({
      id: "vs-1",
      deleted: true,
    })
  })

  it("refuses a file handle from another provider or credential, and a handle of the wrong kind", async () => {
    const provider = resolved("openai", "openai", "https://api.openai.com/v1")
    const store = handleFor({ kind: "vector-store", id: "vs-1", owner: provider })
    const foreignFile = handleFor({
      kind: "file",
      id: "f",
      owner: { providerId: "azure", apiKey: "k" },
    })
    await expect(
      run("vector-stores.files.add", provider, { handle: store, file: foreignFile })
    ).rejects.toMatchObject({ failure: { code: "permission" } })
    const rotatedFile = handleFor({
      kind: "file",
      id: "f",
      owner: { providerId: "openai", apiKey: "other" },
    })
    await expect(
      run("vector-stores.create", provider, { fileHandles: [rotatedFile] })
    ).rejects.toMatchObject({ failure: { code: "authentication" } })
    await expect(run("vector-stores.get", provider, { handle: rotatedFile })).rejects.toThrow(
      /expected a vector-store handle/
    )
    expect(http.providerRequest).not.toHaveBeenCalled()
  })

  it("drives Gemini File Search stores by resource name, importing files and deleting their documents", async () => {
    const provider = resolved("google", "google")
    http.providerRequest.mockResolvedValueOnce({
      json: {
        name: "fileSearchStores/s1",
        displayName: "kb",
        createTime: "2026-09-01T00:00:00Z",
        activeDocumentsCount: "0",
      },
    })
    http.providerRequest.mockResolvedValueOnce({ json: { name: "operations/op1", done: false } })
    const file = handleFor({ kind: "file", id: "files/abc", owner: provider })
    const created = vectorStoresCreateOutput.parse(
      await run("vector-stores.create", provider, { name: "kb", fileHandles: [file] })
    )
    expect(created).toMatchObject({ name: "kb", fileCount: 1, status: "in_progress" })
    expect(created.handle.id).toBe("fileSearchStores/s1")
    expect(http.providerRequest).toHaveBeenNthCalledWith(
      1,
      provider,
      expect.objectContaining({ path: "fileSearchStores", body: { displayName: "kb" } })
    )
    expect(http.providerRequest).toHaveBeenNthCalledWith(
      2,
      provider,
      expect.objectContaining({
        path: "fileSearchStores/s1:importFile",
        body: { fileName: "files/abc" },
      })
    )

    http.providerRequest.mockResolvedValueOnce({
      json: {
        fileSearchStores: [
          { name: "fileSearchStores/s1", activeDocumentsCount: "2", pendingDocumentsCount: "1" },
        ],
        nextPageToken: "n",
      },
    })
    const listed = vectorStoresListOutput.parse(await run("vector-stores.list", provider, {}))
    expect(listed.items[0]).toMatchObject({ fileCount: 3, status: "in_progress" })
    expect(listed.nextCursor).toBe("n")

    http.providerRequest.mockResolvedValueOnce({ json: { name: "operations/op2", done: true } })
    const added = vectorStoresFilesAddOutput.parse(
      await run("vector-stores.files.add", provider, { handle: created.handle, file })
    )
    expect(added.status).toBe("completed")

    http.providerRequest.mockResolvedValueOnce({
      json: { documents: [{ name: "fileSearchStores/s1/documents/d9", displayName: "abc" }] },
    })
    http.providerRequest.mockResolvedValueOnce({ json: {} })
    expect(
      await run("vector-stores.files.remove", provider, { handle: created.handle, file })
    ).toEqual({ id: "fileSearchStores/s1/documents/d9", deleted: true })
    expect(http.providerRequest).toHaveBeenLastCalledWith(
      provider,
      expect.objectContaining({ method: "DELETE", path: "fileSearchStores/s1/documents/d9" })
    )

    http.providerRequest.mockResolvedValueOnce({ json: { documents: [] } })
    await expect(
      run("vector-stores.files.remove", provider, { handle: created.handle, file })
    ).rejects.toThrow(/holds no document/)

    http.providerRequest.mockResolvedValueOnce({ json: {} })
    expect(await run("vector-stores.delete", provider, { handle: created.handle })).toEqual({
      id: "fileSearchStores/s1",
      deleted: true,
    })
    expect(http.providerRequest).toHaveBeenLastCalledWith(
      provider,
      expect.objectContaining({ method: "DELETE", path: "fileSearchStores/s1?force=true" })
    )
  })
})
