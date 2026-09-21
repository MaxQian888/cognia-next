/**
 * The route host a headless Router + Fusion entry point routes against
 * (ADR-0188 B3).
 *
 * `POST /v1/runs`, the companion lane and the live smoke all route the same
 * way: the user's own providers, through the app's routing engine, with the
 * settings snapshot standing in for the settings store no headless brain
 * loads. That construction lived twice — once in `run-api-host.ts` and once in
 * `live/live-smoke-runner.ts` — and two copies of a routing host is two sets of
 * capabilities a run can be assessed against. It lives here once instead.
 *
 * Chat is deliberately not a caller: its send path builds a host with
 * `surface: "chat"` and the live settings store, because a chat turn is routed
 * inside the window that owns those settings.
 */

import type { AppSettings } from "@cognia/agent-config-types"
import { createMappingRegistry, ProviderRoutingEngine } from "@cognia/provider-routing"
import { buildRoutingEngineDeps } from "@cognia/provider-routing/build-preview-engine"
import { DEFAULT_ROUTING_CONFIG } from "@cognia/provider-types/model-mapping"

import { liveSettingsReader } from "../calls/live-settings"
import { createChatRouteHost } from "../chat/chat-route-host"
import type { ChatRouteHost } from "../chat/route-chat-turn"

/**
 * Build the Run API's route host from one settings snapshot.
 *
 * The snapshot is also what the host's live check reads (`currentSettings`): a
 * headless brain has no settings store to ask, so the reservations of a run it
 * drives are checked against the settings the run was accepted with.
 */
export function createRunApiRouteHost(appSettings: AppSettings): ChatRouteHost {
  const engineDeps = buildRoutingEngineDeps(appSettings)
  return {
    ...createChatRouteHost({
      appSettings,
      engine: new ProviderRoutingEngine(
        createMappingRegistry(appSettings.modelMappings ?? []),
        appSettings.routingConfig ?? DEFAULT_ROUTING_CONFIG,
        engineDeps
      ),
      engineDeps,
    }),
    currentSettings: liveSettingsReader(appSettings),
  }
}
