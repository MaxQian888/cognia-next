/**
 * Pure declaration of what every provider can do per operation (ADR-0163).
 *
 * The answer for a BUILT-IN provider is static and explicit: this module
 * knows, per vendor, which API surfaces exist, and turns that into one
 * `ProviderOperationCell` per operation. `unsupported` is a real, honest
 * terminal state and always carries a reason. `unknown` never appears for a
 * built-in provider. It is reserved for custom deployments, where the vendor
 * behind an OpenAI-compatible base URL is not known, and for transient probe
 * failures at runtime. The test pins both rules across the whole matrix.
 *
 * Zero I/O and zero app-tree imports: `pnpm build:packages` proves it.
 */

import {
  PROVIDER_OPERATION_IDS,
  type ProviderModelFreshness,
  type ProviderOperationCell,
  type ProviderOperationDescriptor,
  type ProviderOperationId,
  type ProviderOperationPluginCell,
  type ProviderOperationProfile,
  type ProviderOperationSurface,
} from "@cognia/provider-types"
import {
  getBuiltInProviderCatalogEntry,
  type BuiltInProviderCatalogEntry,
} from "@cognia/provider-types/built-in-provider-catalog"
import type { CatalogModality, ProviderOffering } from "@cognia/provider-types/model-catalog"
import type { ApiProtocol } from "@cognia/provider-types/provider"

import type { CatalogRepository } from "../providers/catalog-repository"
import type { ProviderGuardResult, ProviderSetupChecklist } from "../providers/completeness"
import {
  buildCustomProviderContract,
  type ProviderContract,
} from "../providers/provider-contract-matrix"
import { resolveOperationAvailability } from "./operation-availability"

// ---- catalog projections ------------------------------------------------------

type EndpointType = ProviderOffering["endpointType"]

/** Which operations a catalog offering of a given endpoint type can serve. */
export const OPERATION_IDS_BY_ENDPOINT_TYPE: Record<EndpointType, readonly ProviderOperationId[]> =
  {
    "chat-completions": [
      "language.generate",
      "language.stream",
      "language.tools",
      "language.structured-output",
    ],
    responses: [
      "language.generate",
      "language.stream",
      "language.tools",
      "language.structured-output",
    ],
    messages: [
      "language.generate",
      "language.stream",
      "language.tools",
      "language.structured-output",
      "tokens.count",
    ],
    "generate-content": [
      "language.generate",
      "language.stream",
      "language.tools",
      "language.structured-output",
      "tokens.count",
    ],
    "bedrock-runtime": [
      "language.generate",
      "language.stream",
      "language.tools",
      "language.structured-output",
    ],
    local: ["language.generate", "language.stream", "language.tools", "language.structured-output"],
    embedding: ["embeddings.create"],
    rerank: ["rerank.create"],
    images: ["images.generate", "images.edit"],
    speech: ["speech.generate"],
    realtime: ["realtime.connect"],
    transcription: ["transcription.create", "translation.create"],
    moderation: ["moderation.create"],
    video: ["videos.generate", "videos.get", "videos.cancel", "videos.content"],
    batch: ["batches.create", "batches.list", "batches.get", "batches.cancel", "batches.results"],
    files: ["files.upload", "files.list", "files.get", "files.content", "files.delete"],
    "fine-tuning": [
      "fine-tuning.jobs.create",
      "fine-tuning.jobs.list",
      "fine-tuning.jobs.get",
      "fine-tuning.jobs.cancel",
      "fine-tuning.events.list",
      "fine-tuning.checkpoints.list",
    ],
    "vector-store": [
      "vector-stores.create",
      "vector-stores.list",
      "vector-stores.get",
      "vector-stores.delete",
      "vector-stores.files.add",
      "vector-stores.files.remove",
    ],
  }

