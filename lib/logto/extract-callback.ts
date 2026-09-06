/**
 * Read an authorization code out of what a person pasted.
 *
 * The desktop sign-in sends the system browser to a deep link. When the OS
 * hands that link back the wait resolves on its own, but a browser that never
 * comes back leaves the person with an address bar to copy. This accepts the
 * whole address, or the bare code on its own, and nothing else.
 */
export function extractCallback(input: string): { code: string; state?: string } | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  try {
    const url = new URL(trimmed)
    const code = url.searchParams.get("code")
    if (!code) return null
    const state = url.searchParams.get("state")
    return state ? { code, state } : { code }
  } catch {
    // Not a URL. A bare code has no whitespace in it.
    return /\s/.test(trimmed) ? null : { code: trimmed }
  }
}
