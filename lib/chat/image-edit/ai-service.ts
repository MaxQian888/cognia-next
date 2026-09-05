/**
 * The model half of the image workbench: which providers can edit an image
 * here, and one path for actually asking them to.
 *
 * There is exactly one route, `images.edit` on the provider operation plane
 * (ADR-0163). The plugin Media API used to hand-roll its own multipart POST to
 * `/images/edits`, with its own base-URL normalisation, its own timeout and its
 * own xAI special case. Duplicating that for chat would have meant two places
 * to fix a provider quirk and two places to forget the PII gate. Going through
 * the operation plane means routing, proxying, credential affinity, the gate
 * and failure classification are all already decided.
 *
 * Nothing here touches a canvas, so it is testable in the fast node project.
 * The caller hands over encoded bytes. `encodeProviderMask` in the image engine
 * is what turns a painted selection into the PNG this sends.
 */

import type {
  ProviderOperationRequest,
  ProviderOperationResult,
  ProviderOperationSurface,
} from "@cognia/provider-types"
import type {
  ProviderSettingsSnapshot,
  ResolveFeatureProviderArgs,
} from "@/lib/ai/provider-consumption"
import {
  createProviderSettingsSnapshot,
  resolveFeatureProvider,
} from "@/lib/ai/provider-consumption"
import {
  isImageEditProvider,
  providerSupportsMaskEdit,
  resolveImageModel,
  IMAGE_EDIT_PROVIDER_IDS,
  type ImageEditProviderId,
} from "@/lib/ai/media/image-generation-sdk"
import { getProviderOperationExecutor } from "@/lib/ai/operations"
import { detectHostSurfaces } from "@/lib/ai/operations/host-surfaces"
import { useSettingsStore } from "@/stores"

import { REMOVE_BACKGROUND_PROMPT } from "./prompts"

export { REMOVE_BACKGROUND_PROMPT } from "./prompts"
import type { ImageEditOperation } from "./version"

/** A provider and model pair the user can actually run an edit on. */
export interface ImageEditCapability {
  providerId: ImageEditProviderId
  modelId: string
  /**
   * Whether this provider's edit endpoint accepts a mask.
   *
   * Load-bearing for the UI: a provider without one can still do a whole-image
   * prompt edit, so the answer is to disable region editing and say why, not to
   * hide the AI panel.
   */
  supportsMask: boolean
}

export type ImageEditUnavailableReason =
  /** No image-edit-capable provider is enabled, or none is set up at all. */
  | "no-provider"
  /** A capable provider is configured but has no credential. */
  | "needs-auth"
  /** Configured and authenticated, but missing a base URL or model. */
  | "needs-config"

export interface ImageEditCapabilities {
  options: ImageEditCapability[]
  /** The default selection, or `null` when `options` is empty. */
  preferred: ImageEditCapability | null
  /** Set only when `options` is empty, so the UI can explain the emptiness. */
  unavailable: { reason: ImageEditUnavailableReason; detail?: string } | null
}

export interface ImageEditCapabilityDeps {
  getSnapshot?: () => ProviderSettingsSnapshot
  resolveProvider?: typeof resolveFeatureProvider
  defaultProviderId?: () => string | undefined
}

function liveSnapshot(): ProviderSettingsSnapshot {
  const settings = useSettingsStore.getState()
  return createProviderSettingsSnapshot({
    defaultProvider: settings.defaultProvider,
    providerSettings: settings.providerSettings,
    customProviders: settings.customProviders,
  })
}

function liveDefaultProviderId(): string | undefined {
  return useSettingsStore.getState().defaultProvider || undefined
}

/**
 * Which failure to report when nothing resolved.
 *
 * Ordered by how close the user is to a working setup, so a half-configured
 * provider is what the message talks about rather than the generic "nothing
 * configured" that would be true of the other four.
 */
function worseReason(
  current: ImageEditUnavailableReason,
  candidate: ImageEditUnavailableReason
): ImageEditUnavailableReason {
  const rank: Record<ImageEditUnavailableReason, number> = {
    "no-provider": 0,
    "needs-auth": 1,
    "needs-config": 2,
  }
  return rank[candidate] > rank[current] ? candidate : current
}

/**
 * Map the resolver's next action onto what the user has to go and do.
 *
 * An unknown or absent next action reads as `no-provider`, which is the honest
 * answer: we learned nothing about this provider, so "nothing is set up" is the
 * only claim supported. Collapsing it into `needs-config` instead would make
 * that branch unreachable and leave the UI telling a user with no providers at
 * all to go and fix a configuration they never wrote.
 */
function reasonForResolution(nextAction: unknown): ImageEditUnavailableReason {
  switch (nextAction) {
    case "add_api_key":
      return "needs-auth"
    case "configure_base_url":
    case "select_default_model":
      return "needs-config"
    default:
      return "no-provider"
  }
}

