/**
 * `vector-stores.create`, `list`, `get`, `delete`, `files.add` and
 * `files.remove` (ADR-0163, Batch 14), in the contract shapes.
 *
 * Two real wires, bound by protocol:
 *   - the OpenAI vector stores API (`/vector_stores`), shared by Azure OpenAI,
 *   - the Gemini File Search stores API (`/fileSearchStores`), where a store
 *     is a resource name, a file is imported from the Files API by name, and
 *     removal deletes the document the import produced.
 *
 * A file handle passed to `files.add` must belong to the same provider and
 * credential as the store: the executor pins the store, this module pins the
 * file. Nothing here fails over.
 */

import type { z } from "zod"
import type {
  ProviderResourceHandle,
  vectorStoresCreateInput,
  vectorStoresCreateOutput,
  vectorStoresDeleteOutput,
  vectorStoresFilesAddInput,
  vectorStoresFilesAddOutput,
  vectorStoresFilesRemoveOutput,
  vectorStoresGetInput,
  vectorStoresListInput,
  vectorStoresListOutput,
} from "@cognia/provider-types"
import type { ResolvedProvider } from "@/lib/ai/provider-consumption"

import { ProviderOperationFailureError } from "../failure"
import type {
  ProviderOperationHandlerRegistration,
  ProviderOperationProviderMatch,
} from "../registry"
import { epochMs, handleFor, requireHandle } from "../resource-handle"
import { providerRequest } from "./http"

export type VectorStoresCreateInput = z.infer<typeof vectorStoresCreateInput>
export type VectorStoreObject = z.infer<typeof vectorStoresCreateOutput>
export type VectorStoresListInput = z.infer<typeof vectorStoresListInput>
export type VectorStoresListOutput = z.infer<typeof vectorStoresListOutput>
export type VectorStoresGetInput = z.infer<typeof vectorStoresGetInput>
export type VectorStoresDeleteOutput = z.infer<typeof vectorStoresDeleteOutput>
export type VectorStoresFilesAddInput = z.infer<typeof vectorStoresFilesAddInput>
export type VectorStoresFilesAddOutput = z.infer<typeof vectorStoresFilesAddOutput>
export type VectorStoresFilesRemoveOutput = z.infer<typeof vectorStoresFilesRemoveOutput>

interface WireContext {
  provider: ResolvedProvider
  deploymentRef: string | undefined
  signal: AbortSignal | undefined
}

interface VectorStoresWire {
  create(
    context: WireContext,
    input: VectorStoresCreateInput,
    fileIds: string[]
  ): Promise<VectorStoreObject>
  list(context: WireContext, input: VectorStoresListInput): Promise<VectorStoresListOutput>
  get(context: WireContext, store: ProviderResourceHandle): Promise<VectorStoreObject>
  remove(context: WireContext, store: ProviderResourceHandle): Promise<string>
  addFile(
    context: WireContext,
    store: ProviderResourceHandle,
    file: ProviderResourceHandle
  ): Promise<string | undefined>
  removeFile(
    context: WireContext,
    store: ProviderResourceHandle,
    file: ProviderResourceHandle
  ): Promise<string>
}

function storeHandle(context: WireContext, id: string, createdAt?: number): ProviderResourceHandle {
  return handleFor({
    kind: "vector-store",
    id,
    owner: context.provider,
    deploymentRef: context.deploymentRef,
    createdAt,
  })
}