/** Which operations a provider modality implies. */
export const OPERATION_IDS_BY_MODALITY: Record<CatalogModality, readonly ProviderOperationId[]> = {
  language: OPERATION_IDS_BY_ENDPOINT_TYPE["chat-completions"],
  embedding: OPERATION_IDS_BY_ENDPOINT_TYPE.embedding,
  rerank: OPERATION_IDS_BY_ENDPOINT_TYPE.rerank,
  image: OPERATION_IDS_BY_ENDPOINT_TYPE.images,
  speech: OPERATION_IDS_BY_ENDPOINT_TYPE.speech,
  video: OPERATION_IDS_BY_ENDPOINT_TYPE.video,
  transcription: OPERATION_IDS_BY_ENDPOINT_TYPE.transcription,
  moderation: OPERATION_IDS_BY_ENDPOINT_TYPE.moderation,
}

// ---- vendor surface facts -------------------------------------------------------

/**
 * The API surfaces a vendor exposes. Each key answers one family of
 * operations. `chat` is read from the catalog entry (`supportsChat`), the
 * rest are declared here because the catalog does not carry them.
 */
export interface ProviderSurfaceFacts {
  modelsEndpoint: boolean
  embeddings: boolean
  rerank: boolean
  images: boolean
  imagesEdit: boolean
  video: boolean
  speech: boolean
  transcription: boolean
  translation: boolean
  realtime: boolean
  moderation: boolean
  files: boolean
  /** Whether uploaded bytes can be read back (`files.content`). */
  filesDownload: boolean
  vectorStores: boolean
  batches: boolean
  fineTuning: boolean
  /** Native token counting endpoint (Anthropic `count_tokens`). */
  tokenCount: boolean
  /** Account surfaces. */
  balance: boolean
  quota: boolean
  rateLimitHeaders: boolean
  usageApi: boolean
}

const NONE: ProviderSurfaceFacts = {
  modelsEndpoint: false,
  embeddings: false,
  rerank: false,
  images: false,
  imagesEdit: false,
  video: false,
  speech: false,
  transcription: false,
  translation: false,
  realtime: false,
  moderation: false,
  files: false,
  filesDownload: false,
  vectorStores: false,
  batches: false,
  fineTuning: false,
  tokenCount: false,
  balance: false,
  quota: false,
  rateLimitHeaders: false,
  usageApi: false,
}

const OPENAI_COMPATIBLE_DEFAULTS: ProviderSurfaceFacts = {
  ...NONE,
  modelsEndpoint: true,
  rateLimitHeaders: true,
}

const ANTHROPIC_RELAY_DEFAULTS: ProviderSurfaceFacts = {
  ...NONE,
  // Relays forward the messages wire only: no `/v1/models`, no count_tokens.
  rateLimitHeaders: false,
}

const LOCAL_DEFAULTS: ProviderSurfaceFacts = {
  ...NONE,
  modelsEndpoint: true,
}

const OPENAI_FULL: ProviderSurfaceFacts = {
  ...OPENAI_COMPATIBLE_DEFAULTS,
  embeddings: true,
  images: true,
  imagesEdit: true,
  video: true,
  speech: true,
  transcription: true,
  translation: true,
  realtime: true,
  moderation: true,
  files: true,
  filesDownload: true,
  vectorStores: true,
  batches: true,
  fineTuning: true,
  usageApi: true,
}

/**
 * Explicit per-vendor facts. Anything not listed falls back to the defaults
 * for its adapter family. Keep alphabetical within a block so a reviewer can
 * find a vendor.
 */
