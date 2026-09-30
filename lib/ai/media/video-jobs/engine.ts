/**
 * The video job engine (ADR-0205): start a provider job, persist its opaque
 * operation, check it on a schedule, download the result once, store it, and
 * settle. Every surface — the chat tool, `/video`, the plugin API, the
 * provider-operations `videos.*` handlers — goes through here.
 *
 * Expected failures never throw: `startVideoJob` returns `{ ok: false }` and a
 * job that fails later settles with a coded `error` on its row.
 */

import {
  experimental_getVideoStatus,
  experimental_startVideo,
  type GenerateVideoPrompt,
  type JSONValue,
} from "ai"
import { computeBackoffDelay } from "@cognia/primitives"
import { hasNoLeakingPii, hasNoLeakingPiiDeep, redactText } from "@cognia/redact"

import type { ProviderSettingsSnapshot, ResolvedProvider } from "@/lib/ai/provider-consumption"
import { credentialAffinityOf } from "@/lib/ai/operations/credential-affinity"
import {
  MediaGenerationError,
  assertSafeMediaPrompt,
  createProviderVideoModel,
  resolveVideoProvider,
} from "../provider-generation"
import {
  VIDEO_GENERATION_PROVIDER_IDS,
  isVideoProviderReachable,
  resolveVideoModel,
  type VideoProviderId,
} from "../video-generation-sdk"
import { buildRemoteVideoCancel } from "./cancel"
import { checkVideoJobParams, type VideoJobParams } from "./params"
import type { MediaJobStore } from "./store"
import {
  canRecheckVideoJob,
  isSettledVideoJob,
  newVideoJobId,
  type MediaGenerationJobRow,
  type VideoJobError,
  type VideoJobErrorCode,
  type VideoJobOrigin,
  type VideoJobResult,
  type VideoJobStartFrameRef,
} from "./types"

/** First status check after a start; providers rarely finish sooner. */
export const FIRST_POLL_DELAY_MS = 5_000
/** Poll backoff: 5 s doubling to a 60 s ceiling. */
const POLL_BACKOFF = { baseDelayMs: 5_000, maxDelayMs: 60_000 } as const
/** A job with no terminal answer after this settles `timed_out` (G9). */
export const VIDEO_JOB_DEADLINE_MS = 30 * 60_000
/** Download timeout handed to the native transports. */
const VIDEO_DOWNLOAD_TIMEOUT_MS = 10 * 60_000

/** A `fetch` that also takes the native transports' per-call options. */
export type VideoJobFetch = (
  input: RequestInfo | URL,
  init?: RequestInit & { timeout?: number; binaryResponse?: boolean }
) => Promise<Response>

/** A start frame as a caller supplies it. */
export type VideoJobStartFrameInput =
  | { kind: "media"; ref: string }
  | { kind: "session-asset"; assetId: string }
  | { kind: "bytes"; data: Uint8Array; mediaType: string }

export interface ResolvedStartFrame {
  data: Uint8Array
  mediaType: string
}

export interface VideoJobEngineDeps {
  store: MediaJobStore
  now(): number
  /** Provider settings for jobs checked outside a request (the reconciler). */
  getSnapshot(): ProviderSettingsSnapshot
  /** Transport for provider calls, downloads and remote cancels. */
  fetch: VideoJobFetch
  /** False on the web build, where only CORS-open providers are reachable. */
  reachesNonCorsHosts(): boolean
  /** Turn a start-frame reference into bytes (checks it belongs to the session). */
  resolveStartFrame(
    frame: VideoJobStartFrameInput,
    origin: VideoJobOrigin
  ): Promise<ResolvedStartFrame>
  /** Store the finished video where the job's origin expects it. */
  materialize(row: MediaGenerationJobRow, video: Blob): Promise<VideoJobResult>
  /** Largest video this shell can download and store. */
  maxResultBytes: number
  startVideo?: typeof experimental_startVideo
  getVideoStatus?: typeof experimental_getVideoStatus
  createModel?: typeof createProviderVideoModel
  newId?(now: number): string
}