function query(params: Record<string, string | number | undefined>): string {
  const pairs = Object.entries(params).filter(
    (entry): entry is [string, string | number] => entry[1] !== undefined
  )
  return pairs.length
    ? `?${pairs.map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`).join("&")}`
    : ""
}

// ---- OpenAI wire (also Azure OpenAI) ---------------------------------------------

interface OpenAiStore {
  id: string
  name?: string
  status?: string
  file_counts?: { total?: number }
  created_at?: number
}

interface OpenAiPage<T> {
  data?: T[]
  has_more?: boolean
  last_id?: string
}

function openAiStore(context: WireContext, store: OpenAiStore): VectorStoreObject {
  return {
    handle: storeHandle(context, store.id, epochMs(store.created_at)),
    ...(store.name ? { name: store.name } : {}),
    ...(store.file_counts?.total !== undefined ? { fileCount: store.file_counts.total } : {}),
    ...(store.status ? { status: store.status } : {}),
  }
}

export const openAiVectorStoresWire: VectorStoresWire = {
  async create(context, input, fileIds) {
    const { json } = await providerRequest<OpenAiStore>(context.provider, {
      path: "vector_stores",
      body: {
        ...(input.name ? { name: input.name } : {}),
        ...(fileIds.length ? { file_ids: fileIds } : {}),
      },
      signal: context.signal,
    })
    return openAiStore(context, json)
  },
  async list(context, input) {
    const { json } = await providerRequest<OpenAiPage<OpenAiStore>>(context.provider, {
      path: `vector_stores${query({ limit: input.limit, after: input.after })}`,
      signal: context.signal,
    })
    const items = (json.data ?? []).map((store) => openAiStore(context, store))
    return {
      items,
      nextCursor: json.has_more ? (json.last_id ?? items.at(-1)?.handle.id ?? null) : null,
    }
  },
  async get(context, store) {
    const { json } = await providerRequest<OpenAiStore>(context.provider, {
      path: `vector_stores/${encodeURIComponent(store.id)}`,
      signal: context.signal,
    })
    return openAiStore(context, json)
  },
  async remove(context, store) {
    const { json } = await providerRequest<{ id?: string }>(context.provider, {
      method: "DELETE",
      path: `vector_stores/${encodeURIComponent(store.id)}`,
      signal: context.signal,
    })
    return json.id ?? store.id
  },
  async addFile(context, store, file) {
    const { json } = await providerRequest<{ status?: string }>(context.provider, {
      path: `vector_stores/${encodeURIComponent(store.id)}/files`,
      body: { file_id: file.id },
      signal: context.signal,
    })
    return json.status
  },
  async removeFile(context, store, file) {
    const { json } = await providerRequest<{ id?: string }>(context.provider, {
      method: "DELETE",
      path: `vector_stores/${encodeURIComponent(store.id)}/files/${encodeURIComponent(file.id)}`,
      signal: context.signal,
    })
    return json.id ?? file.id
  },
}

// ---- Gemini File Search stores -------------------------------------------------

interface GeminiStore {
  name: string
  displayName?: string
  createTime?: string
  activeDocumentsCount?: string | number
  pendingDocumentsCount?: string | number
  failedDocumentsCount?: string | number
}

interface GeminiDocument {
  name: string
  displayName?: string
}

function isoMs(value: string | undefined): number | undefined {
  const parsed = value ? Date.parse(value) : Number.NaN
  return Number.isNaN(parsed) ? undefined : parsed
}

function count(value: string | number | undefined): number {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

function geminiStore(context: WireContext, store: GeminiStore): VectorStoreObject {
  const pending = count(store.pendingDocumentsCount)
  return {
    handle: storeHandle(context, store.name, isoMs(store.createTime)),
    ...(store.displayName ? { name: store.displayName } : {}),
    fileCount: count(store.activeDocumentsCount) + pending + count(store.failedDocumentsCount),
    status: pending > 0 ? "in_progress" : "completed",
  }
}

async function geminiImport(context: WireContext, store: ProviderResourceHandle, fileName: string) {
  const { json } = await providerRequest<{ name?: string; done?: boolean }>(context.provider, {
    path: `${store.id}:importFile`,
    body: { fileName },
    signal: context.signal,
  })
  return json.done ? "completed" : "in_progress"
}

export const geminiVectorStoresWire: VectorStoresWire = {
  async create(context, input, fileIds) {
    const { json } = await providerRequest<GeminiStore>(context.provider, {
      path: "fileSearchStores",
      body: { ...(input.name ? { displayName: input.name } : {}) },
      signal: context.signal,
    })
    const store = geminiStore(context, json)
    for (const fileName of fileIds) await geminiImport(context, store.handle, fileName)
    return fileIds.length ? { ...store, fileCount: fileIds.length, status: "in_progress" } : store
  },
  async list(context, input) {
    const { json } = await providerRequest<{
      fileSearchStores?: GeminiStore[]
      nextPageToken?: string
    }>(context.provider, {
      path: `fileSearchStores${query({ pageSize: input.limit, pageToken: input.after })}`,
      signal: context.signal,
    })
    return {
      items: (json.fileSearchStores ?? []).map((store) => geminiStore(context, store)),
      nextCursor: json.nextPageToken ?? null,
    }
  },
  async get(context, store) {
    const { json } = await providerRequest<GeminiStore>(context.provider, {
      path: store.id,
      signal: context.signal,
    })
    return geminiStore(context, json)
  },
  async remove(context, store) {
    await providerRequest(context.provider, {
      method: "DELETE",
      path: `${store.id}?force=true`,
      signal: context.signal,
    })
    return store.id
  },
  addFile: (context, store, file) => geminiImport(context, store, file.id),
  async removeFile(context, store, file) {
    const prefix = `${store.id}/documents/`
    let documentName = file.id.startsWith(prefix) ? file.id : undefined
    if (!documentName) {
      // An import names its document after the file's display name, so find it.
      const { json } = await providerRequest<{ documents?: GeminiDocument[] }>(context.provider, {
        path: `${store.id}/documents?pageSize=100`,
        signal: context.signal,
      })
      const wanted = file.id.replace(/^files\//, "")
      documentName = (json.documents ?? []).find(
        (document) =>
          document.displayName === file.id ||
          document.displayName === wanted ||
          document.name.endsWith(`/${wanted}`)
      )?.name
    }
    if (!documentName) {
      throw new ProviderOperationFailureError({
        code: "schema",
        retryable: false,
        message: `store ${store.id} holds no document imported from ${file.id}`,
      })
    }
    await providerRequest(context.provider, {
      method: "DELETE",
      path: documentName,
      signal: context.signal,
    })
    return documentName
  },
}

// ---- registrations -------------------------------------------------------------

const WIRES: Array<{ match: ProviderOperationProviderMatch; wire: VectorStoresWire }> = [
  { match: { kind: "protocol", protocol: "openai" }, wire: openAiVectorStoresWire },
  { match: { kind: "protocol", protocol: "azure" }, wire: openAiVectorStoresWire },
  { match: { kind: "protocol", protocol: "google" }, wire: geminiVectorStoresWire },
]

function contextOf(input: {
  provider: ResolvedProvider
  request: { deploymentRef?: string }
  signal?: AbortSignal
}): WireContext {
  return {
    provider: input.provider,
    deploymentRef: input.request.deploymentRef,
    signal: input.signal,
  }
}

function registrationsFor(
  match: ProviderOperationProviderMatch,
  wire: VectorStoresWire
): ProviderOperationHandlerRegistration[] {
  return [
    {
      operationId: "vector-stores.create",
      providerMatch: match,
      support: "native",
      handler: async (context) => {
        const input = (context.request.input ?? {}) as VectorStoresCreateInput
        const fileIds = (input.fileHandles ?? []).map(
          (handle) => requireHandle({ handle }, "file", context.provider).id
        )
        return wire.create(contextOf(context), input, fileIds)
      },
    },
    {
      operationId: "vector-stores.list",
      providerMatch: match,
      support: "native",
      handler: async (context) =>
        wire.list(contextOf(context), (context.request.input ?? {}) as VectorStoresListInput),
    },
    {
      operationId: "vector-stores.get",
      providerMatch: match,
      support: "native",
      handler: async (context) =>
        wire.get(
          contextOf(context),
          requireHandle(
            context.request.input as VectorStoresGetInput,
            "vector-store",
            context.provider
          )
        ),
    },
    {
      operationId: "vector-stores.delete",
      providerMatch: match,
      support: "native",
      handler: async (context): Promise<VectorStoresDeleteOutput> => {
        const store = requireHandle(
          context.request.input as VectorStoresGetInput,
          "vector-store",
          context.provider
        )
        return { id: await wire.remove(contextOf(context), store), deleted: true }
      },
    },
    {
      operationId: "vector-stores.files.add",
      providerMatch: match,
      support: "native",
      handler: async (context): Promise<VectorStoresFilesAddOutput> => {
        const input = context.request.input as VectorStoresFilesAddInput
        const store = requireHandle(input, "vector-store", context.provider)
        const file = requireHandle({ handle: input.file }, "file", context.provider)
        const status = await wire.addFile(contextOf(context), store, file)
        return { handle: store, file, ...(status ? { status } : {}) }
      },
    },
    {
      operationId: "vector-stores.files.remove",
      providerMatch: match,
      support: "native",
      handler: async (context): Promise<VectorStoresFilesRemoveOutput> => {
        const input = context.request.input as VectorStoresFilesAddInput
        const store = requireHandle(input, "vector-store", context.provider)
        const file = requireHandle({ handle: input.file }, "file", context.provider)
        return { id: await wire.removeFile(contextOf(context), store, file), deleted: true }
      },
    },
  ]
}

export const VECTOR_STORES_HANDLERS: ProviderOperationHandlerRegistration[] = WIRES.flatMap(
  ({ match, wire }) => registrationsFor(match, wire)
)
