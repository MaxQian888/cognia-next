import { invoke } from "@tauri-apps/api/core"

export type TauriTelemetryCredential =
  | { kind: "none" }
  | { kind: "grafanaCloud"; instanceId: string }
  | { kind: "langfuse"; publicKey: string }
  | { kind: "posthog"; projectToken: string }

export interface TauriPostHogDestination {
  id: "managed" | "byo"
  host: string
  projectToken: string
}

export interface TauriOtlpFetchOptions {
  credential: TauriTelemetryCredential
  traceparent?: string
}

export interface TauriSidecarTelemetryOptions {
  enabled: boolean
  endpoint: string
  headers: Record<string, string>
  serviceName: string
  environment: string
  credential: TauriTelemetryCredential
  posthogDestinations?: TauriPostHogDestination[]
  installationId?: string
}

interface TelemetryExportResult {
  status: number
  accepted: boolean
}

let requestSequence = 0

const SENSITIVE_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
])

function endpointOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input
  if (input instanceof URL) return input.toString()
  return input.url
}

function normalizeHeaders(init: RequestInit | undefined): Record<string, string> {
  const headers: Record<string, string> = {}
  new Headers(init?.headers).forEach((value, name) => {
    const normalized = name.toLowerCase()
    if (SENSITIVE_HEADERS.has(normalized)) {
      throw new Error(`Renderer-supplied sensitive header is not allowed: ${name}`)
    }
    headers[normalized] = value
  })
  return headers
}

function nextTelemetryRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID()
  }
  requestSequence += 1
  return `telemetry-${Date.now().toString(16)}-${requestSequence.toString(16)}`
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError")
}

/** Fetch-compatible OTLP POST implemented by the Tauri Rust command. */
export function createTauriOtlpFetch(options: TauriOtlpFetchOptions): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (init?.signal?.aborted) {
      throw abortError()
    }
    if (init?.method && init.method.toUpperCase() !== "POST") {
      throw new Error("Tauri OTLP export only supports POST")
    }
    if (init?.body != null && typeof init.body !== "string") {
      throw new Error("Tauri OTLP export requires a string body")
    }
    const requestId = nextTelemetryRequestId()
    const pending = invoke<TelemetryExportResult>("telemetry_otlp_export", {
      requestId,
      endpoint: endpointOf(input),
      body: typeof init?.body === "string" ? init.body : "",
      headers: normalizeHeaders(init),
      credential: options.credential,
      traceparent: options.traceparent,
    })
    const result = init?.signal
      ? await new Promise<TelemetryExportResult>((resolve, reject) => {
          const onAbort = () => {
            void invoke("telemetry_otlp_cancel", { requestId }).catch(() => {})
            reject(abortError())
          }
          init.signal?.addEventListener("abort", onAbort, { once: true })
          pending
            .then(resolve, reject)
            .finally(() => init.signal?.removeEventListener("abort", onAbort))
        })
      : await pending
    return new Response("", { status: result.status })
  }
}

/** Native JSON POST used by desktop-only telemetry integrations such as Langfuse. */
export async function postTauriTelemetryJson(
  endpoint: string,
  body: string,
  credential: TauriTelemetryCredential,
  signal?: AbortSignal
): Promise<void> {
  const response = await createTauriOtlpFetch({ credential })(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    signal,
  })
  if (!response.ok) throw new Error(`Native telemetry export failed with ${response.status}`)
}

export async function configureTauriSidecarTelemetry(
  options: TauriSidecarTelemetryOptions
): Promise<void> {
  const changed = await invoke<boolean>("telemetry_configure_sidecar", { ...options })
  if (changed) {
    await invoke("claude_restart_sidecar")
  }
}