/**
 * Enumerate every configured provider that can edit an image.
 *
 * The user's default provider is tried first when it is edit-capable, so the
 * workbench opens on the provider the rest of the app is already using.
 */
export function resolveImageEditCapabilities(
  deps: ImageEditCapabilityDeps = {}
): ImageEditCapabilities {
  const getSnapshot = deps.getSnapshot ?? liveSnapshot
  const resolve = deps.resolveProvider ?? resolveFeatureProvider
  const defaultProviderId = (deps.defaultProviderId ?? liveDefaultProviderId)()

  const snapshot = getSnapshot()
  const ordered: ImageEditProviderId[] = [
    ...(defaultProviderId && isImageEditProvider(defaultProviderId) ? [defaultProviderId] : []),
    ...IMAGE_EDIT_PROVIDER_IDS,
  ].filter((id, index, all) => all.indexOf(id) === index)

  const options: ImageEditCapability[] = []
  // Starts unset rather than pre-seeded at the lowest rank. Seeding it would
  // make the first candidate never "worse" than the seed, so a genuine
  // no-provider explanation would be discarded and the user would be told
  // nothing at all about why the panel is empty.
  let reason: ImageEditUnavailableReason | null = null
  let detail: string | undefined

  for (const providerId of ordered) {
    const args: ResolveFeatureProviderArgs = {
      featureId: "chat-image-edit",
      routeProfile: "capability-bound",
      selectionMode: "explicit-provider",
      providerId,
      fallbackMode: "none",
      proxyMode: "preferred",
    }
    const resolution = resolve(args, snapshot)
    if (resolution.kind === "resolved") {
      options.push({
        providerId,
        modelId: resolveImageModel(providerId, resolution.model),
        supportsMask: providerSupportsMaskEdit(providerId),
      })
      continue
    }
    const candidate = reasonForResolution((resolution as { nextAction?: unknown }).nextAction)
    if (reason === null || worseReason(reason, candidate) !== reason) {
      reason = candidate
      detail = (resolution as { reason?: string }).reason
    }
  }

  return {
    options,
    preferred: options[0] ?? null,
    unavailable:
      options.length > 0
        ? null
        : { reason: reason ?? "no-provider", ...(detail ? { detail } : {}) },
  }
}

/** What the user asked the model to do. */
export type ImageEditIntent =
  /** Edit the whole frame from a prompt. */
  | { kind: "prompt"; prompt: string }
  /** Edit only the painted region. `mask` is already provider-convention PNG. */
  | { kind: "region"; prompt: string; mask: { bytes: Uint8Array; mediaType: string } }
  /** Isolate the subject. A fixed prompt, so the user writes nothing. */
  | { kind: "remove-background" }

export type ImageEditErrorCode =
  /** A region edit was asked of a provider with no mask support. */
  | "mask-unsupported"
  /** Routing could not produce a usable provider. */
  | "unavailable"
  /** The prompt did not pass the outbound PII gate. */
  | "blocked"
  /** The provider answered, but with no image. */
  | "no-output"
  /** The user aborted. */
  | "cancelled"
  /** Anything the provider itself rejected or failed on. */
  | "provider"

export interface ImageEditSuccess {
  ok: true
  bytes: Uint8Array
  mediaType: string
  providerId: string
  modelId: string
  /** What to record on the saved version. */
  operation: ImageEditOperation
}

export interface ImageEditFailure {
  ok: false
  code: ImageEditErrorCode
  message: string
  /** Whether offering a Retry button makes sense. */
  retryable: boolean
}

export type ImageEditOutcome = ImageEditSuccess | ImageEditFailure

export interface RunImageEditInput {
  image: { bytes: Uint8Array; mediaType: string }
  intent: ImageEditIntent
  capability: ImageEditCapability
  signal?: AbortSignal
}

export interface RunImageEditDeps {
  execute?: (
    request: ProviderOperationRequest<unknown>,
    options?: { signal?: AbortSignal }
  ) => Promise<ProviderOperationResult<unknown>>
  surfaces?: readonly ProviderOperationSurface[]
}

/** The operation recorded on the version, per intent. */
export function operationForIntent(intent: ImageEditIntent): ImageEditOperation {
  switch (intent.kind) {
    case "region":
      return "ai.region"
    case "remove-background":
      return "ai.remove-background"
    default:
      return "ai.prompt"
  }
}

function promptForIntent(intent: ImageEditIntent): string {
  return intent.kind === "remove-background" ? REMOVE_BACKGROUND_PROMPT : intent.prompt
}

