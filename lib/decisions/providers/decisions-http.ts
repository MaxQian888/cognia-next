/**
 * Built-in remote decision provider (ADR-0194): the TypeSafe decisions
 * protocol and AI SDK decision adapters over HTTPS, picked in settings.
 *
 * Egress goes through `createPlatformFetch` (desktop proxy policy on Tauri,
 * CapacitorHttp on mobile) as the network-egress gate requires. The endpoint
 * key is read from the keyring per call and never appears in errors. The host
 * (`runDecision`) has already redacted and PII-gated the request.
 */

import { InvalidArgumentError as SdkInvalidArgumentError } from "ai"
import { APICallError, InvalidArgumentError } from "@ai-sdk/provider"
import { decideWithSdk } from "./decision-sdk"
import {
  createPlatformFetch,
  reachesNonCorsHosts,
  type PlatformFetch,
} from "@/lib/network/platform-fetch"
import { getDecisionHttpKey, loadDecisionSettings } from "@/lib/decisions/config"
import {
  DECISION_HTTP_PRESETS,
  attributionHeaders,
  resolveDecisionEndpoint,
} from "@/lib/decisions/presets"
import type {
  DecisionHttpPresetId,
  DecisionProvider,
  DecisionProviderResponse,
  DecisionSettings,
} from "@/types/decisions"

export const BUILTIN_HTTP_PROVIDER_ID = "builtin:decisions-http"

/** One decision is ~1 s on the hosted models; 20 s covers a cold gateway. */
export const DECISIONS_HTTP_TIMEOUT_MS = 20_000

/** Error bodies are echoed for diagnosis, capped so a HTML error page stays short. */
const MAX_ERROR_BODY_CHARS = 300

export interface DecisionsHttpDeps {
  loadSettings: () => Promise<DecisionSettings>
  getKey: (preset: DecisionHttpPresetId) => Promise<string | null>
  fetch: PlatformFetch
  /** False in the plain browser shell, where a non-CORS host is unreachable. */
  reachesNonCorsHosts: () => boolean
  timeoutMs: number
}

function defaultDeps(): DecisionsHttpDeps {
  return {
    loadSettings: loadDecisionSettings,
    getKey: getDecisionHttpKey,
    fetch: createPlatformFetch(),
    reachesNonCorsHosts,
    timeoutMs: DECISIONS_HTTP_TIMEOUT_MS,
  }
}

function fail(kind: string, message: string, status?: number): DecisionProviderResponse {
  return { ok: false, error: { kind, message, ...(status !== undefined ? { status } : {}) } }
}

const ENDPOINT_PROBLEMS: Record<string, string> = {
  no_preset: "no remote decisions endpoint is selected",
  no_url: "the custom decisions endpoint has no URL",
  bad_url: "the decisions endpoint URL must be https (plain http only for localhost)",
  no_model: "the decisions endpoint has no model",
}

type DeadlineOutcome<T> = { value: T } | { aborted: true } | { timedOut: true }

/**
 * Race the request against the caller's signal and a timer. Capacitor's HTTP
 * bridge ignores `AbortSignal`, so the race — not the transport — is what
 * bounds the wait on every shell.
 */
async function withDeadline<T>(
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  outer?: AbortSignal
): Promise<DeadlineOutcome<T>> {
  if (outer?.aborted) return { aborted: true }
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let detach: (() => void) | undefined
  const deadline = new Promise<{ timedOut: true } | { aborted: true }>((resolve) => {
    timer = setTimeout(() => {
      controller.abort()
      resolve({ timedOut: true })
    }, timeoutMs)
    if (outer) {
      const onAbort = () => {
        controller.abort()
        resolve({ aborted: true })
      }
      if (outer.aborted) onAbort()
      else {
        outer.addEventListener("abort", onAbort, { once: true })
        detach = () => outer.removeEventListener("abort", onAbort)
      }
    }
  })
  try {
    return await Promise.race([work(controller.signal).then((value) => ({ value })), deadline])
  } finally {
    if (timer) clearTimeout(timer)
    detach?.()
  }
}

