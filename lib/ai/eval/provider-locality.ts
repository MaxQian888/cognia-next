import type { ResolvedProvider } from "@/lib/ai/provider-consumption"

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase()
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1" ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized)
  )
}

/**
 * Locality is security-sensitive: it comes from the resolved endpoint, never
 * from an editable project flag or provider display name.
 */
export function isConfirmedLocalProvider(resolution: ResolvedProvider): boolean {
  if (resolution.useProxy || !resolution.baseURL) return false
  try {
    const url = new URL(resolution.baseURL)
    return (
      (url.protocol === "http:" || url.protocol === "https:") && isLoopbackHostname(url.hostname)
    )
  } catch {
    return false
  }
}
