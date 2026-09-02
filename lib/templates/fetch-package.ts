"use client"

/**
 * Fetch template package bytes from a URL the user typed.
 *
 * The Studio could import a package from a file and, since share links landed,
 * from a link the app itself minted. It could not import one from an ordinary
 * URL, which is how a team actually publishes templates: a release asset, a
 * static host, an internal artifact server.
 *
 * Three things happen before a single byte reaches the zip reader:
 *
 *  1. **SSRF guard.** `assertFetchTargetAllowed` is the same classifier the
 *     agent's `web_fetch` and the connector inbound-media floor use. Loopback
 *     and private ranges are refused, because a URL typed into a dialog is also
 *     a URL that can be pasted into one.
 *  2. **Transport.** `createPlatformFetch`, not a bare `fetch`. The packaged
 *     desktop CSP blocks renderer requests to a user-named origin outright, and
 *     the mobile WebView needs the native HTTP plugin to reach a host that
 *     serves no CORS headers.
 *  3. **Size cap, twice.** `Content-Length` is checked before the body is read
 *     so an oversized package costs nothing, and the received bytes are checked
 *     again afterwards because the header is a claim, not a promise.
 */

import { assertFetchTargetAllowed } from "@/lib/web/fetch-guard"
import { createPlatformFetch, type PlatformFetch } from "@/lib/network/platform-fetch"
import { TEMPLATE_PACKAGE_MAX_COMPRESSED_BYTES } from "./package"

export class TemplatePackageFetchError extends Error {
  readonly reason: "too-large" | "http" | "network"
  constructor(reason: TemplatePackageFetchError["reason"], message: string) {
    super(message)
    this.name = "TemplatePackageFetchError"
    this.reason = reason
  }
}

export interface FetchTemplatePackageOptions {
  /** Injected in tests. Production resolves the shell's own transport. */
  fetchImpl?: PlatformFetch
  /** Overrides the compressed-size ceiling. Defaults to the package limit. */
  maxBytes?: number
}

export interface FetchedTemplatePackage {
  bytes: Uint8Array
  /** The URL actually read, recorded as `provenance.sourceUrl` on import. */
  sourceUrl: string
}

export async function fetchTemplatePackage(
  url: string,
  options: FetchTemplatePackageOptions = {}
): Promise<FetchedTemplatePackage> {
  const trimmed = url.trim()
  // Throws `FetchTargetBlockedError`, which the dialog renders as-is: its
  // message already names the reason and the setting that relaxes it.
  assertFetchTargetAllowed(trimmed)
  const maxBytes = options.maxBytes ?? TEMPLATE_PACKAGE_MAX_COMPRESSED_BYTES
  const fetchImpl = options.fetchImpl ?? createPlatformFetch()

  let response: Response
  try {
    response = await fetchImpl(trimmed, { redirect: "follow" })
  } catch (error) {
    throw new TemplatePackageFetchError(
      "network",
      error instanceof Error ? error.message : String(error)
    )
  }
  if (!response.ok) {
    throw new TemplatePackageFetchError("http", `HTTP ${response.status}`)
  }
  const declared = Number(response.headers.get("content-length") ?? "")
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new TemplatePackageFetchError(
      "too-large",
      `Template package exceeds ${maxBytes} compressed bytes`
    )
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > maxBytes) {
    throw new TemplatePackageFetchError(
      "too-large",
      `Template package exceeds ${maxBytes} compressed bytes`
    )
  }
  return { bytes, sourceUrl: trimmed }
}
