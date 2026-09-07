/**
 * Resolve a browser engine for one workflow step.
 *
 * A node cannot just call `routeEngine` and hope, because both engines it can
 * return are owned by React:
 *
 *  - the embedded engine goes through `browserClient`, whose module-level
 *    owner lease is written only by `hooks/browser/use-browser-pane-webview`.
 *    With `/browser` closed, a scheduled run throws "Embedded browser owner
 *    lease is not acquired" three calls deep, after it has already navigated.
 *  - `configureRemoteBrowserEngine` has one production caller,
 *    `components/browser/remote-browser-preview`, which nulls it on unmount.
 *
 * So this reuses `routeEngine` for the routing *decision* and owns its own
 * binding. It never calls `configureRemoteBrowserEngine`: that is a global
 * singleton, and writing it from a background run would clobber the pane's.
 */

import { routeEngine, type BrowserEngine, type EngineRoute } from "@/lib/browser/agent-engine"
import { browserClient } from "@/lib/browser/client"
import {
  isBrowserDomainAuthorized,
  primeBrowserDomainGrants,
} from "@/lib/browser/domain-authorization"
import { resolveTrustTier, type TrustTier } from "@/lib/browser/protocol"
import { RemoteChromiumEngine } from "@/lib/browser/remote-chromium-engine"
import { transport } from "@/lib/tauri"
import type { StepExecutionContext } from "@/types/workflow/visual"
import { nonRetryable } from "../shared/executor-support"
import { getRunBrowserSession, registerRunBrowserSession } from "./session-registry"

export interface ResolvedBrowserEngine {
  engine: BrowserEngine
  backend: "embedded" | "remote-chromium"
  tier: TrustTier
}

/** Grants are in Dexie and `routeEngine` is synchronous, so prime once per run. */
const primedRuns = new Set<string>()

async function primeGrantsOnce(runId: string): Promise<void> {
  if (primedRuns.has(runId)) return
  primedRuns.add(runId)
  try {
    await primeBrowserDomainGrants()
  } catch {
    // A failed prime leaves the snapshot empty, which denies rather than
    // permits. That is the safe direction.
  }
}

/**
 * Refuse a public URL this workspace never granted.
 *
 * `routeEngine`'s own behaviour for an unauthorized public URL is to fall
 * through to the embedded engine. For a person watching a pane that is a
 * graceful degrade. For a run with nobody present it is a policy bypass, so
 * the node stops instead, and never prompts.
 */
export function assertBrowserUrlAllowed(url: string, kind: string): TrustTier {
  const tier = resolveTrustTier(url)
  if (tier === "trusted") return tier
  if (isBrowserDomainAuthorized(url)) return tier
  let host = url
  try {
    host = new URL(url).host
  } catch {
    // Keep the raw string. A URL this malformed is worth showing verbatim.
  }
  throw nonRetryable(
    `${kind}: ${host} is not an authorized browsing domain for this workspace. ` +
      `Grant it under Settings, Companion, Remote browser, then run this again. ` +
      `An unattended run never prompts and never falls back to the local pane.`
  )
}

export async function resolveRunBrowserEngine(
  ctx: StepExecutionContext,
  url: string,
  kind: string
): Promise<ResolvedBrowserEngine> {
  await primeGrantsOnce(ctx.runId)
  const tier = assertBrowserUrlAllowed(url, kind)

  const existing = getRunBrowserSession(ctx.runId)
  if (existing) return { engine: existing.engine, backend: "remote-chromium", tier }

  let route: EngineRoute | undefined
  try {
    route = routeEngine(url, { domainAuthorized: isBrowserDomainAuthorized(url) })
  } catch {
    // `routeEngine` throws when it wants the remote engine and nothing is
    // bound, which is the ordinary state for a run. Fall through and mint one.
    route = undefined
  }

  // Reuse the pane only when it is genuinely there. Someone is watching, and
  // sharing the page they have open is the right answer for a manual run.
  if (route?.backend === "embedded" && browserClient.hasEmbedOwner()) {
    return { engine: route.engine, backend: "embedded", tier }
  }

  // A pane-bound remote engine is deliberately NOT reused. ADR-0085 binds one
  // BrowserSession to one parent chat session, so a background run taking over
  // the user's page is the same defect as stealing their focus.
  return { ...(await ensureRunRemoteSession(ctx, kind)), tier }
}

async function ensureRunRemoteSession(
  ctx: StepExecutionContext,
  kind: string
): Promise<{ engine: BrowserEngine; backend: "remote-chromium" }> {
  const workspaceId = ctx.projectId

  // Asked first, for the reason the pane records: this is the one RPC the
  // gateway answers when `workspace-runtime-exec` is not compiled. Every other
  // one, `browser_capability` included, is refused with `browser_disabled`, so
  // asking it last means the build that most needs the explanation never
  // reaches it.
  const status = await transport
    .call<{ compiled?: boolean; healthy?: boolean; enabled?: boolean; reason?: string }>(
      "browser_runtime_status",
      { workspaceId }
    )
    .catch(() => null)
  if (status && status.compiled === false) {
    throw nonRetryable(
      `${kind}: this build has no remote browser runtime, and no browser pane is open to borrow. ` +
        `Open the Browser pane and run this from the desktop, or use a build with the runtime.`
    )
  }
  if (status && status.healthy === false) {
    throw nonRetryable(
      `${kind}: the remote browser runtime is not healthy (${status.reason ?? "unknown"}).`
    )
  }

  const readiness = await transport
    .call<{ capabilities?: string[] }>("browser_capability", { workspaceId, userEnabled: true })
    .catch(() => null)
  if (!readiness?.capabilities?.includes("browser")) {
    throw nonRetryable(
      `${kind}: the remote browser is switched off for this workspace, and no browser pane is ` +
        `open to borrow. Enable it under Settings, Companion, Remote browser.`
    )
  }

  const grants = await listGrantDomains(workspaceId)
  const summary = await transport.call<{ id: string }>("browser_session_ensure", {
    // Namespaced by run rather than by chat session: this session belongs to
    // the run and is closed with it, and it must never collide with the
    // conversation-bound one the pane owns.
    chatSessionId: `workflow:${ctx.runId}`,
    workspaceId,
    backendPreference: "remote-chromium",
    userEnabled: true,
    // The same grant set the node already enforced, so the runtime's own
    // pinned host resolver refuses independently of this process.
    domainGrants: grants,
  })

  const engine = new RemoteChromiumEngine(summary.id)
  registerRunBrowserSession(ctx.runId, { browserSessionId: summary.id, engine })
  return { engine, backend: "remote-chromium" }
}

async function listGrantDomains(workspaceId: string | undefined): Promise<string[]> {
  if (!workspaceId) return []
  try {
    const { listBrowserDomainGrants } = await import("@/lib/db/browser-profiles")
    return (await listBrowserDomainGrants(workspaceId)).map((grant) => grant.domain)
  } catch {
    return []
  }
}

/** Test-only. */
export function __resetBrowserEnginePrimingForTesting(): void {
  primedRuns.clear()
}