const VENDOR_FACTS: Record<string, Partial<ProviderSurfaceFacts>> = {
  // -- flagship / enterprise --
  openai: OPENAI_FULL,
  azure: { ...OPENAI_FULL, moderation: false, usageApi: false },
  anthropic: {
    modelsEndpoint: true,
    tokenCount: true,
    files: true,
    filesDownload: true,
    batches: true,
    rateLimitHeaders: true,
    usageApi: true,
  },
  google: {
    modelsEndpoint: true,
    tokenCount: true,
    embeddings: true,
    images: true,
    video: true,
    speech: true,
    realtime: true,
    // Gemini stores uploads for prompting only, bytes never come back.
    files: true,
    filesDownload: false,
    vectorStores: true,
    batches: true,
    fineTuning: true,
  },
  bedrock: {
    // ListFoundationModels, reached through the sidecar discovery call.
    modelsEndpoint: true,
    embeddings: true,
    images: true,
    video: true,
    batches: true,
    fineTuning: true,
  },
  codex: { rateLimitHeaders: true, quota: true },
  // -- OpenAI-compatible vendors --
  ai21: {},
  aiproxy: { embeddings: true, images: true },
  baichuan: { embeddings: true },
  baidu: { embeddings: true, rerank: true, images: true },
  cerebras: {},
  cloudflare: {
    embeddings: true,
    images: true,
    speech: true,
    transcription: true,
    // Workers AI translates text, not speech, and this host wires no text translation.
    translation: false,
  },
  cohere: { embeddings: true, rerank: true, fineTuning: true },
  deepinfra: { embeddings: true, rerank: true, images: true, speech: true, transcription: true },
  deepseek: { balance: true },
  doubao: { embeddings: true, images: true, video: true, speech: true, batches: true },
  fireworks: {
    embeddings: true,
    images: true,
    transcription: true,
    batches: true,
    fineTuning: true,
    files: true,
    filesDownload: true,
  },
  github: { embeddings: true },
  glm4: {
    embeddings: true,
    images: true,
    video: true,
    files: true,
    filesDownload: true,
    batches: true,
    fineTuning: true,
    quota: true,
  },
  groq: {
    speech: true,
    transcription: true,
    translation: true,
    batches: true,
    files: true,
    filesDownload: true,
  },
  huggingface: { embeddings: true, images: true, speech: true, transcription: true, video: true },
  internlm: {},
  lepton: { images: true, speech: true },
  lingyi: {},
  minimax: {
    embeddings: true,
    images: true,
    video: true,
    speech: true,
    files: true,
    filesDownload: true,
    quota: true,
  },
  mistral: {
    embeddings: true,
    moderation: true,
    transcription: true,
    files: true,
    filesDownload: true,
    batches: true,
    fineTuning: true,
  },
  modelscope: { embeddings: true },
  moonshot: { files: true, filesDownload: true, balance: true, quota: true },
  novita: { embeddings: true, images: true, video: true, speech: true, balance: true },
  nvidia: { embeddings: true, rerank: true },
  ohmygpt: { embeddings: true, images: true },
  openrouter: { embeddings: true, images: true, balance: true, usageApi: true },
  perplexity: {},
  qwen: {
    embeddings: true,
    rerank: true,
    images: true,
    video: true,
    speech: true,
    transcription: true,
    files: true,
    filesDownload: true,
    batches: true,
  },
  replicate: { images: true, video: true, speech: true, transcription: true, fineTuning: true },
  sambanova: {},
  siliconflow: {
    embeddings: true,
    rerank: true,
    images: true,
    video: true,
    speech: true,
    transcription: true,
    balance: true,
  },
  stepfun: { embeddings: true, images: true, video: true, speech: true, transcription: true },
  tencent: { embeddings: true, images: true, video: true },
  togetherai: {
    embeddings: true,
    rerank: true,
    images: true,
    video: true,
    speech: true,
    transcription: true,
    files: true,
    filesDownload: true,
    batches: true,
    fineTuning: true,
  },
  volcengine: { embeddings: true, images: true, video: true, speech: true, batches: true },
  xai: { images: true },
  yi: {},
  zhipu: {
    embeddings: true,
    images: true,
    video: true,
    files: true,
    filesDownload: true,
    batches: true,
    fineTuning: true,
    quota: true,
  },
  // -- specialized (no chat) --
  fal: { modelsEndpoint: false, images: true, video: true, speech: true, transcription: true },
  jina: { modelsEndpoint: false, embeddings: true, rerank: true },
  voyage: { modelsEndpoint: false, embeddings: true, rerank: true },
  // -- local --
  koboldcpp: {},
  jan: {},
  llamacpp: { embeddings: true },
  llamafile: { embeddings: true },
  lmstudio: { embeddings: true },
  localai: { embeddings: true, rerank: true, images: true, speech: true, transcription: true },
  ollama: { embeddings: true },
  tabbyapi: { embeddings: true },
  textgenwebui: { embeddings: true },
  vllm: { embeddings: true, rerank: true, transcription: true },
  // -- proxies / subscriptions --
  cliproxyapi: {},
  opencode: {},
  "opencode-go": {},
  // -- Anthropic-wire relays: facts beyond the messages wire --
  "deepseek-anthropic": { balance: true },
  "glm-anthropic": { quota: true },
  "glm-anthropic-intl": { quota: true },
  "kimi-anthropic": { balance: true, quota: true },
  "kimi-coding": { balance: true, quota: true },
  "minimax-anthropic": { quota: true },
  "minimax-anthropic-intl": { quota: true },
  "novita-anthropic": { balance: true },
  "openrouter-anthropic": { balance: true },
  "siliconflow-anthropic": { balance: true },
}