export interface StartVideoJobInput {
  prompt: string
  startFrame?: VideoJobStartFrameInput
  providerId?: string
  model?: string
  params?: VideoJobParams
  /**
   * Vendor options passed straight to the start call. Not persisted: they
   * shape the generation, and a status check never needs them.
   */
  providerOptions?: Parameters<typeof experimental_startVideo>[0]["providerOptions"]
  origin: VideoJobOrigin
  projectId?: string
  /** Use this snapshot instead of `deps.getSnapshot()` (executor requests). */
  snapshot?: ProviderSettingsSnapshot
  abortSignal?: AbortSignal
}

export type StartVideoJobResult =
  { ok: true; job: MediaGenerationJobRow } | { ok: false; error: VideoJobError }

/**
 * Provider and transport text is stored on the row, shown on the job card and
 * handed back to the agent by `video_status`. Scrub it once here: drop URL
 * query strings (Google's download URL carries `?key=<api key>`) and redact
 * anything the PII detector flags, so a quoted email in a provider's error can
 * neither leak nor turn every later status read into a gate refusal.
 */
function scrubbed(text: string): string {
  const withoutQueries = text.replace(/(https?:\/\/[^\s?#"']+)\?[^\s#"']*/g, "$1")
  return hasNoLeakingPii(withoutQueries) ? withoutQueries : redactText(withoutQueries).redacted
}

function failure(code: VideoJobErrorCode, message: string, recheckable = false): VideoJobError {
  return { code, message: scrubbed(message), recheckable }
}

function messageOf(error: unknown): string {
  return scrubbed(error instanceof Error ? error.message : String(error))
}

function fromMediaError(error: unknown): VideoJobError {
  if (error instanceof MediaGenerationError) {
    switch (error.code) {
      case "PII_BLOCKED":
        return failure("pii_blocked", error.message)
      case "UNSUPPORTED_PROVIDER":
        return failure("unsupported_input", error.message)
      case "NO_PROVIDER":
      case "PROVIDER_CONFIGURATION":
        return failure("no_provider", error.message, true)
    }
  }
  return failure("provider_error", messageOf(error), true)
}

function sessionIdOf(origin: VideoJobOrigin): string | undefined {
  return origin.surface === "chat-tool" || origin.surface === "slash" ? origin.sessionId : undefined
}

function frameRefOf(frame: VideoJobStartFrameInput, mediaType: string): VideoJobStartFrameRef {
  switch (frame.kind) {
    case "media":
      return { kind: "media", ref: frame.ref }
    case "session-asset":
      return { kind: "session-asset", assetId: frame.assetId }
    case "bytes":
      return { kind: "inline", mediaType }
  }
}

function warningText(warnings: ReadonlyArray<unknown>): string[] {
  return warnings.map((warning) => {
    if (warning && typeof warning === "object") {
      const w = warning as { feature?: unknown; details?: unknown; message?: unknown }
      const parts = [w.feature, w.details ?? w.message].filter((p) => typeof p === "string")
      if (parts.length) return scrubbed(parts.join(": "))
    }
    return scrubbed(JSON.stringify(warning))
  })
}

export function createVideoJobEngine(deps: VideoJobEngineDeps) {
  const startVideo = deps.startVideo ?? experimental_startVideo
  const getVideoStatus = deps.getVideoStatus ?? experimental_getVideoStatus
  const createModel = deps.createModel ?? createProviderVideoModel
  const newId = deps.newId ?? newVideoJobId
  const modelFetch = deps.fetch as unknown as typeof globalThis.fetch

  function webBlocked(providerId: VideoProviderId): VideoJobError | null {
    if (isVideoProviderReachable(providerId, deps.reachesNonCorsHosts())) return null
    return failure(
      "unavailable_on_web",
      `${providerId} video generation needs the desktop or mobile app; the browser cannot reach it.`
    )
  }

  /**
   * The provider for a new job. A named one is taken as is (the web gate then
   * refuses it by name). Without a name the first choice is the default chat
   * provider or the first configured one; on the web build that may be one the
   * browser cannot reach while another configured provider is fine, so fall
   * through to the first reachable one rather than failing the whole request.
   */
  function resolveStartProvider(
    snapshot: ProviderSettingsSnapshot,
    providerId: string | undefined
  ): ResolvedProvider {
    const first = resolveVideoProvider(snapshot, providerId)
    const reach = deps.reachesNonCorsHosts()
    if (providerId || isVideoProviderReachable(first.providerId as VideoProviderId, reach)) {
      return first
    }
    for (const candidate of VIDEO_GENERATION_PROVIDER_IDS) {
      if (!isVideoProviderReachable(candidate, reach)) continue
      try {
        return resolveVideoProvider(snapshot, candidate)
      } catch {
        // Not configured; keep looking.
      }
    }
    return first
  }

  async function start(input: StartVideoJobInput): Promise<StartVideoJobResult> {
    const prompt = input.prompt.trim()
    if (!prompt) return { ok: false, error: failure("unsupported_input", "The prompt is empty.") }
    try {
      assertSafeMediaPrompt(prompt)
    } catch (error) {
      return { ok: false, error: fromMediaError(error) }
    }
    const optionsCheck = checkProviderOptions(input.providerOptions)
    if (optionsCheck) return { ok: false, error: optionsCheck }

    let resolved: ResolvedProvider
    try {
      resolved = resolveStartProvider(input.snapshot ?? deps.getSnapshot(), input.providerId)
    } catch (error) {
      return { ok: false, error: fromMediaError(error) }
    }
    const providerId = resolved.providerId as VideoProviderId
    const blocked = webBlocked(providerId)
    if (blocked) return { ok: false, error: blocked }

    const modelId = resolveVideoModel(providerId, input.model ?? resolved.model)
    // The model id goes out in the request path or body. A model name only has
    // to contain a known fragment to be accepted, so hold it to an id's shape
    // and to the PII gate like the prompt.
    if (!MODEL_ID.test(modelId)) {
      return { ok: false, error: failure("unsupported_input", "That is not a model id.") }
    }
    if (!hasNoLeakingPii(modelId)) {
      return {
        ok: false,
        error: failure("pii_blocked", "The model id failed the outbound PII gate."),
      }
    }
    const params = input.params ?? {}
    const check = checkVideoJobParams(providerId, modelId, params, input.startFrame !== undefined)
    if (!check.ok) return { ok: false, error: failure("unsupported_input", check.message) }

    let frame: ResolvedStartFrame | undefined
    if (input.startFrame) {
      try {
        frame = await deps.resolveStartFrame(input.startFrame, input.origin)
      } catch (error) {
        return { ok: false, error: failure("unsupported_input", messageOf(error)) }
      }
      if (!frame.mediaType.startsWith("image/")) {
        return {
          ok: false,
          error: failure("unsupported_input", "The start frame must be an image."),
        }
      }
    }

    const sdkPrompt: GenerateVideoPrompt = frame ? { image: frame.data, text: prompt } : prompt
    let started: Awaited<ReturnType<typeof experimental_startVideo>>
    try {
      started = await startVideo({
        model: createModel(resolved, modelId, { fetch: modelFetch }),
        prompt: sdkPrompt,
        ...(params.aspectRatio ? { aspectRatio: params.aspectRatio } : {}),
        ...(params.resolution ? { resolution: params.resolution } : {}),
        ...(params.durationSec !== undefined ? { duration: params.durationSec } : {}),
        ...(params.seed !== undefined ? { seed: params.seed } : {}),
        ...(params.fps !== undefined ? { fps: params.fps } : {}),
        ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
        ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
      })
    } catch (error) {
      return { ok: false, error: failure("provider_error", messageOf(error)) }
    }

    const now = deps.now()
    const sessionId = sessionIdOf(input.origin)
    const warnings = warningText(started.warnings)
    const row: MediaGenerationJobRow = {
      id: newId(now),
      kind: "video",
      ...(sessionId ? { sessionId } : {}),
      ...(input.projectId ? { projectId: input.projectId } : {}),
      origin: input.origin,
      request: {
        prompt,
        ...(input.startFrame && frame
          ? { startFrame: frameRefOf(input.startFrame, frame.mediaType) }
          : {}),
        ...params,
      },
      provider: {
        providerId,
        modelId,
        ...(resolved.baseURL ? { baseURL: resolved.baseURL } : {}),
        credentialAffinity: credentialAffinityOf(resolved.apiKey),
      },
      operation: started.operation,
      status: "generating",
      pollCount: 0,
      nextPollAt: now + FIRST_POLL_DELAY_MS,
      deadlineAt: now + VIDEO_JOB_DEADLINE_MS,
      ...(warnings.length ? { warnings } : {}),
      createdAt: now,
      updatedAt: now,
    }
    await deps.store.insert(row)
    return { ok: true, job: row }
  }

  /**
   * Rebuild the job's provider from current settings, pinned to the base URL
   * it started on. A changed API key means the key that owns the remote job
   * is gone, so the job cannot be checked with it.
   */
  function reconnect(
    row: MediaGenerationJobRow,
    snapshot: ProviderSettingsSnapshot | undefined
  ): { ok: true; resolved: ResolvedProvider } | { ok: false; error: VideoJobError } {
    let resolved: ResolvedProvider
    try {
      resolved = resolveVideoProvider(snapshot ?? deps.getSnapshot(), row.provider.providerId)
    } catch (error) {
      return { ok: false, error: fromMediaError(error) }
    }
    if (credentialAffinityOf(resolved.apiKey) !== row.provider.credentialAffinity) {
      return {
        ok: false,
        error: failure(
          "credential_changed",
          `The ${row.provider.providerId} API key changed since this video started.`,
          true
        ),
      }
    }
    return { ok: true, resolved: { ...resolved, baseURL: row.provider.baseURL } }
  }

  async function settleFailed(
    row: MediaGenerationJobRow,
    from: MediaGenerationJobRow["status"],
    error: VideoJobError
  ): Promise<MediaGenerationJobRow | undefined> {
    const now = deps.now()
    return deps.store.transition(row.id, from, "failed", { error, updatedAt: now, settledAt: now })
  }

  async function download(
    row: MediaGenerationJobRow,
    video:
      | { type: "url"; url: string; mediaType: string }
      | { type: "base64"; data: string; mediaType: string }
      | { type: "binary"; data: Uint8Array; mediaType: string }
  ): Promise<{ ok: true; blob: Blob } | { ok: false; error: VideoJobError }> {
    if (video.type === "binary") {
      return {
        ok: true,
        blob: new Blob([video.data as Uint8Array<ArrayBuffer>], { type: video.mediaType }),
      }
    }
    if (video.type === "base64") {
      const binary = atob(video.data)
      const bytes = new Uint8Array(new ArrayBuffer(binary.length))
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
      return { ok: true, blob: new Blob([bytes], { type: video.mediaType }) }
    }
    let response: Response
    try {
      response = await deps.fetch(video.url, {
        timeout: VIDEO_DOWNLOAD_TIMEOUT_MS,
        binaryResponse: true,
      })
    } catch (error) {
      const message = messageOf(error)
      if (message.includes(PROXY_BODY_LIMIT_MESSAGE)) {
        return { ok: false, error: failure("result_too_large", message) }
      }
      return { ok: false, error: failure("download_failed", message, true) }
    }
    if (response.status === 403 || response.status === 404 || response.status === 410) {
      return {
        ok: false,
        error: failure(
          "result_expired",
          `The provider no longer serves this video (HTTP ${response.status}).`
        ),
      }
    }
    if (!response.ok) {
      return {
        ok: false,
        error: failure(
          "download_failed",
          `Downloading the video failed (HTTP ${response.status}).`,
          true
        ),
      }
    }
    const declared = Number(response.headers.get("content-length"))
    if (Number.isFinite(declared) && declared > deps.maxResultBytes) {
      return {
        ok: false,
        error: failure(
          "result_too_large",
          `The video is ${declared} bytes; the limit is ${deps.maxResultBytes}.`
        ),
      }
    }
    const blob = await response.blob()
    if (blob.size > deps.maxResultBytes) {
      return {
        ok: false,
        error: failure(
          "result_too_large",
          `The video is ${blob.size} bytes; the limit is ${deps.maxResultBytes}.`
        ),
      }
    }
    const type = blob.type || video.mediaType || "video/mp4"
    return { ok: true, blob: blob.type ? blob : new Blob([blob], { type }) }
  }

  /**
   * Check one job once. A `generating` job past its deadline settles
   * `timed_out`; `pending` schedules the next check; `completed` claims the
   * download (only one caller wins) and stores the video.
   */
  async function poll(
    jobId: string,
    options: { snapshot?: ProviderSettingsSnapshot; force?: boolean } = {}
  ): Promise<MediaGenerationJobRow | undefined> {
    const row = await deps.store.get(jobId)
    if (!row || row.status !== "generating") return row
    const now = deps.now()
    if (!options.force && now >= row.deadlineAt) {
      return deps.store.transition(row.id, "generating", "timed_out", {
        error: failure("timed_out", "The provider did not finish within 30 minutes.", true),
        updatedAt: now,
        settledAt: now,
      })
    }
    const connection = reconnect(row, options.snapshot)
    if (!connection.ok) return settleFailed(row, "generating", connection.error)

    let status: Awaited<ReturnType<typeof experimental_getVideoStatus>>
    try {
      status = await getVideoStatus(
        createModel(connection.resolved, row.provider.modelId, { fetch: modelFetch }),
        { operation: row.operation, maxRetries: 1 }
      )
    } catch (error) {
      // Transient: keep the job and back off; the deadline bounds retries.
      return deps.store.update(row.id, "generating", {
        pollCount: row.pollCount + 1,
        nextPollAt: now + backoff(row.pollCount),
        lastPollError: messageOf(error),
        updatedAt: now,
      })
    }

    if (status.status === "pending") {
      return deps.store.update(row.id, "generating", {
        pollCount: row.pollCount + 1,
        nextPollAt: now + backoff(row.pollCount),
        lastPollError: undefined,
        updatedAt: now,
      })
    }
    if (status.status === "error") {
      return settleFailed(row, "generating", failure("generation_failed", status.error))
    }

    const claimed = await deps.store.transition(row.id, "generating", "downloading", {
      pollCount: row.pollCount + 1,
      lastPollError: undefined,
      updatedAt: now,
    })
    if (!claimed) return deps.store.get(row.id)
    const video = status.videos[0]
    if (!video) {
      return settleFailed(
        claimed,
        "downloading",
        failure("generation_failed", "The provider returned no video.")
      )
    }
    return finish(claimed, video)
  }

  async function finish(
    row: MediaGenerationJobRow,
    video: Parameters<typeof download>[1]
  ): Promise<MediaGenerationJobRow | undefined> {
    const downloaded = await download(row, video)
    if (!downloaded.ok) return settleFailed(row, "downloading", downloaded.error)
    let result: VideoJobResult
    try {
      result = await deps.materialize(row, downloaded.blob)
    } catch (error) {
      return settleFailed(row, "downloading", failure("store_failed", messageOf(error), true))
    }
    const now = deps.now()
    return deps.store.transition(row.id, "downloading", "succeeded", {
      result,
      updatedAt: now,
      settledAt: now,
    })
  }

  /**
   * Stop a job. Providers with a cancel endpoint are asked to stop; for the
   * rest the job only stops being checked (`remoteCancelled: false`). A job
   * already downloading has finished remotely and is not cancelled.
   */
  async function cancel(
    jobId: string,
    options: { snapshot?: ProviderSettingsSnapshot } = {}
  ): Promise<MediaGenerationJobRow | undefined> {
    const row = await deps.store.get(jobId)
    if (!row || row.status !== "generating") return row
    let remoteCancelled = false
    const connection = reconnect(row, options.snapshot)
    if (connection.ok) {
      const request = buildRemoteVideoCancel(row.provider.providerId, {
        operation: row.operation as JSONValue,
        apiKey: connection.resolved.apiKey,
        baseURL: row.provider.baseURL,
      })
      if (request) {
        try {
          const response = await deps.fetch(request.url, {
            method: request.method,
            headers: request.headers,
          })
          remoteCancelled = response.ok
        } catch {
          remoteCancelled = false
        }
      }
    }
    const now = deps.now()
    return deps.store.transition(row.id, "generating", "cancelled", {
      remoteCancelled,
      updatedAt: now,
      settledAt: now,
    })
  }

  /**
   * Put a settled-but-recheckable job back to `generating` with a fresh
   * deadline and check it now (G9 "check again"). The remote job kept its id,
   * so a job that finished while this side was timed out or disconnected is
   * picked up rather than paid for twice.
   */
  async function recheck(
    jobId: string,
    options: { snapshot?: ProviderSettingsSnapshot } = {}
  ): Promise<MediaGenerationJobRow | undefined> {
    const row = await deps.store.get(jobId)
    if (!row || !canRecheckVideoJob(row)) return row
    const now = deps.now()
    const reopened = await deps.store.transition(row.id, row.status, "generating", {
      error: undefined,
      settledAt: undefined,
      pollCount: 0,
      // Checked right below; the reconciler must not pick it up meanwhile.
      nextPollAt: now + FIRST_POLL_DELAY_MS,
      deadlineAt: now + VIDEO_JOB_DEADLINE_MS,
      updatedAt: now,
    })
    if (!reopened) return deps.store.get(row.id)
    return poll(row.id, { ...options, force: true })
  }

  /**
   * Resolve when the job settles, polling it in-process on its own schedule.
   * For callers that must hand back the video itself (plugin API, workflow
   * node). Another window's reconciler may settle it first; either way the
   * settled row is returned.
   */
  async function wait(
    jobId: string,
    options: {
      signal?: AbortSignal
      snapshot?: ProviderSettingsSnapshot
      sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
    } = {}
  ): Promise<MediaGenerationJobRow | undefined> {
    const sleep = options.sleep ?? defaultSleep
    for (;;) {
      if (options.signal?.aborted) {
        await cancel(jobId, { snapshot: options.snapshot })
        return deps.store.get(jobId)
      }
      const current = await deps.store.get(jobId)
      if (!current || isSettledVideoJob(current)) return current
      if (current.status === "generating" && current.nextPollAt <= deps.now()) {
        const next = await poll(jobId, { snapshot: options.snapshot })
        // No row back means another window moved the job under this poll (it
        // took the download, or a new reconciler leader reset it); read it
        // again rather than report a job that is still going as missing.
        if (next && isSettledVideoJob(next)) return next
        continue
      }
      const delay =
        current.status === "generating"
          ? Math.max(0, current.nextPollAt - deps.now())
          : FIRST_POLL_DELAY_MS
      await sleep(delay, options.signal)
    }
  }

  return { start, poll, recheck, cancel, wait }
}

export type VideoJobEngine = ReturnType<typeof createVideoJobEngine>

/**
 * Keys a provider adapter copies over its own request fields. Several adapters
 * spread unknown `providerOptions` into the request body after setting
 * `prompt`, so one of these would replace the prompt the PII gate just checked.
 */
const PROMPT_OVERRIDE_KEYS = new Set(["prompt", "text", "image", "image_url", "img_url"])

/** Provider model ids: letters, digits and `. _ : / -`, as every listed provider uses. */
const MODEL_ID = /^[\w.:/-]{1,128}$/

/** `hasNoLeakingPiiDeep` reads values only; option keys go out verbatim too. */
function keysAreClean(value: unknown, seen: WeakSet<object> = new WeakSet()): boolean {
  if (!value || typeof value !== "object") return true
  if (seen.has(value)) return true
  seen.add(value)
  if (Array.isArray(value)) return value.every((item) => keysAreClean(item, seen))
  return Object.entries(value).every(
    ([key, child]) => hasNoLeakingPii(key) && keysAreClean(child, seen)
  )
}

/** Vendor options go out verbatim: gate every string in them, and refuse prompt overrides. */
function checkProviderOptions(
  providerOptions: StartVideoJobInput["providerOptions"]
): VideoJobError | null {
  if (!providerOptions) return null
  if (!hasNoLeakingPiiDeep(providerOptions) || !keysAreClean(providerOptions)) {
    return failure("pii_blocked", "Video provider options failed the outbound PII gate.")
  }
  for (const [provider, options] of Object.entries(providerOptions)) {
    if (!options || typeof options !== "object") continue
    const override = Object.keys(options).find((key) => PROMPT_OVERRIDE_KEYS.has(key))
    if (override) {
      return failure(
        "unsupported_input",
        `providerOptions.${provider}.${override} would replace the prompt or start frame; pass it as the prompt instead.`
      )
    }
  }
  return null
}

/** The desktop proxy bridge's refusal for a body over its 64 MiB cap. */
export const PROXY_BODY_LIMIT_MESSAGE = "response body exceeds proxy bridge byte limit"

function backoff(pollCount: number): number {
  return computeBackoffDelay(pollCount, {
    ...POLL_BACKOFF,
    jitter: { kind: "ratio", ratio: 0.1 },
  })
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true }
    )
  })
}
