// Trace destinations as the host passes them through the environment.

export type TelemetryEnv = Record<string, string | undefined>

export interface PostHogDestination {
  id: string
  host: string
  projectToken: string
}

/**
 * OTLP exporter headers. `COGNIA_OTEL_EXPORTER_HEADERS_JSON` (an object) wins
 * over the standard `OTEL_EXPORTER_OTLP_HEADERS` `key=value,key=value` syntax,
 * so a header value may contain `,` or `=`.
 */
export function parseHeaders(
  value: string | undefined,
  jsonValue?: string
): Record<string, string> | undefined {
  if (jsonValue) {
    try {
      const parsed: unknown = JSON.parse(jsonValue)
      // The host serializes this object from its own string map.
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, string>
      }
    } catch {
      // Fall through to the standard OTEL key=value syntax.
    }
  }
  if (!value) return undefined
  return Object.fromEntries(
    value
      .split(",")
      .map((part): [string, string] => {
        const separator = part.indexOf("=")
        return separator < 0
          ? ["", ""]
          : [part.slice(0, separator).trim(), part.slice(separator + 1).trim()]
      })
      .filter(([key, itemValue]) => key && itemValue)
  )
}

/**
 * PostHog trace destinations from `COGNIA_POSTHOG_DESTINATIONS_JSON`. Only
 * project tokens (`phc_…`) on an http(s) host without credentials pass;
 * anything else, including a personal API key, is dropped.
 */
export function parsePostHogDestinations(value: string | undefined): PostHogDestination[] {
  if (!value) return []
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((item: unknown): PostHogDestination[] => {
      if (!item || typeof item !== "object") return []
      const raw = item as { id?: unknown; host?: unknown; projectToken?: unknown }
      const host = typeof raw.host === "string" ? raw.host.trim().replace(/\/$/, "") : ""
      const projectToken = typeof raw.projectToken === "string" ? raw.projectToken.trim() : ""
      try {
        const url = new URL(host)
        if (
          projectToken.length <= "phc_".length ||
          !projectToken.startsWith("phc_") ||
          /\s/.test(projectToken) ||
          !["http:", "https:"].includes(url.protocol) ||
          url.username ||
          url.password
        ) {
          return []
        }
      } catch {
        return []
      }
      return [{ id: String(raw.id ?? "posthog"), host, projectToken }]
    })
  } catch {
    return []
  }
}

/** Langfuse tracing runs when all three credentials are present and neither kill switch is set. */
export function langfuseTracingEnabled(env: TelemetryEnv): boolean {
  return (
    env.COGNIA_LANGFUSE_TRACING_DISABLED !== "1" &&
    env.NEXT_PUBLIC_LANGFUSE_TRACING_DISABLED !== "1" &&
    Boolean(env.LANGFUSE_PUBLIC_KEY && env.LANGFUSE_SECRET_KEY && env.LANGFUSE_BASE_URL)
  )
}
