/**
 * `files.upload`, `files.list`, `files.get`, `files.content` and
 * `files.delete` (ADR-0163, Batch 14), in the contract shapes.
 *
 * Three real wires, each bound by protocol:
 *   - the OpenAI files API (`/files`), which the OpenAI-compatible vendors
 *     that declare a files surface mirror, including Azure OpenAI,
 *   - the Anthropic Files API (beta header `files-api-2025-04-14`),
 *   - the Gemini Files API (multipart/related upload under `/upload/v1beta`,
 *     resource names as ids). Gemini never returns uploaded bytes, so it has
 *     no `files.content` handler and the matrix says `unsupported` there.
 *
 * Every handle carries provider, deployment, account and credential
 * fingerprint. A later call pins to all four and never fails over.
 */

import type { z } from "zod"
import type {
  filesContentOutput,
  filesDeleteInput,
  filesDeleteOutput,
  filesGetInput,
  filesListInput,
  filesListOutput,
  filesUploadInput,
  filesUploadOutput,
  ProviderResourceHandle,
} from "@cognia/provider-types"
import type { ResolvedProvider } from "@/lib/ai/provider-consumption"

import { ProviderOperationFailureError } from "../failure"
import type {
  ProviderOperationHandlerRegistration,
  ProviderOperationProviderMatch,
} from "../registry"
import { epochMs, handleFor, requireHandle } from "../resource-handle"
import { blobOf, bytesOf, bytesRefOf, mimeTypeOf, type BytesRef } from "./bytes"
import { providerDownload, providerRequest, providerUpload, restBaseOf } from "./http"

export type FilesUploadInput = z.infer<typeof filesUploadInput>
export type FileObject = z.infer<typeof filesUploadOutput>
export type FilesListInput = z.infer<typeof filesListInput>
export type FilesListOutput = z.infer<typeof filesListOutput>
export type FilesGetInput = z.infer<typeof filesGetInput>
export type FilesContentOutput = z.infer<typeof filesContentOutput>
export type FilesDeleteInput = z.infer<typeof filesDeleteInput>
export type FilesDeleteOutput = z.infer<typeof filesDeleteOutput>

interface WireContext {
  provider: ResolvedProvider
  deploymentRef: string | undefined
  signal: AbortSignal | undefined
}

/** One vendor wire. `content` is absent where bytes never come back. */
interface FilesWire {
  upload(context: WireContext, input: FilesUploadInput): Promise<FileObject>
  list(context: WireContext, input: FilesListInput): Promise<FilesListOutput>
  get(context: WireContext, handle: ProviderResourceHandle): Promise<FileObject>
  content?(context: WireContext, handle: ProviderResourceHandle): Promise<BytesRef>
  remove(context: WireContext, handle: ProviderResourceHandle): Promise<string>
}

