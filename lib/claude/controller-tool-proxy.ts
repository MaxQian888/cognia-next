/**
 * May this renderer execute a tool the host asked it to run?
 *
 * The sidecar hands renderer-owned tools back to a client and waits: plugin
 * tools, the artifact and canvas surface, `web_fetch`, `ask_user`,
 * `dispatch_agent`, tool-result review, code-level protocol adapters. A frame
 * carrying a `remoteExecutionContext` reaches exactly one device, because
 * `EventBus::publish` stamps `target_device_id` from the context's
 * `originDeviceId` and `EventFrame::visible_to` drops it for everyone else. So
 * by the time a client is holding one of these, the host has already decided
 * who should answer.
 *
 * That leaves one genuine question, and it is not "am I allowed". It is the
 * ADR-0082 compatibility question: when THIS renderer is driving some OTHER
 * host, does that host actually support having its tools proxied here? An older
 * host would take the answer and do nothing with it.
 *
 * The gate used to ask that question unconditionally, which is a different
 * question from the one the caller has. A browser paired to a headless host is
 * not driving another host, it IS the host's client, and the remote-host store
 * the check reads is empty for it. Combined with the feature never having been
 * advertised by any platform, the check answered false in every configuration
 * and the provider refused every renderer-proxied tool call it was handed. That
 * is a turn that hangs: `ask_user` and `dispatch_agent` wait forever, the rest
 * for the sidecar's two-minute timeout.
 */

import { isRemoteHostActive } from "@/lib/tauri/transport-routing"
import { activeHostSupportsFeature } from "@/stores/remote-host/remote-host-store"

/** The round-trips a host advertises under `claude.controller-tool-proxy`. */
export type ControllerToolProxyOperation =
  "plugin_tool_exec" | "tool_result_review" | "protocol_adapter_exec"

export interface ControllerToolProxyDeps {
  /** Is this renderer driving a different host (ADR-0082)? */
  drivingRemoteHost?: () => boolean
  /** Does that host advertise this round-trip? */
  remoteHostAdvertises?: (operation: ControllerToolProxyOperation) => boolean
}

/**
 * `true` when the renderer should run the tool and answer.
 *
 * Called only for frames that carry a remote execution context. A frame without
 * one is this shell's own sidecar talking to itself and never reaches here.
 */
export function canProxyRemoteToolCall(
  operation: ControllerToolProxyOperation,
  deps: ControllerToolProxyDeps = {}
): boolean {
  const drivingRemoteHost = deps.drivingRemoteHost ?? isRemoteHostActive
  if (!drivingRemoteHost()) {
    // Not driving anyone: the host that asked is the host this client belongs
    // to, and it addressed the frame to this device. Answering is the whole
    // contract.
    return true
  }
  const advertises =
    deps.remoteHostAdvertises ??
    ((op: ControllerToolProxyOperation) =>
      activeHostSupportsFeature("claude.controller-tool-proxy", op))
  return advertises(operation)
}
