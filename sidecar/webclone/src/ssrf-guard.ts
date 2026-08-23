/**
 * SSRF guard for the vendored web-clone engine.
 *
 * A snapshot fetches a page's HTML and then every sub-resource URL it references
 * (CSS `@import`/`url()`, `<script src>`, `<img>`, fonts, …). Those URLs are
 * fully attacker-influenceable — a hostile page can point them at loopback,
 * private-LAN, or cloud-metadata endpoints (`169.254.169.254`). This module
 * classifies each target host and denies those ranges unless the caller
 * explicitly opts in (`allowPrivateHosts`). It also rejects non-http(s) schemes.
 *
 * The classification itself lives in `@cognia/network-guard`, shared with the
 * app-side `web_fetch` gate and the connector inbound-media floor. It used to
 * be a hand-kept copy of the app gate, and the copies drifted: this one missed
 * `fec0::/10` and every IPv4-mapped literal, because the URL parser
 * re-serialises `::ffff:169.254.169.254` to `::ffff:a9fe:a9fe` and the textual
 * check never fired. The package decodes the address instead.
 *
 * The package is a real dependency rather than a workspace symlink on purpose:
 * Tauri bundles `webclone/node_modules/**` as resources, and Node refuses to
 * strip types from anything under `node_modules`, so the sidecar consumes the
 * package's COMPILED output from a physically installed directory
 * (`npm install --install-links`). See `scripts/build/build-webclone-sidecar.mjs`.
 *
 * What stays here is what is only true of this runtime: the engine runs as a
 * one-shot child process per snapshot job, so a single job owns the process and
 * the module-level {@link setSsrfPolicy} is safe.
 */

import {
  evaluateFetchTarget,
  type FetchGuardOptions,
  type FetchGuardReason,
} from "@cognia/network-guard"

export {
  evaluateFetchTarget,
  isPrivateOrLocalHost,
  type FetchGuardDecision,
  type FetchGuardOptions,
  type FetchGuardReason,
} from "@cognia/network-guard"

/** Thrown by {@link assertFetchTargetAllowed} when a target is not permitted. */
export class FetchTargetBlockedError extends Error {
  readonly url: string
  readonly host: string
  readonly reason: FetchGuardReason

  constructor(url: string, host: string, reason: FetchGuardReason) {
    super(
      reason === "bad-scheme"
        ? `Refusing to fetch non-http(s) URL: ${url}`
        : reason === "bad-url"
          ? `Refusing to fetch an unparseable URL: ${url}`
          : `Refusing to fetch a private/loopback address (${host}). Enable "allow private hosts" to override.`
    )
    this.name = "FetchTargetBlockedError"
    this.url = url
    this.host = host
    this.reason = reason
  }
}

/**
 * Enforce {@link evaluateFetchTarget}; throws {@link FetchTargetBlockedError}
 * when the target is not permitted. Call before any outbound request.
 */
export function assertFetchTargetAllowed(url: string, options: FetchGuardOptions = {}): void {
  const decision = evaluateFetchTarget(url, options)
  if (!decision.allowed) {
    throw new FetchTargetBlockedError(url, decision.host ?? "", decision.reason)
  }
}

// ── One-shot module policy (a snapshot job owns the whole child process) ──────

let activePolicy: FetchGuardOptions = { allowPrivateHosts: false }

/** Set the SSRF policy for the current process (called once at job start). */
export function setSsrfPolicy(options: FetchGuardOptions): void {
  activePolicy = { allowPrivateHosts: Boolean(options.allowPrivateHosts) }
}

/** Read the SSRF policy currently in effect. */
export function getSsrfPolicy(): FetchGuardOptions {
  return activePolicy
}

/**
 * Guard an outbound URL against the active module policy. This is the single
 * call every transport path in the engine funnels through
 * (`fetchWithTimeout` + redirect following in `fetcher.ts`).
 */
export function guardOutboundUrl(url: string): void {
  assertFetchTargetAllowed(url, activePolicy)
}
