/**
 * Built-in remote decision provider (ADR-0194): the TypeSafe decisions
 * protocol over HTTPS — OpenRouter `alpha/decisions` or any `/v1/systemone`
 * gateway, picked in settings.
 *
 * Egress goes through `createPlatformFetch` (desktop proxy policy on Tauri,
 * CapacitorHttp on mobile) as the network-egress gate requires. The endpoint
 * key is read from the keyring per call and never appears in errors. The host
 * (`runDecision`) has already redacted and PII-gated the request.
 */

import {
  createPlatformFetch,
  reachesNonCorsHosts,
  type PlatformFetch,
} from "@/lib/network/platform-fetch"
import { getDecisionHttpKey, loadDecisionSettings } from "@/lib/decisions/config"
import { attributionHeaders, resolveDecisionEndpoint } from "@/lib/decisions/presets"
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
    calibrated: true,
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
      const body = JSON.stringify({
        model: endpoint.model,
        state: request.state,
        questions: request.questions,
      })
      const started = Date.now()
      let outcome: DeadlineOutcome<Response>
      try {
        outcome = await withDeadline(
          (signal) =>
            d.fetch(endpoint.url, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                authorization: `Bearer ${key}`,
                ...attributionHeaders(endpoint.url),
              },
              body,
              signal,
            }),
          d.timeoutMs,
          options.signal
        )
      } catch (error) {
        if (!d.reachesNonCorsHosts()) {
          return fail(
            "cors_unreachable",
            "the browser shell cannot reach this decisions endpoint; use the desktop or mobile app"
          )
        }
        const message = error instanceof Error ? error.message : String(error)
        return fail("network", `decisions endpoint unreachable: ${message}`)
      }
      if ("aborted" in outcome) return fail("aborted", "the decision request was cancelled")
      if ("timedOut" in outcome) {
        return fail("timeout", `the decisions endpoint did not answer within ${d.timeoutMs} ms`)
      }
      const response = outcome.value
      const text = await response.text().catch(() => "")
      if (!response.ok) {
        return fail(
          "http_status",
          `decisions endpoint returned HTTP ${response.status}${
            text ? `: ${text.slice(0, MAX_ERROR_BODY_CHARS)}` : ""
          }`,
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
        latencyMs: Date.now() - started,
        routing: { model: endpoint.model },
      }
    },
  }
}
