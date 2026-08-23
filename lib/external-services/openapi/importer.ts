import type {
  ExternalServiceRisk,
  ExternalServiceSurface,
  OpenApiImportRow,
  ServiceConnection,
} from "@/types/external-service"
import type { OpenApiRiskOverride } from "@/types/plugin/plugin-service"

import { putOpenApiImportConnection } from "@/lib/db/external-services"
import { proxyFetch } from "@/lib/network/proxy-fetch"
import { sha256Hex } from "@/lib/share/hash"
import { assertFetchTargetAllowed } from "@/lib/web/fetch-guard"
import { registerExternalServices } from "../catalog"
import {
  compileOpenApiDocument,
  type CompiledOpenApiProvider,
  type CompileOpenApiOptions,
} from "./compiler"
import { projectOpenApiCapabilities } from "./runtime"

const MAX_ROOT_BYTES = 2 * 1024 * 1024
const MAX_EXTERNAL_BYTES = 8 * 1024 * 1024
const MAX_EXTERNAL_DOCUMENTS = 32

type OpenApiFetch = (
  input: RequestInfo | URL,
  init?: RequestInit & { blockPrivateHosts?: boolean; timeout?: number }
) => Promise<Response>

export interface OpenApiInspection {
  document: string
  sourceKind: "url" | "file" | "plugin"
  sourceUrl?: string
  documentFingerprint: string
  approvedExternalRefOrigins: string[]
  externalDocuments: Record<string, string>
  provider: CompiledOpenApiProvider
}

export interface InspectOpenApiInput {
  document: string
  sourceKind: OpenApiInspection["sourceKind"]
  sourceUrl?: string
  approvedExternalRefOrigins?: string[]
  riskOverrides?: OpenApiRiskOverride[]
  fetchExternalDocuments?: boolean
}

interface ImporterDeps {
  fetch: OpenApiFetch
  hash: typeof sha256Hex
  persist: typeof putOpenApiImportConnection
  randomUUID: () => string
}