/**
 * `bytesRef` for the operation contract, carrying the raw bytes only.
 *
 * The contract also allows a `base64` twin, and setting it here would be pure
 * cost. `dataContentOf` prefers `bytes` in-process, so nothing reads it, while
 * the executor's PII gate walks the whole input: a base64 string of a 3MB
 * frame is roughly another 500ms of synchronous main-thread scanning per edit,
 * for a field only a cross-process hop would ever need. Whatever forwards this
 * request to another process is where the twin belongs.
 */
function bytesRef(payload: { bytes: Uint8Array; mediaType: string }) {
  return {
    bytes: new Uint8Array(payload.bytes),
    mimeType: payload.mediaType,
  }
}

function decodeBase64(base64: string): Uint8Array {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(base64, "base64"))
  const binary = atob(base64)
  const out = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index)
  return out
}

/**
 * Ask the configured provider to edit an image.
 *
 * Never throws. Every path returns an outcome, because each of these failures
 * has its own thing to say in the UI: a missing mask capability is a provider
 * choice, a blocked prompt is a redaction problem, and a cancelled request is
 * not a failure at all.
 */
export async function runImageEdit(
  { image, intent, capability, signal }: RunImageEditInput,
  deps: RunImageEditDeps = {}
): Promise<ImageEditOutcome> {
  if (intent.kind === "region" && !capability.supportsMask) {
    return {
      ok: false,
      code: "mask-unsupported",
      message: `${capability.providerId} does not accept a mask, so only whole-image edits are possible.`,
      retryable: false,
    }
  }

  const prompt = promptForIntent(intent).trim()
  if (prompt.length === 0) {
    return {
      ok: false,
      code: "provider",
      message: "An edit prompt is required.",
      retryable: false,
    }
  }

  const execute =
    deps.execute ?? ((request, options) => getProviderOperationExecutor().execute(request, options))
  const surfaces = deps.surfaces ?? detectHostSurfaces()

  const request: ProviderOperationRequest<unknown> = {
    operationId: "images.edit",
    providerId: capability.providerId,
    scopes: ["provider:invoke"],
    surface: surfaces[0] ?? "renderer",
    input: {
      model: capability.modelId,
      prompt,
      n: 1,
      image: bytesRef(image),
      ...(intent.kind === "region" ? { mask: bytesRef(intent.mask) } : {}),
    },
  }

  let result: ProviderOperationResult<unknown>
  try {
    result = await execute(request, signal ? { signal } : {})
  } catch (error) {
    if (signal?.aborted) {
      return { ok: false, code: "cancelled", message: "Edit cancelled.", retryable: true }
    }
    return {
      ok: false,
      code: "provider",
      message: error instanceof Error ? error.message : String(error),
      retryable: true,
    }
  }

  if (signal?.aborted) {
    return { ok: false, code: "cancelled", message: "Edit cancelled.", retryable: true }
  }

  if (!result.ok) {
    const failure = result.failure as { code?: string; message?: string; retryable?: boolean }
    // `permission` is the operation plane's code for a PII-gate rejection
    // (`executor.ts` step 5, and `toProviderDiagnosticFailure` for the
    // handler's own gate). There is no distinct `pii-gate` code on the wire:
    // keying on one would have made this branch permanently unreachable and
    // reported a blocked prompt as "your provider needs configuring".
    //
    // The plane's other two `permission` failures are a missing scope and a
    // provider-pinned handle mismatch. Neither can arise here: this call
    // always passes `provider:invoke`, and `images.edit` is not pinned.
    const blocked = failure?.code === "permission"
    const unavailable =
      result.availability === "needs-auth" ||
      result.availability === "needs-config" ||
      result.availability === "unavailable"
    return {
      ok: false,
      code: blocked ? "blocked" : unavailable ? "unavailable" : "provider",
      message: failure?.message ?? `The ${result.providerId ?? "image"} provider refused the edit.`,
      // An unavailable provider will stay unavailable until the user changes
      // something, so a Retry button there is a lie.
      retryable: !blocked && !unavailable && failure?.retryable !== false,
    }
  }

  const output = result.output as { images?: Array<Record<string, unknown>> } | undefined
  const first = output?.images?.[0]
  const bytes = first?.bytes
  const base64 = first?.base64
  const decoded =
    bytes instanceof Uint8Array ? bytes : typeof base64 === "string" ? decodeBase64(base64) : null

  if (!decoded || decoded.byteLength === 0) {
    return {
      ok: false,
      code: "no-output",
      message: "The provider returned no image. The selected model may not support editing.",
      retryable: true,
    }
  }

  return {
    ok: true,
    bytes: decoded,
    mediaType: typeof first?.mimeType === "string" ? first.mimeType : "image/png",
    providerId: result.providerId,
    modelId: capability.modelId,
    operation: operationForIntent(intent),
  }
}
