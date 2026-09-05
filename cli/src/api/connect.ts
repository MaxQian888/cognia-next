/**
 * Turn a resolved host into a transport, or explain why it cannot be one.
 *
 * The resolver decides *which* host. This decides whether that host is
 * reachable with the credential the CLI actually holds, and every refusal it
 * produces carries the command that would fix it. A missing token is the most
 * common first failure, so it is worth more than a 401.
 */

import { CompanionWorkerTransport } from "../worker/companion-worker-transport"
import type { CliFailure } from "../cli/errors"
import { detectDesktop, type HandoffClientDeps } from "../handoff/client"
import type { HostResolution, ResolvedHost } from "../host/resolve"
import {
  deviceTransport,
  internalTransport,
  type HostTransport,
  type TransportFetch,
} from "./transport"

export interface ConnectDeps {
  fetchImpl?: TransportFetch
  /** Injected so tests never look for a real desktop. */
  detect?: (deps?: HandoffClientDeps) => Promise<{ baseUrl: string } | null>
}

export type ConnectResult =
  { ok: true; transport: HostTransport } | { ok: false; failure: CliFailure }

/**
 * A TLS-pinned fetch when the host record carries a fingerprint.
 *
 * A Cognia Host terminates HTTPS with a self-signed certificate, so the OS
 * trust store cannot vouch for it. Pinning the SubjectPublicKeyInfo captured
 * at pair time is what makes that safe: a host presenting a different key is
 * refused rather than trusted because the URL still matches.
 */
function pinnedFetch(serverFingerprint: string | undefined, base?: TransportFetch): TransportFetch {
  if (!serverFingerprint) return base ?? ((url, init) => fetch(url, init))
  const worker = new CompanionWorkerTransport()
  return (url, init) => worker.fetch(url, { ...init, serverFingerprint })
}

/** The Fix lines offered when nothing resolved, tuned by what is running here. */
async function noHostFailure(resolution: HostResolution, deps: ConnectDeps): Promise<CliFailure> {
  const detect = deps.detect ?? detectDesktop
  const desktop = await detect().catch(() => null)
  const fix = desktop
    ? [
        // A desktop is running, but its CLI bridge only carries the 18 routes
        // ADR-0078 gave it, and dispatching commands is deliberately not one
        // of them. The desktop's own Companion API is the reachable surface,
        // and pairing is how a CLI gets onto it.
        "a Cognia desktop is running here, so pair with its Companion API:",
        "take a pairing code from Settings then Companion, then run",
        "cognia-agent host login desktop --endpoint https://127.0.0.1:27890 --pair-code <code>",
      ]
    : [
        "cognia-agent host add <name> --endpoint https://127.0.0.1:27890",
        "or export COGNIA_SERVER_URL and COGNIA_SERVICE_TOKEN for a headless server",
      ]
  return {
    error: "no Cognia host is configured",
    details: resolution.skipped.map((leg) => `${leg.leg}: ${leg.reason}`),
    cause: "no-host",
    fix,
    inspect: ["cognia-agent host show", "cognia-agent host list"],
  }
}

export async function connectHost(
  resolution: HostResolution,
  deps: ConnectDeps = {}
): Promise<ConnectResult> {
  if (!resolution.host) {
    return { ok: false, failure: await noHostFailure(resolution, deps) }
  }
  return connectResolvedHost(resolution.host, deps)
}

export function connectResolvedHost(
  host: ResolvedHost,
  deps: ConnectDeps = {}
): Promise<ConnectResult> {
  const endpoint = host.endpoint.value

  if (host.kind.value === "device") {
    const record = host.record
    if (!record?.deviceId || !record.devicePrivateKeyJwk) {
      return Promise.resolve({
        ok: false,
        failure: {
          error: `host ${host.name ?? endpoint} is a device host with no device identity`,
          cause: "auth",
          fix: [`cognia-agent host login${host.name ? ` --profile ${host.name}` : ""}`],
          inspect: ["cognia-agent host show"],
        },
      })
    }
    const tenantId = host.tenantId?.value
    if (!tenantId) {
      return Promise.resolve({
        ok: false,
        failure: {
          error: `host ${host.name ?? endpoint} has no tenant id, which the device token exchange requires`,
          cause: "auth",
          fix: ["pass --tenant <id>, or re-run cognia-agent host login to record it"],
          inspect: ["cognia-agent host show"],
        },
      })
    }
    return deviceTransport({
      endpoint,
      tenantId,
      deviceId: record.deviceId,
      privateKeyJwk: record.devicePrivateKeyJwk as JsonWebKey,
      ...(record.serverFingerprint ? { serverFingerprint: record.serverFingerprint } : {}),
      fetchImpl: pinnedFetch(record.serverFingerprint, deps.fetchImpl),
    }).then((transport) => ({ ok: true as const, transport }))
  }

  const serviceToken = host.serviceToken?.value
  if (!serviceToken) {
    return Promise.resolve({
      ok: false,
      failure: {
        error: `no service token for ${endpoint}`,
        details: [
          `endpoint came from ${host.endpoint.source}${host.endpoint.origin ? ` (${host.endpoint.origin})` : ""}`,
          "the headless wire is loopback-only and refuses an unauthenticated caller",
        ],
        cause: "auth",
        fix: [
          "export COGNIA_SERVICE_TOKEN=$(pnpm --silent dev:headless token)",
          "or run the CLI on the host that serves the API",
        ],
        inspect: ["cognia-agent host show"],
      },
    })
  }

  return Promise.resolve({
    ok: true,
    transport: internalTransport({
      endpoint,
      serviceToken,
      fetchImpl: pinnedFetch(host.record?.serverFingerprint, deps.fetchImpl),
    }),
  })
}
