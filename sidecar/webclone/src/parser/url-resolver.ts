export function resolveUrl(raw: string, baseUrl: string): string | null {
  if (
    !raw ||
    raw.startsWith("data:") ||
    raw.startsWith("blob:") ||
    raw.startsWith("javascript:") ||
    raw.startsWith("mailto:")
  ) {
    return null
  }

  try {
    // new URL() handles protocol-relative URLs (//example.com/path) natively
    const resolved = new URL(raw, baseUrl)
    // Security checks: only http and https protocols are allowed
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
      return null
    }
    return resolved.href
  } catch {
    return null
  }
}

export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url)
    u.hash = ""
    return u.href
  } catch {
    return url
  }
}

export function parseSrcset(srcset: string, baseUrl: string): string[] {
  const urls: string[] = []
  for (const part of srcset.split(",")) {
    const trimmed = part.trim()
    const match = trimmed.match(/^(\S+)/)
    if (match) {
      const resolved = resolveUrl(match[1], baseUrl)
      if (resolved) urls.push(resolved)
    }
  }
  return urls
}