function defaultsFor(entry: BuiltInProviderCatalogEntry): ProviderSurfaceFacts {
  if (entry.type === "local") return LOCAL_DEFAULTS
  if (entry.family === "anthropic-native" && entry.id !== "anthropic")
    return ANTHROPIC_RELAY_DEFAULTS
  if (entry.protocol === "openai") return OPENAI_COMPATIBLE_DEFAULTS
  return NONE
}

/** The resolved facts for a built-in provider. Exported for the UI and tests. */
export function builtInProviderSurfaceFacts(
  entry: BuiltInProviderCatalogEntry
): ProviderSurfaceFacts {
  return { ...defaultsFor(entry), ...(VENDOR_FACTS[entry.id] ?? {}) }
}

// ---- static support ---------------------------------------------------------------

type StaticSupport =
  { support: "native" | "translated" | "derived" } | { support: "unsupported"; reason: string }

const NO = (reason: string): StaticSupport => ({ support: "unsupported", reason })
const NATIVE: StaticSupport = { support: "native" }
const DERIVED: StaticSupport = { support: "derived" }
const TRANSLATED: StaticSupport = { support: "translated" }

function when(fact: boolean, yes: StaticSupport, reason: string): StaticSupport {
  return fact ? yes : NO(reason)
}

interface StaticSupportInput {
  id: ProviderOperationId
  /** Built-in provider id, when known. Custom deployments pass none. */
  providerId?: string
  facts: ProviderSurfaceFacts
  protocol: ApiProtocol
  chat: boolean
  toolCapable: boolean
  name: string
}

/**
 * Surfaces a vendor really offers but this host has no wire for. Naming the
 * gap here keeps the cell an honest `unsupported` with the true reason,
 * instead of pretending the vendor lacks the API. Keyed by operation
 * prefix so a whole family reads one entry.
 */
export const HOST_GAPS: Record<string, Partial<Record<"batches" | "fine-tuning", string>>> = {
  bedrock: {
    batches: "Bedrock model invocation jobs need SigV4-signed AWS APIs this host does not wire",
    "fine-tuning": "Bedrock customization jobs need SigV4-signed AWS APIs this host does not wire",
  },
  fireworks: {
    batches: "Fireworks batch inference jobs use an account-scoped API this host does not wire",
    "fine-tuning": "Fireworks fine-tuning jobs use an account-scoped API this host does not wire",
  },
  doubao: {
    batches: "Volcengine Ark batch inference jobs use a console API this host does not wire",
  },
  volcengine: {
    batches: "Volcengine Ark batch inference jobs use a console API this host does not wire",
  },
  cohere: {
    "fine-tuning": "Cohere fine-tuning uses its own finetuned-models API this host does not wire",
  },
  replicate: {
    "fine-tuning": "Replicate trainings use a model-version API this host does not wire",
  },
  google: { "fine-tuning": "Gemini tuned models use a tuning API this host does not wire" },
}