const defaultDeps: ImporterDeps = {
  fetch: proxyFetch,
  hash: sha256Hex,
  persist: putOpenApiImportConnection,
  randomUUID: () => crypto.randomUUID(),
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function normalizedDocumentUrl(ref: string): string {
  const url = new URL(ref)
  url.hash = ""
  return url.href
}

async function fetchSpecDocument(urlValue: string, fetchImpl: OpenApiFetch): Promise<string> {
  const url = new URL(urlValue)
  if (url.protocol !== "https:") throw new Error("Remote OpenAPI documents must use HTTPS")
  if (url.username || url.password) throw new Error("OpenAPI URLs cannot contain credentials")
  assertFetchTargetAllowed(url.href)
  const response = await fetchImpl(url.href, {
    method: "GET",
    redirect: "manual",
    credentials: "omit",
    blockPrivateHosts: true,
    timeout: 20_000,
  })
  if (response.status >= 300 && response.status < 400) {
    throw new Error("OpenAPI document redirects require a new origin review")
  }
  if (!response.ok) throw new Error(`OpenAPI document request failed with ${response.status}`)
  const length = Number(response.headers.get("content-length"))
  if (Number.isFinite(length) && length > MAX_ROOT_BYTES) {
    throw new Error("OpenAPI document exceeds 2 MiB")
  }
  const document = await response.text()
  if (utf8Bytes(document) > MAX_ROOT_BYTES) throw new Error("OpenAPI document exceeds 2 MiB")
  return document
}

function compileOptions(
  input: InspectOpenApiInput,
  externalDocuments: Record<string, string>
): CompileOpenApiOptions {
  return {
    sourceUrl: input.sourceUrl,
    approvedExternalOrigins: input.approvedExternalRefOrigins,
    externalDocuments,
    riskOverrides: input.riskOverrides,
  }
}

async function compileWithExternalDocuments(
  input: InspectOpenApiInput,
  deps: ImporterDeps
): Promise<{ provider: CompiledOpenApiProvider; externalDocuments: Record<string, string> }> {
  const externalDocuments: Record<string, string> = {}
  let provider = compileOpenApiDocument(input.document, compileOptions(input, externalDocuments))
  if (!input.fetchExternalDocuments) return { provider, externalDocuments }

  let totalExternalBytes = 0
  for (;;) {
    const missing = [
      ...new Set(
        provider.externalRefs
          .map(normalizedDocumentUrl)
          .filter((url) => externalDocuments[url] === undefined)
      ),
    ]
    if (missing.length === 0) return { provider, externalDocuments }
    if (Object.keys(externalDocuments).length + missing.length > MAX_EXTERNAL_DOCUMENTS) {
      throw new Error(`OpenAPI import exceeds ${MAX_EXTERNAL_DOCUMENTS} external documents`)
    }
    for (const url of missing) {
      const origin = new URL(url).origin
      const sourceOrigin = input.sourceUrl ? new URL(input.sourceUrl).origin : undefined
      if (origin !== sourceOrigin && !input.approvedExternalRefOrigins?.includes(origin)) {
        throw new Error(`OpenAPI external reference origin is not approved: ${origin}`)
      }
      const document = await fetchSpecDocument(url, deps.fetch)
      totalExternalBytes += utf8Bytes(document)
      if (totalExternalBytes > MAX_EXTERNAL_BYTES) {
        throw new Error("OpenAPI external references exceed 8 MiB")
      }
      externalDocuments[url] = document
    }
    provider = compileOpenApiDocument(input.document, compileOptions(input, externalDocuments))
  }
}

export async function loadOpenApiFromUrl(
  sourceUrl: string,
  options: Omit<InspectOpenApiInput, "document" | "sourceKind" | "sourceUrl"> = {},
  deps: ImporterDeps = defaultDeps
): Promise<OpenApiInspection> {
  const document = await fetchSpecDocument(sourceUrl, deps.fetch)
  return inspectOpenApiDocument(
    {
      ...options,
      document,
      sourceKind: "url",
      sourceUrl,
      fetchExternalDocuments: options.fetchExternalDocuments ?? true,
    },
    deps
  )
}

export async function inspectOpenApiDocument(
  input: InspectOpenApiInput,
  deps: ImporterDeps = defaultDeps
): Promise<OpenApiInspection> {
  if (utf8Bytes(input.document) > MAX_ROOT_BYTES) throw new Error("OpenAPI document exceeds 2 MiB")
  if (input.sourceUrl) {
    const source = new URL(input.sourceUrl)
    if (source.username || source.password)
      throw new Error("OpenAPI URLs cannot contain credentials")
  }
  const { provider, externalDocuments } = await compileWithExternalDocuments(input, deps)
  const fingerprint = await deps.hash(
    JSON.stringify({
      document: input.document,
      externalDocuments: Object.entries(externalDocuments).sort(([left], [right]) =>
        left.localeCompare(right)
      ),
    })
  )
  return {
    document: input.document,
    sourceKind: input.sourceKind,
    sourceUrl: input.sourceUrl,
    documentFingerprint: `sha256:${fingerprint}`,
    approvedExternalRefOrigins: [...new Set(input.approvedExternalRefOrigins ?? [])].sort(),
    externalDocuments,
    provider,
  }
}

export interface InstallReviewedOpenApiInput {
  inspection: OpenApiInspection
  label: string
  runtimeTargetId: string
  approvedOrigins: string[]
  reviewedRisks: Record<string, ExternalServiceRisk>
  idempotency?: Record<string, "required" | "supported" | "none">
  enabledSurfaces?: ExternalServiceSurface[]
  pluginId?: string
  serviceId?: string
  providerId?: string
  accountId?: string
}

export async function installReviewedOpenApi(
  input: InstallReviewedOpenApiInput,
  deps: ImporterDeps = defaultDeps
): Promise<{
  row: OpenApiImportRow
  connection: ServiceConnection
  provider: CompiledOpenApiProvider
}> {
  const expectedOperations = input.inspection.provider.operations.map(
    (operation) => operation.operationId
  )
  if (expectedOperations.some((operationId) => !input.reviewedRisks[operationId])) {
    throw new Error("Every OpenAPI operation risk must be reviewed before connecting")
  }
  const declaredOrigins = new Set(input.inspection.provider.allowedOrigins)
  const approvedOrigins = [...new Set(input.approvedOrigins)].sort()
  if (
    approvedOrigins.some((origin) => !declaredOrigins.has(origin)) ||
    [...declaredOrigins].some((origin) => !approvedOrigins.includes(origin))
  ) {
    throw new Error("Approved OpenAPI origins must exactly match the reviewed server origins")
  }
  const riskOverrides: OpenApiRiskOverride[] = expectedOperations.map((operationId) => ({
    operationId,
    risk: input.reviewedRisks[operationId],
    idempotency: input.idempotency?.[operationId],
  }))
  const provider = compileOpenApiDocument(input.inspection.document, {
    sourceUrl: input.inspection.sourceUrl,
    approvedExternalOrigins: input.inspection.approvedExternalRefOrigins,
    externalDocuments: input.inspection.externalDocuments,
    riskOverrides,
  })
  const id = deps.randomUUID()
  const pluginId = input.pluginId ?? "user"
  const serviceId = input.serviceId ?? `openapi:${id}`
  const providerId = input.providerId ?? "openapi"
  const importId = `openapi-import:${id}`
  const connectionId = `openapi:${id}`
  const now = new Date().toISOString()
  const providerFingerprint = `sha256:${await deps.hash(
    JSON.stringify({
      document: input.inspection.documentFingerprint,
      approvedOrigins,
      riskOverrides,
    })
  )}`
  const row: OpenApiImportRow = {
    id: importId,
    pluginId,
    serviceId,
    providerId,
    label: input.label.trim() || provider.title,
    sourceKind: input.inspection.sourceKind,
    sourceUrl: input.inspection.sourceUrl,
    document: input.inspection.document,
    externalDocuments: input.inspection.externalDocuments,
    documentFingerprint: input.inspection.documentFingerprint,
    approvedOrigins,
    approvedExternalRefOrigins: input.inspection.approvedExternalRefOrigins,
    trust: input.pluginId ? "trusted" : "untrusted",
    createdAt: now,
    updatedAt: now,
  }
  const connection: ServiceConnection = {
    id: connectionId,
    pluginId,
    serviceId,
    providerId,
    runtimeTargetId: input.runtimeTargetId,
    accountLabel: row.label,
    status: "connected",
    providerFingerprint,
    providerRef: {
      kind: "openapi",
      accountId: input.accountId ?? `openapi-account:${id}`,
      importId,
    },
    enabledSurfaces: input.enabledSurfaces ?? ["chat", "workflow"],
    createdAt: now,
    updatedAt: now,
  }
  await deps.persist(row, connection)
  projectOpenApiImport(row, connection, provider)
  return { row, connection, provider }
}

export function projectOpenApiImport(
  row: OpenApiImportRow,
  connection: ServiceConnection,
  provider: CompiledOpenApiProvider
): void {
  const pluginId = row.pluginId ?? "user"
  registerExternalServices(pluginId, [
    {
      id: row.serviceId,
      label: row.label,
      fallbackPolicy: "never",
      providers: [
        {
          id: row.providerId,
          kind: "openapi",
          contributionId: row.id,
          priority: 100,
          surfaces: connection.enabledSurfaces,
        },
      ],
    },
  ])
  projectOpenApiCapabilities({
    pluginId,
    serviceId: row.serviceId,
    providerId: row.providerId,
    surfaces: connection.enabledSurfaces,
    provider,
  })
}
