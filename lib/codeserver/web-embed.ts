/**
 * Where a browser can reach a running workbench, if anywhere.
 *
 * The desktop shell embeds code-server in a native child webview and never
 * needs this. A browser cannot: the workbench answers on a loopback port on
 * the HOST, and the only other way in is `/ide/relay/{id}/`, which sits behind
 * `require_device_access` and therefore needs a bearer token on every request.
 * An iframe cannot attach one and neither can a top-level navigation, so for
 * an off-machine browser there is genuinely nothing to open, and saying so is
 * better than rendering a frame that will sit blank.
 *
 * The one case that does work is a browser running ON the host. Loopback is a
 * secure context with no certificate to validate, and code-server is spawned
 * with `--auth none` precisely because only that machine can reach it. So the
 * whole question reduces to: is the Host this browser is paired with the same
 * machine the browser is on, and did the Host tell us the port.
 *
 * Both halves are needed and neither is sufficient. The Host discloses the
 * port only to a caller that arrived on its loopback-bound plaintext listener
 * (`ExecutionPlane::LoopbackPlaintext`), so a port in hand already means the
 * Host judged us same-machine. Checking the endpoint here as well means the
 * frame is not pointed at `127.0.0.1` on the strength of a field alone.
 */

import { isLoopbackHostname } from "@/lib/connectivity/loopback-hostname"
import type { CodeServerStatus } from "@/lib/codeserver/client"

export type WebWorkbenchTarget =
  | { kind: "embed"; url: string }
  | { kind: "unavailable"; reason: "not-running" | "needs-host-browser" }

export interface WebWorkbenchInput {
  status: CodeServerStatus | null
  /**
   * Base URL of the Host this shell is paired with, or `null` when this shell
   * IS the host and runs the workbench in-process.
   */
  hostBaseUrl: string | null
}

/**
 * True when the Host is this machine.
 *
 * `isLoopbackHostname` rather than a string compare: `URL.hostname` keeps the
 * brackets on an IPv6 literal, so `[::1]` fails every naive equality check.
 * A malformed base URL is treated as remote, because guessing in the
 * permissive direction here points a frame at the wrong machine's loopback.
 */
export function hostIsThisMachine(hostBaseUrl: string | null): boolean {
  if (hostBaseUrl === null) return true
  try {
    return isLoopbackHostname(new URL(hostBaseUrl).hostname)
  } catch {
    return false
  }
}

export function resolveWebWorkbenchTarget({
  status,
  hostBaseUrl,
}: WebWorkbenchInput): WebWorkbenchTarget {
  if (!status?.running) return { kind: "unavailable", reason: "not-running" }
  if (!hostIsThisMachine(hostBaseUrl)) {
    return { kind: "unavailable", reason: "needs-host-browser" }
  }
  // Running, same machine, and the Host still withheld the port: this browser
  // did not reach it over the plaintext loopback listener (that listener is
  // opt-in, and a TLS request whose Host header says localhost does not
  // qualify). There is no second way in.
  if (typeof status.port !== "number") {
    return { kind: "unavailable", reason: "needs-host-browser" }
  }
  // The literal, not the endpoint's own hostname: the port was disclosed
  // because the Host is on this machine, so `127.0.0.1` is the address that
  // is true regardless of what name the pairing was made under.
  return { kind: "embed", url: `http://127.0.0.1:${status.port}/` }
}