function hostGap(providerId: string | undefined, id: ProviderOperationId): string | undefined {
  if (!providerId) return undefined
  const family = id.startsWith("batches.")
    ? "batches"
    : id.startsWith("fine-tuning.")
      ? "fine-tuning"
      : undefined
  return family ? HOST_GAPS[providerId]?.[family] : undefined
}

/** The one place a provider × operation static answer is decided. */
export function staticOperationSupport(input: StaticSupportInput): StaticSupport {
  const { id, facts, protocol, chat, toolCapable, name } = input
  const noChat = `${name} exposes no chat endpoint`
  const gap = hostGap(input.providerId, id)
  if (gap) return NO(gap)
  switch (id) {
    // discovery: always answerable
    case "models.list":
      return facts.modelsEndpoint ? NATIVE : DERIVED
    case "models.get":
    case "capabilities.read":
    case "auth.status":
      return DERIVED
    case "health.probe":
      return NATIVE

    // language
    case "language.generate":
    case "language.stream":
      return when(chat, NATIVE, noChat)
    case "language.tools":
      if (!chat) return NO(noChat)
      return when(toolCapable, NATIVE, `${name} lists no tool-capable model`)
    case "language.structured-output":
      if (!chat) return NO(noChat)
      return protocol === "anthropic" || protocol === "bedrock" ? TRANSLATED : NATIVE
    case "tokens.count":
      return facts.tokenCount ? NATIVE : DERIVED
    case "moderation.create":
      return when(facts.moderation, NATIVE, `${name} exposes no moderation endpoint`)

    // retrieval
    case "embeddings.create":
      return when(facts.embeddings, NATIVE, `${name} exposes no embeddings endpoint`)
    case "rerank.create":
      return when(facts.rerank, NATIVE, `${name} exposes no rerank endpoint`)

    // media
    case "images.generate":
      return when(facts.images, NATIVE, `${name} exposes no image generation endpoint`)
    case "images.edit":
      return when(facts.imagesEdit, NATIVE, `${name} exposes no image edit endpoint`)
    case "videos.generate":
    case "videos.get":
    case "videos.cancel":
    case "videos.content":
      return when(facts.video, NATIVE, `${name} exposes no video generation endpoint`)
    case "speech.generate":
      return when(facts.speech, NATIVE, `${name} exposes no speech synthesis endpoint`)
    case "transcription.create":
      return when(facts.transcription, NATIVE, `${name} exposes no transcription endpoint`)
    case "translation.create":
      return when(facts.translation, NATIVE, `${name} exposes no audio translation endpoint`)
    case "realtime.connect":
      return when(facts.realtime, NATIVE, `${name} exposes no realtime endpoint`)

    // files / jobs
    case "files.upload":
    case "files.list":
    case "files.get":
    case "files.delete":
      return when(facts.files, NATIVE, `${name} exposes no files API`)
    case "files.content":
      if (!facts.files) return NO(`${name} exposes no files API`)
      return when(facts.filesDownload, NATIVE, `${name} never returns uploaded file bytes`)
    case "vector-stores.create":
    case "vector-stores.list":
    case "vector-stores.get":
    case "vector-stores.delete":
    case "vector-stores.files.add":
    case "vector-stores.files.remove":
      return when(facts.vectorStores, NATIVE, `${name} exposes no vector store API`)
    case "batches.create":
    case "batches.list":
    case "batches.get":
    case "batches.cancel":
    case "batches.results":
      return when(facts.batches, NATIVE, `${name} exposes no batch API`)
    case "fine-tuning.jobs.create":
    case "fine-tuning.jobs.list":
    case "fine-tuning.jobs.get":
    case "fine-tuning.jobs.cancel":
    case "fine-tuning.events.list":
    case "fine-tuning.checkpoints.list":
      return when(facts.fineTuning, NATIVE, `${name} exposes no fine-tuning API`)

    // account
    case "balance.read":
      return when(facts.balance, NATIVE, `${name} exposes no balance endpoint`)
    case "quota.read":
      return when(facts.quota, NATIVE, `${name} exposes no quota endpoint`)
    case "rate-limits.read":
      return facts.rateLimitHeaders
        ? DERIVED
        : NO(`${name} returns no rate-limit headers to derive from`)
    case "usage.provider.read":
      return when(facts.usageApi, NATIVE, `${name} exposes no usage API`)
    case "usage.local.read":
      return DERIVED
  }
}

