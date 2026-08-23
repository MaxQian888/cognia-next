/**
 * The protocols a user may PICK, and what to do with one they already have.
 *
 * Two dialogs offered protocol dropdowns, and each hand-listed its own set.
 * Both were wrong in the same direction: they offered `http`, `websocket` and
 * `custom` — labelled "coming soon" — while `protocolAdapterRegistry.register("http", …)`
 * has been commented out in the manager since the module was written. Nothing
 * has ever been able to speak them, so picking one produced an agent that
 * failed at connect with "no adapter for protocol". Meanwhile the same lists
 * omitted `codex-app-server`, `pi-rpc` and `dsh-sdk`, which do have adapters.
 *
 * So the options are DERIVED from the registered set (ADR-0090 external SSOT),
 * and a stored legacy value is surfaced as a disabled, explicitly-legacy entry
 * rather than dropped — a controlled `<Select>` whose value is not among its
 * items silently clears, which would rewrite the user's config on open.
 */

import {
  BUILTIN_EXECUTABLE_EXTERNAL_AGENT_PROTOCOLS,
  type BuiltinExecutableExternalAgentProtocol,
} from "@cognia/agent-config-types/external-agent-capability"
import { listPluginProtocolAdapters } from "./protocol-adapter"

/**
 * Protocol names are brand/technical identifiers (i18n-exempt, matching the
 * existing dialogs). Only the LEGACY explanation is translated, because that
 * one is a sentence about why the option cannot be chosen.
 */
const PROTOCOL_LABELS: Record<BuiltinExecutableExternalAgentProtocol, string> = {
  acp: "ACP (Agent Client Protocol)",
  "codex-app-server": "Codex app-server (JSON-RPC)",
  "dsh-sdk": "DeepSeek Harness SDK",
  "pi-rpc": "Pi native RPC",
  opencode: "OpenCode (HTTP + SSE)",
  "opencode-v2": "OpenCode V2 (Preview)",
  a2a: "A2A (Agent-to-Agent)",
}

const DOCUMENTED_ONLY_PROTOCOLS = new Set<BuiltinExecutableExternalAgentProtocol>(["opencode-v2"])

export interface ExternalProtocolOption {
  value: string
  /** Brand/technical name. Never translated. */
  label: string
  /** False for a legacy value kept only so the form does not rewrite it. */
  selectable: boolean
  /**
   * Why it cannot be chosen — an i18n key suffix under
   * `externalAgent.manager`, not a sentence.
   */
  reasonKey?: "legacyProtocolUnavailable" | "pluginProtocolContributed"
}

/**
 * Options for a protocol `<Select>`.
 *
 * The built-ins, plus every protocol a plugin has ACTUALLY registered right
 * now — `listPluginProtocolAdapters()`, not a hand-kept list. A plugin that
 * contributes an adapter has to be reachable from the picker, or the only way
 * to use it is to hand-edit a stored config; listing a contributed protocol
 * solely when the form already held it made that the only way in.
 *
 * `current` is the value the form already holds. A plugin protocol that is no
 * longer registered, and a legacy one, are listed as DISABLED so the user can
 * see what the stored config says and change it, but cannot re-choose it.
 */
export function externalProtocolOptions(current?: string): ExternalProtocolOption[] {
  const options: ExternalProtocolOption[] = BUILTIN_EXECUTABLE_EXTERNAL_AGENT_PROTOCOLS.filter(
    (value) => !DOCUMENTED_ONLY_PROTOCOLS.has(value)
  ).map((value) => ({ value, label: PROTOCOL_LABELS[value], selectable: true }))
  for (const { protocol } of listPluginProtocolAdapters()) {
    if (options.some((option) => option.value === protocol)) continue
    options.push({
      value: protocol,
      label: protocol,
      selectable: true,
      reasonKey: "pluginProtocolContributed",
    })
  }

  if (!current) return options
  if (options.some((option) => option.value === current)) return options

  // Everything that reaches here is unselectable for the same reason and gets
  // the same row: a legacy `http`/`websocket`/`custom` value, a plugin protocol
  // whose plugin is disabled or gone, or a hand-edited id. Shown so the stored
  // value survives the dialog opening, refused so it cannot be re-picked.
  return [
    {
      value: current,
      label: PROTOCOL_LABELS[current as BuiltinExecutableExternalAgentProtocol] ?? current,
      selectable: false,
      reasonKey: "legacyProtocolUnavailable",
    },
    ...options,
  ]
}