function fileHandle(context: WireContext, id: string, createdAt?: number): ProviderResourceHandle {
  return handleFor({
    kind: "file",
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

// ---- OpenAI wire (also Azure OpenAI and the compatible vendors) ------------------

interface OpenAiFile {
  id: string
  filename?: string
  bytes?: number
  purpose?: string
  created_at?: number
}

interface OpenAiPage<T> {
  data?: T[]
  has_more?: boolean
  last_id?: string
}

function openAiFile(context: WireContext, file: OpenAiFile): FileObject {
  const createdAt = epochMs(file.created_at)
  return {
    handle: fileHandle(context, file.id, createdAt),
    filename: file.filename ?? file.id,
    ...(file.bytes !== undefined ? { bytes: file.bytes } : {}),
    ...(file.purpose ? { purpose: file.purpose } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
  }
}

export const openAiFilesWire: FilesWire = {
  async upload(context, input) {
    const form = new FormData()
    form.append("purpose", input.purpose ?? "assistants")
    form.append("file", blobOf(input.content), input.filename)
    const { json } = await providerUpload<OpenAiFile>(context.provider, {
      path: "files",
      form,
      signal: context.signal,
    })
    return openAiFile(context, json)
  },
  async list(context, input) {
    const { json } = await providerRequest<OpenAiPage<OpenAiFile>>(context.provider, {
      path: `files${query({ purpose: input.purpose, limit: input.limit, after: input.after })}`,
      signal: context.signal,
    })
    const items = (json.data ?? []).map((file) => openAiFile(context, file))
    return {
      items,
      nextCursor: json.has_more ? (json.last_id ?? items.at(-1)?.handle.id ?? null) : null,
    }
  },
  async get(context, handle) {
    const { json } = await providerRequest<OpenAiFile>(context.provider, {
      path: `files/${encodeURIComponent(handle.id)}`,
      signal: context.signal,
    })
    return openAiFile(context, json)
  },
  async content(context, handle) {
    const { bytes, mimeType } = await providerDownload(context.provider, {
      path: `files/${encodeURIComponent(handle.id)}/content`,
      signal: context.signal,
    })
    return bytesRefOf(bytes, mimeType)
  },
  async remove(context, handle) {
    const { json } = await providerRequest<{ id?: string }>(context.provider, {
      method: "DELETE",
      path: `files/${encodeURIComponent(handle.id)}`,
      signal: context.signal,
    })
    return json.id ?? handle.id
  },
}

// ---- Anthropic wire ------------------------------------------------------------

const ANTHROPIC_FILES_BETA = { "anthropic-beta": "files-api-2025-04-14" }

interface AnthropicFile {
  id: string
  filename?: string
  size_bytes?: number
  mime_type?: string
  created_at?: string
}

function anthropicFile(context: WireContext, file: AnthropicFile): FileObject {
  const parsed = file.created_at ? Date.parse(file.created_at) : Number.NaN
  const createdAt = Number.isNaN(parsed) ? undefined : parsed
  return {
    handle: fileHandle(context, file.id, createdAt),
    filename: file.filename ?? file.id,
    ...(file.size_bytes !== undefined ? { bytes: file.size_bytes } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
  }
}

export const anthropicFilesWire: FilesWire = {
  async upload(context, input) {
    const form = new FormData()
    form.append("file", blobOf(input.content), input.filename)
    const { json } = await providerUpload<AnthropicFile>(context.provider, {
      path: "files",
      form,
      headers: ANTHROPIC_FILES_BETA,
      signal: context.signal,
    })
    return anthropicFile(context, json)
  },
  async list(context, input) {
    const { json } = await providerRequest<OpenAiPage<AnthropicFile>>(context.provider, {
      path: `files${query({ limit: input.limit, after_id: input.after })}`,
      headers: ANTHROPIC_FILES_BETA,
      signal: context.signal,
    })
    const items = (json.data ?? []).map((file) => anthropicFile(context, file))
    return {
      items,
      nextCursor: json.has_more ? (json.last_id ?? items.at(-1)?.handle.id ?? null) : null,
    }
  },
  async get(context, handle) {
    const { json } = await providerRequest<AnthropicFile>(context.provider, {
      path: `files/${encodeURIComponent(handle.id)}`,
      headers: ANTHROPIC_FILES_BETA,
      signal: context.signal,
    })
    return anthropicFile(context, json)
  },
  async content(context, handle) {
    const { bytes, mimeType } = await providerDownload(context.provider, {
      path: `files/${encodeURIComponent(handle.id)}/content`,
      headers: ANTHROPIC_FILES_BETA,
      signal: context.signal,
    })
    return bytesRefOf(bytes, mimeType)
  },
  async remove(context, handle) {
    const { json } = await providerRequest<{ id?: string }>(context.provider, {
      method: "DELETE",
      path: `files/${encodeURIComponent(handle.id)}`,
      headers: ANTHROPIC_FILES_BETA,
      signal: context.signal,
    })
    return json.id ?? handle.id
  },
}

// ---- Gemini wire ---------------------------------------------------------------

interface GeminiFile {
  name: string
  displayName?: string
  mimeType?: string
  sizeBytes?: string | number
  createTime?: string
  state?: string
}

function geminiFile(context: WireContext, file: GeminiFile): FileObject {
  const parsed = file.createTime ? Date.parse(file.createTime) : Number.NaN
  const createdAt = Number.isNaN(parsed) ? undefined : parsed
  const size = Number(file.sizeBytes)
  return {
    handle: fileHandle(context, file.name, createdAt),
    filename: file.displayName ?? file.name,
    ...(Number.isFinite(size) ? { bytes: size } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
  }
}

/** `https://host/v1beta` to `https://host`, where the upload endpoint lives. */
export function geminiRootOf(provider: ResolvedProvider): string {
  const base = restBaseOf(provider)
  if (!base) {
    throw new ProviderOperationFailureError({
      code: "capability-unsupported",
      retryable: false,
      message: `${provider.providerId} has no base URL to upload to`,
    })
  }
  return base.replace(/\/v1(beta|alpha)?\/?$/, "")
}

/** The multipart/related body the Gemini upload endpoint expects. */
export function geminiMultipartRelated(input: FilesUploadInput): {
  body: Blob
  contentType: string
} {
  const boundary = `cognia-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  const metadata = JSON.stringify({ file: { display_name: input.filename } })
  const mimeType = mimeTypeOf(input.content)
  const body = new Blob([
    `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`,
    `--${boundary}\r\ncontent-type: ${mimeType}\r\n\r\n`,
    bytesOf(input.content) as BlobPart,
    `\r\n--${boundary}--`,
  ])
  return { body, contentType: `multipart/related; boundary=${boundary}` }
}

export const geminiFilesWire: FilesWire = {
  async upload(context, input) {
    const { json } = await providerRequest<{ file?: GeminiFile }>(context.provider, {
      baseURL: geminiRootOf(context.provider),
      path: "upload/v1beta/files?uploadType=multipart",
      rawBody: geminiMultipartRelated(input),
      signal: context.signal,
    })
    if (!json.file?.name) {
      throw new ProviderOperationFailureError({
        code: "invalid-response",
        retryable: false,
        message: "the upload answered without a file resource",
      })
    }
    return geminiFile(context, json.file)
  },
  async list(context, input) {
    const { json } = await providerRequest<{ files?: GeminiFile[]; nextPageToken?: string }>(
      context.provider,
      {
        path: `files${query({ pageSize: input.limit, pageToken: input.after })}`,
        signal: context.signal,
      }
    )
    return {
      items: (json.files ?? []).map((file) => geminiFile(context, file)),
      nextCursor: json.nextPageToken ?? null,
    }
  },
  async get(context, handle) {
    const { json } = await providerRequest<GeminiFile>(context.provider, {
      path: handle.id,
      signal: context.signal,
    })
    return geminiFile(context, json)
  },
  async remove(context, handle) {
    await providerRequest(context.provider, {
      method: "DELETE",
      path: handle.id,
      signal: context.signal,
    })
    return handle.id
  },
}

// ---- registrations -------------------------------------------------------------

const WIRES: Array<{ match: ProviderOperationProviderMatch; wire: FilesWire }> = [
  { match: { kind: "protocol", protocol: "openai" }, wire: openAiFilesWire },
  { match: { kind: "protocol", protocol: "azure" }, wire: openAiFilesWire },
  { match: { kind: "protocol", protocol: "anthropic" }, wire: anthropicFilesWire },
  { match: { kind: "protocol", protocol: "google" }, wire: geminiFilesWire },
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
  wire: FilesWire
): ProviderOperationHandlerRegistration[] {
  const list: ProviderOperationHandlerRegistration[] = [
    {
      operationId: "files.upload",
      providerMatch: match,
      support: "native",
      handler: async (context) =>
        wire.upload(contextOf(context), context.request.input as FilesUploadInput),
    },
    {
      operationId: "files.list",
      providerMatch: match,
      support: "native",
      handler: async (context) =>
        wire.list(contextOf(context), (context.request.input ?? {}) as FilesListInput),
    },
    {
      operationId: "files.get",
      providerMatch: match,
      support: "native",
      handler: async (context) =>
        wire.get(
          contextOf(context),
          requireHandle(context.request.input as FilesGetInput, "file", context.provider)
        ),
    },
    {
      operationId: "files.delete",
      providerMatch: match,
      support: "native",
      handler: async (context): Promise<FilesDeleteOutput> => {
        const handle = requireHandle(
          context.request.input as FilesDeleteInput,
          "file",
          context.provider
        )
        const id = await wire.remove(contextOf(context), handle)
        return { id, deleted: true }
      },
    },
  ]
  if (wire.content) {
    const download = wire.content.bind(wire)
    list.push({
      operationId: "files.content",
      providerMatch: match,
      support: "native",
      handler: async (context): Promise<FilesContentOutput> => ({
        content: await download(
          contextOf(context),
          requireHandle(context.request.input as FilesGetInput, "file", context.provider)
        ),
      }),
    })
  }
  return list
}

export const FILES_HANDLERS: ProviderOperationHandlerRegistration[] = WIRES.flatMap(
  ({ match, wire }) => registrationsFor(match, wire)
)