// ---- profile builders -------------------------------------------------------------

export interface BuildProviderOperationProfileInput {
  providerId: string
  deploymentRef?: string
  /** Built-in catalog entry. Looked up by `providerId` when omitted. */
  catalogEntry?: BuiltInProviderCatalogEntry
  /** Contract for a custom provider (built with `buildCustomProviderContract`). */
  contract?: ProviderContract
  /** Optional catalog: offerings widen static facts (an embedding offering ⇒ embeddings). */
  catalog?: Pick<CatalogRepository, "listOfferings">
  guard?: ProviderGuardResult
  checklist?: ProviderSetupChecklist
  /** Descriptors, for the surface check. Passed in so this package stays JSON-free. */
  descriptors?: readonly ProviderOperationDescriptor[]
  hostSurfaces?: readonly ProviderOperationSurface[]
  /** Cells served by plugin adapters. They win over static answers. */
  pluginCells?: readonly ProviderOperationPluginCell[]
  /** Probe evidence for custom deployments: which surfaces answered. */
  probedFacts?: Partial<ProviderSurfaceFacts>
  probeFreshness?: ProviderModelFreshness
  computedAt?: number
}

function offeringsWiden(
  facts: ProviderSurfaceFacts,
  providerId: string,
  catalog?: Pick<CatalogRepository, "listOfferings">
): ProviderSurfaceFacts {
  if (!catalog) return facts
  const widened = { ...facts }
  for (const offering of catalog.listOfferings()) {
    if (offering.providerRef !== providerId || !offering.available) continue
    switch (offering.endpointType) {
      case "embedding":
        widened.embeddings = true
        break
      case "rerank":
        widened.rerank = true
        break
      case "images":
        widened.images = true
        break
      case "speech":
        widened.speech = true
        break
      case "realtime":
        widened.realtime = true
        break
      case "transcription":
        widened.transcription = true
        break
      case "moderation":
        widened.moderation = true
        break
      case "video":
        widened.video = true
        break
      case "batch":
        widened.batches = true
        break
      case "files":
        widened.files = true
        break
      case "fine-tuning":
        widened.fineTuning = true
        break
      case "vector-store":
        widened.vectorStores = true
        break
      default:
        break
    }
  }
  return widened
}

/** Operations whose static answer depends on vendor facts a custom base URL cannot reveal. */
const VENDOR_DEPENDENT: ReadonlySet<ProviderOperationId> = new Set<ProviderOperationId>([
  "moderation.create",
  "rerank.create",
  "images.generate",
  "images.edit",
  "videos.generate",
  "videos.get",
  "videos.cancel",
  "videos.content",
  "speech.generate",
  "transcription.create",
  "translation.create",
  "realtime.connect",
  "files.upload",
  "files.list",
  "files.get",
  "files.content",
  "files.delete",
  "vector-stores.create",
  "vector-stores.list",
  "vector-stores.get",
  "vector-stores.delete",
  "vector-stores.files.add",
  "vector-stores.files.remove",
  "batches.create",
  "batches.list",
  "batches.get",
  "batches.cancel",
  "batches.results",
  "fine-tuning.jobs.create",
  "fine-tuning.jobs.list",
  "fine-tuning.jobs.get",
  "fine-tuning.jobs.cancel",
  "fine-tuning.events.list",
  "fine-tuning.checkpoints.list",
  "balance.read",
  "quota.read",
  "usage.provider.read",
])

/**
 * Build the operation profile for one provider.
 *
 * Built-in: every cell is static and non-`unknown`. Custom: language,
 * embeddings and discovery are decided by protocol. The vendor-dependent
 * families are `unknown` with provenance `custom-deployment` until
 * `probedFacts` says otherwise.
 */