export function createDecisionsHttpProvider(
  overrides: Partial<DecisionsHttpDeps> = {}
): DecisionProvider {
  let deps: DecisionsHttpDeps | null = null
  const resolveDeps = () => (deps ??= { ...defaultDeps(), ...overrides })

  return {
    id: BUILTIN_HTTP_PROVIDER_ID,
    label: "Remote decisions endpoint",
    locality: "remote",
    // This provider also hosts LLM estimates and arbitrary custom endpoints.
    calibrated: false,
    async status() {
      const { loadSettings, getKey } = resolveDeps()
      const endpoint = resolveDecisionEndpoint((await loadSettings()).http)
      if (!endpoint.ok) return { ready: false, message: ENDPOINT_PROBLEMS[endpoint.reason] }
      if (!(await getKey(endpoint.preset))) {
        return { ready: false, message: "the decisions endpoint has no API key" }
      }
      return { ready: true }
    },
    async decide(request, options = {}) {
      const d = resolveDeps()
      const endpoint = resolveDecisionEndpoint((await d.loadSettings()).http)
      if (!endpoint.ok) return fail("not_configured", ENDPOINT_PROBLEMS[endpoint.reason])
      const key = await d.getKey(endpoint.preset)
      if (!key) return fail("not_configured", "the decisions endpoint has no API key")
      const started = Date.now()
      let transportFailed = false
      const fetch: PlatformFetch = async (url, init) => {
        try {
          return await d.fetch(url, init)
        } catch (error) {
          transportFailed = true
          throw error
        }
      }
      let outcome: DeadlineOutcome<DecisionProviderResponse>
      try {
        // Bound the whole operation, including SDK loading and response parsing.
        outcome = await withDeadline(
          async (signal) => {
            if (DECISION_HTTP_PRESETS[endpoint.preset].adapter !== "legacy") {
              return decideWithSdk(request, endpoint, key, fetch, signal)
            }
            // Preserve permissive legacy/custom responses and their full POST URL.
            const response = await fetch(endpoint.url, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                authorization: `Bearer ${key}`,
                ...attributionHeaders(endpoint.url),
              },
              body: JSON.stringify({
                model: endpoint.model,
                state: request.state,
                questions: request.questions,
              }),
              signal,
            })
            const text = await response.text()
            if (!response.ok) {
              return fail(
                "http_status",
                `decisions endpoint returned HTTP ${response.status}: ${text.split(key).join("[REDACTED]").slice(0, MAX_ERROR_BODY_CHARS)}`,
                response.status
              )
            }
            let parsed: unknown
            try {
              parsed = JSON.parse(text)
            } catch {
              return fail("provider_error", "decisions endpoint returned non-JSON")
            }
            const answers =
              typeof parsed === "object" && parsed !== null
                ? (parsed as { answers?: unknown }).answers
                : undefined
            if (typeof answers !== "object" || answers === null || Array.isArray(answers)) {
              return fail("provider_error", "decisions endpoint reply has no answers object")
            }
            return {
              ok: true,
              answers: answers as Record<string, unknown>,
              routing: { model: endpoint.model },
              probabilityKind: "unknown",
            }
          },
          d.timeoutMs,
          options.signal
        )
      } catch (error) {
        if (options.signal?.aborted) return fail("aborted", "the decision request was cancelled")
        if (transportFailed) {
          return d.reachesNonCorsHosts()
            ? fail("network", "decisions endpoint unreachable")
            : fail(
                "cors_unreachable",
                "the browser shell cannot reach this decisions endpoint; use the desktop or mobile app"
              )
        }
        // Gateway wraps APICallError; retain the originating HTTP status.
        let apiError: unknown = error
        for (let depth = 0; depth < 4 && !APICallError.isInstance(apiError); depth++) {
          if (!(apiError instanceof Error) || !apiError.cause) break
          apiError = apiError.cause
        }
        if (
          APICallError.isInstance(apiError) &&
          apiError.statusCode &&
          apiError.statusCode >= 400
        ) {
          const detail = (apiError.responseBody ?? apiError.message)
            .split(key)
            .join("[REDACTED]")
            .slice(0, MAX_ERROR_BODY_CHARS)
          return fail(
            "http_status",
            `decisions endpoint returned HTTP ${apiError.statusCode}: ${detail}`,
            apiError.statusCode
          )
        }
        if (InvalidArgumentError.isInstance(error) || SdkInvalidArgumentError.isInstance(error)) {
          return fail(
            "invalid_request",
            "the decision adapter rejected the question or state format"
          )
        }
        // SDK schema errors can embed the full request/response in their message.
        return fail("provider_error", "the decision adapter could not read the provider reply")
      }
      if ("aborted" in outcome) return fail("aborted", "the decision request was cancelled")
      if ("timedOut" in outcome) {
        return fail("timeout", `the decisions endpoint did not answer within ${d.timeoutMs} ms`)
      }
      return outcome.value.ok
        ? { ...outcome.value, latencyMs: Date.now() - started }
        : outcome.value
    },
  }
}
