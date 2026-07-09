/**
 * Feishu/Lark doc URL & token recognition for the twin ingest pipeline.
 *
 * Pure parsing only — no network, no credentials. The uploader runs this
 * against user input to decide whether a URL should route to the Lark doc
 * fetcher (`lark-doc-fetcher.ts`) instead of the generic
 * `fetchUrlAsRawSource`. Non-Lark input returns `null` so the caller falls
 * through unchanged.
 *
 * Custom-domain deployments (self-hosted Lark portals) are matched by path
 * pattern only and flagged `lowConfidence` — a false positive is harmless
 * because the fetcher only ever calls open.feishu.cn with the parsed token,
 * never the original host.
 */

export type LarkDocRefKind = "docx" | "wiki" | "doc"

export interface LarkDocRef {
  kind: LarkDocRefKind
  token: string
  /** Original host when parsed from a URL; undefined for bare-token input. */
  host?: string
  /** True when the host is not a known Feishu/Lark suffix (path-pattern-only match). */
  lowConfidence?: boolean
}

/** Known first-party Feishu/Lark host suffixes. */
export const LARK_HOST_SUFFIXES = [".feishu.cn", ".larksuite.com", ".larkoffice.com"] as const

const PATH_KINDS: Record<string, LarkDocRefKind> = {
  docx: "docx",
  wiki: "wiki",
  docs: "doc",
}

/** Lark tokens are URL-safe base64-ish identifiers, typically 20–32 chars. */
const TOKEN_RE = /^[A-Za-z0-9]{14,64}$/

function isKnownLarkHost(hostname: string): boolean {
  const h = hostname.toLowerCase()
  return LARK_HOST_SUFFIXES.some((suffix) => h.endsWith(suffix) || h === suffix.slice(1))
}

/**
 * Parse a Feishu/Lark doc URL or bare token into a `LarkDocRef`.
 *
 * Recognized shapes:
 *   - `https://<tenant>.feishu.cn/docx/<token>` (also larksuite.com / larkoffice.com)
 *   - `https://<tenant>.feishu.cn/wiki/<token>`
 *   - `https://<tenant>.feishu.cn/docs/<token>` (legacy doc)
 *   - Unknown host with one of the path patterns above → `lowConfidence: true`
 *   - Bare tokens: `doxcn…`/`doxbc…` → docx, `wikcn…` → wiki
 *
 * Returns `null` for anything else (including sheets/base/slides paths —
 * unsupported object types are rejected here rather than at fetch time so
 * the UI never suggests the Lark path for them).
 */
export function parseLarkDocUrl(input: string): LarkDocRef | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  // Bare token shapes first — they never parse as URLs.
  if (!trimmed.includes("/") && !trimmed.includes(":")) {
    if (/^(doxcn|doxbc)/i.test(trimmed) && TOKEN_RE.test(trimmed)) {
      return { kind: "docx", token: trimmed }
    }
    if (/^wikcn/i.test(trimmed) && TOKEN_RE.test(trimmed)) {
      return { kind: "wiki", token: trimmed }
    }
    return null
  }

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null

  const segments = url.pathname.split("/").filter(Boolean)
  // The kind segment may be nested under a locale or space prefix
  // (e.g. /wiki/space/<token> is NOT valid, but /docx/<token> under a
  // base path is rare); keep it strict: kind must be followed directly
  // by the token, scanning left to right for the first match.
  for (let i = 0; i < segments.length - 1; i++) {
    const kind = PATH_KINDS[segments[i]]
    if (!kind) continue
    const token = segments[i + 1]
    if (!TOKEN_RE.test(token)) continue
    const known = isKnownLarkHost(url.hostname)
    const ref: LarkDocRef = { kind, token, host: url.hostname }
    if (!known) ref.lowConfidence = true
    return ref
  }
  return null
}

/** True when `input` is a recognizable Feishu/Lark doc URL or token. */
export function isLarkDocUrl(input: string): boolean {
  return parseLarkDocUrl(input) !== null
}
