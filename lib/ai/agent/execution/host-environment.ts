/**
 * The execution environment a caller hands to `resolveAgentExecutionSpec` /
 * `executeAgentTurn`, derived from the HOST PROFILE rather than from the
 * webview kind.
 *
 * Why this exists (ADR-0090, sections 1 and 7): "is there a host that can run
 * the agent rail" used to be answered by `isTauri()` at four call sites, each
 * of which also hard-coded `isHeadlessHost: false`. That answer is wrong in two
 * of the five shells the same code runs in.
 *
 * - On the headless brain (`cognia-agent serve`) there is no Tauri marker, so
 *   Squads and teammates resolved to the web renderer and degraded to a
 *   tool-less completion, on the one host whose policy forbids that.
 * - On a paired phone or browser the companion transport delivers `agent_send`
 *   to the host's sidecar, so the agent rail IS available. It merely runs
 *   remotely. Resolving to `web-renderer` there ran `dispatch_agent` children
 *   and workflow agent turns as tool-less completions inside the webview.
 *
 * `detectHostProfile()` already knows all five shapes. This module is the only
 * place that maps a profile onto the resolver's environment, so every caller
 * gives the resolver the same truth.
 */

import { detectHostProfile, type HostProfile } from "@/lib/platform/capabilities"
import type { AgentExecutionEnvironment } from "./resolve-agent-execution-spec"

/** Map one host profile onto the resolver environment. Pure. */
export function agentExecutionEnvironmentForProfile(
  profile: HostProfile
): AgentExecutionEnvironment {
  switch (profile) {
    case "desktop":
      return { isTauri: true, isHeadlessHost: false, hostProfile: profile }
    case "headless":
      return { isTauri: false, isHeadlessHost: true, hostProfile: profile }
    case "mobile-companion":
    case "cloud-companion":
      // The host's sidecar is reachable through the companion transport:
      // `agent_send` is an `execution`-target command on HTTP/WS/WebRTC and
      // `claude://message` is a default-on channel. Whether the link is UP is
      // a transport question answered when the send is made, never re-probed
      // here (the resolver freezes host truth, it does not poll it).
      return { isTauri: false, isHeadlessHost: false, pairedHost: true, hostProfile: profile }
    case "web-standalone":
      return { isTauri: false, isHeadlessHost: false, hostProfile: profile }
  }
}

/**
 * The environment for THIS process. The only sanctioned way for a caller to
 * build one without already holding a profile.
 */
export function resolveAgentExecutionEnvironment(): AgentExecutionEnvironment {
  return agentExecutionEnvironmentForProfile(detectHostProfile())
}

/**
 * Does this environment have a host that can run the agent rail? The single
 * predicate behind the service's rail choice, the resolver's channel
 * projection, and the teammate dispatcher's channel pick.
 */
export function agentHostAvailable(environment: AgentExecutionEnvironment): boolean {
  return (
    environment.isTauri === true ||
    environment.isHeadlessHost === true ||
    environment.pairedHost === true
  )
}