export function buildProviderOperationProfile(
  input: BuildProviderOperationProfileInput
): ProviderOperationProfile {
  const computedAt = input.computedAt ?? Date.now()
  const entry = input.catalogEntry ?? getBuiltInProviderCatalogEntry(input.providerId)
  const pluginByOp = new Map<ProviderOperationId, ProviderOperationPluginCell>()
  for (const cell of input.pluginCells ?? []) pluginByOp.set(cell.operationId, cell)
  const descriptorById = new Map<string, ProviderOperationDescriptor>()
  for (const descriptor of input.descriptors ?? []) descriptorById.set(descriptor.id, descriptor)

  const availabilityFor = (id: ProviderOperationId) =>
    resolveOperationAvailability({
      guard: input.guard,
      checklist: input.checklist,
      descriptorSurfaces: descriptorById.get(id)?.surfaces,
      hostSurfaces: input.hostSurfaces,
    })

  const cells: ProviderOperationCell[] = []

  if (entry) {
    const facts = offeringsWiden(builtInProviderSurfaceFacts(entry), entry.id, input.catalog)
    const chat = entry.supportsChat !== false
    const toolCapable = (entry.models ?? []).some((model) => model.supportsTools)
    for (const id of PROVIDER_OPERATION_IDS) {
      const plugin = pluginByOp.get(id)
      if (plugin) {
        cells.push(plugin)
        continue
      }
      const verdict = staticOperationSupport({
        id,
        providerId: entry.id,
        facts,
        protocol: entry.protocol,
        chat,
        toolCapable,
        name: entry.name,
      })
      if (verdict.support === "unsupported") {
        cells.push({
          operationId: id,
          support: "unsupported",
          availability: "unavailable",
          reason: verdict.reason,
        })
        continue
      }
      const { availability, note } = availabilityFor(id)
      cells.push({
        operationId: id,
        support: verdict.support,
        availability,
        ...(note ? { note } : {}),
      })
    }
    return { providerId: input.providerId, deploymentRef: input.deploymentRef, computedAt, cells }
  }

  // Custom provider: protocol decides what a bare base URL can be assumed to do.
  const contract =
    input.contract ?? buildCustomProviderContract({ id: input.providerId, protocol: "openai" })
  const protocol = contract.protocol
  const probed = input.probedFacts ?? {}
  const facts: ProviderSurfaceFacts = {
    ...(protocol === "openai" ? OPENAI_COMPATIBLE_DEFAULTS : NONE),
    tokenCount: protocol === "anthropic",
    ...probed,
  }
  facts.embeddings = probed.embeddings ?? protocol === "openai"
  for (const id of PROVIDER_OPERATION_IDS) {
    const plugin = pluginByOp.get(id)
    if (plugin) {
      cells.push(plugin)
      continue
    }
    const probedForOp = VENDOR_DEPENDENT.has(id) && Object.keys(probed).length > 0
    if (VENDOR_DEPENDENT.has(id) && !probedForOp) {
      cells.push({
        operationId: id,
        support: "unknown",
        availability: "unavailable",
        provenance: "custom-deployment",
        freshness: input.probeFreshness ?? "static",
        failure: {
          code: "capability-unsupported",
          retryable: true,
          message: `custom deployment ${input.providerId}: this surface has not been probed`,
        },
        retry: { on: "manual" },
      })
      continue
    }
    const verdict = staticOperationSupport({
      id,
      facts,
      protocol,
      chat: true,
      toolCapable: true,
      name: input.providerId,
    })
    if (verdict.support === "unsupported") {
      cells.push({
        operationId: id,
        support: "unsupported",
        availability: "unavailable",
        reason: verdict.reason,
      })
      continue
    }
    const { availability, note } = availabilityFor(id)
    cells.push({
      operationId: id,
      support: verdict.support,
      availability,
      ...(note ? { note } : {}),
    })
  }
  return { providerId: input.providerId, deploymentRef: input.deploymentRef, computedAt, cells }
}
