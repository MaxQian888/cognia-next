// Host-side arms for glance on a paired phone (ADR-0225 §7, §9).
//
// A phone's `glance_*` calls reach the companion server, ride the generic
// desktop-writes bridge (`crates/cognia-companion-rpc/src/rpc/data_sync.rs`) to
// this renderer, and are delegated here by `lib/companion/desktop-write-source.ts`,
// the way the `pet_*` and `files_library_*` families are.
//
// Nothing here builds a snapshot or runs a refresh itself. `glance_subscribe`
// records the phone's lease and demand on the hub and answers the newest
// snapshot the publisher built; the requests run through the executor the
// publisher installed, which is the same code the desktop tray panel's
// requests use. With no publisher mounted (the main window is still booting
// or reloading) the arms answer `glance_unavailable` and the phone retries on
// its next renewal.
//
// Two hosts install the desktop-write source, and the bridge prefers a
// connected headless brain. The brain has no main window, so no publisher:
// every arm answers `headless_host` there.

import type { Platform } from "@/lib/platform/detect"
import { detectPlatform } from "@/lib/platform/detect"

import { GLANCE_REMOTE_COMMANDS, isGlanceRemoteCommand } from "./commands"
import { glanceRemoteHub, type GlanceRemoteHub } from "./host-hub"
import {
  glanceRefused,
  parseGlanceQuotaEnablePayload,
  parseGlanceRemoteRequestPayload,
  parseGlanceSubscribePayload,
  type GlanceRemoteResult,
  type GlanceSubscribeResponse,
} from "./types"

export interface GlanceHostDispatchDeps {
  platform?: Platform
  hub?: GlanceRemoteHub
  now?: () => number
}

function resultOf(errorKey: string | null): GlanceRemoteResult {
  return errorKey === null ? { ok: true } : glanceRefused(errorKey)
}

export async function dispatchGlanceHostCommand(
  command: string,
  payload: Record<string, unknown>,
  deps: GlanceHostDispatchDeps = {}
): Promise<GlanceSubscribeResponse | GlanceRemoteResult> {
  if (!isGlanceRemoteCommand(command)) throw new Error(`unsupported glance command: ${command}`)
  if ((deps.platform ?? detectPlatform()) !== "tauri") return glanceRefused("headless_host")
  const hub = deps.hub ?? glanceRemoteHub
  const now = (deps.now ?? Date.now)()

  switch (command) {
    case GLANCE_REMOTE_COMMANDS.subscribe: {
      const request = parseGlanceSubscribePayload(payload)
      // The companion server injects the verified device id (it overwrites
      // anything the phone sent). The lease is keyed on it, so one device can
      // neither renew nor end another's lease by guessing its consumer id.
      const deviceId = payload.callerDeviceId
      if (!request || typeof deviceId !== "string" || deviceId.length === 0) {
        return glanceRefused("glance_invalid_request")
      }
      const lease = { ...request, consumer: `${deviceId}:${request.consumer}` }
      // Ending a lease always works, publisher or not.
      if (!request.visible) {
        hub.announce(lease, now)
        return { ok: true, snapshot: null, ttlMs: hub.leaseTtlMs }
      }
      // No publisher, no lease: a lease nobody builds for would only make the
      // phone wait for a push that never comes.
      if (!hub.getExecutor()) return glanceRefused("glance_unavailable")
      hub.announce(lease, now)
      return {
        ok: true,
        snapshot: hub.getLatest(now),
        ttlMs: hub.leaseTtlMs,
      }
    }
    case GLANCE_REMOTE_COMMANDS.request: {
      const request = parseGlanceRemoteRequestPayload(payload)
      if (!request) return glanceRefused("glance_invalid_request")
      const executor = hub.getExecutor()
      if (!executor) return glanceRefused("glance_unavailable")
      try {
        return resultOf(
          request.kind === "refresh"
            ? await executor.refresh()
            : await executor.quotaRefresh(request.key)
        )
      } catch {
        return glanceRefused("errors.requestFailed")
      }
    }
    case GLANCE_REMOTE_COMMANDS.quotaEnable: {
      const request = parseGlanceQuotaEnablePayload(payload)
      if (!request) return glanceRefused("glance_invalid_request")
      const executor = hub.getExecutor()
      if (!executor) return glanceRefused("glance_unavailable")
      try {
        return resultOf(await executor.quotaEnable(request.provider, request.accountId))
      } catch {
        return glanceRefused("errors.requestFailed")
      }
    }
  }
}
