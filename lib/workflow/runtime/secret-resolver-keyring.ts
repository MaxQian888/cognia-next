/**
 * Keyring-backed SecretResolver. Reads secrets out of the OS keyring (or
 * the AES-GCM web fallback) by parsing the credential `refId` into a
 * `(namespace, key)` pair. Two ref formats are accepted:
 *
 *   1. `"keyring:<namespace>:<key>"`        — explicit form (preferred).
 *   2. `"<namespace>/<key>"` (single slash)  — shorthand for plugin secrets.
 *
 * The resolver short-circuits to {@link NoopSecretResolver} for refs that
 * don't match either form so existing workflows that wired refs against
 * an in-memory bag keep working.
 */

import { getSecret } from "@/lib/keyring"
import { isTauri } from "@/lib/tauri"
import { NoopSecretResolver, type SecretResolver } from "./secret-resolver"

export function createKeyringSecretResolver(): SecretResolver {
  return {
    resolve: async (refId: string) => {
      const ref = parseRef(refId)
      if (!ref) return undefined
      const value = await getSecret(ref)
      return value ?? undefined
    },
  }
}

/**
 * The production default resolver for `runWorkflow`. On desktop (Tauri) this
 * reads credential refs out of the OS keyring; in web/test (jsdom) it degrades
 * to {@link NoopSecretResolver}. Wiring this as the orchestrator default fixes
 * the gap where every production `runWorkflow` caller omitted a resolver, so
 * keyring-backed credential refs (e.g. `ai.prompt` node API keys) silently
 * resolved to `undefined` and fell back to stub output.
 */
export function getDefaultSecretResolver(): SecretResolver {
  return isTauri() ? createKeyringSecretResolver() : NoopSecretResolver
}

interface ParsedRef {
  namespace: string
  key: string
}

export function parseRef(refId: string): ParsedRef | null {
  if (!refId || typeof refId !== "string") return null
  if (refId.startsWith("keyring:")) {
    const rest = refId.slice("keyring:".length)
    const colon = rest.indexOf(":")
    if (colon <= 0 || colon === rest.length - 1) return null
    return { namespace: rest.slice(0, colon), key: rest.slice(colon + 1) }
  }
  // `<namespace>/<key>` shorthand. Only honour when the namespace looks like
  // a plugin id (kebab / underscore) to avoid catching URLs.
  const slash = refId.indexOf("/")
  if (slash <= 0 || slash === refId.length - 1) return null
  const namespace = refId.slice(0, slash)
  const key = refId.slice(slash + 1)
  if (!/^[a-z][a-z0-9_-]*$/i.test(namespace)) return null
  return { namespace, key }
}
