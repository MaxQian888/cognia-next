/**
 * The plugin contract's share of `lib/automation/client.ts`, which re-exports these.
 */
/** Mirror of Rust `automation::events::UiaEventPayload` (serde camelCase). */
export interface UiaEventPayload {
  subscriptionId: number
  kind: string
  /** Focused element's accessible name — may carry user text; PII-gate before
   * forwarding into workflow payloads. */
  name?: string
  controlType?: string
  processId?: number
  property?: string
  structureChangeType?: string
  runtimeId?: number[]
  at: number
}

export type Surface = "workflow" | "computerUse" | "mcp" | "plugin" | "sandbox" | "chatCopilot"

export interface CallContext {
  surface?: Surface
  pluginId?: string
  /** Target process name (e.g. `"notepad.exe"`) — used for whitelist gating. */
  processName?: string
  /** Target window title — used for whitelist gating. */
  windowTitle?: string
  /**
   * ADR-0028 / T5 — best-effort URL when the target is a browser tab.
   * Lets the per-action policy's `allowedUrlPatterns` fire.
   */
  targetUrl?: string
  /** ADR-0028 / T5 — pixel x of the action's target (click / drag / move). */
  clickX?: number
  /** ADR-0028 / T5 — pixel y of the action's target. */
  clickY?: number
  /**
   * ADR-0020 W1 — per-call tier upgrade. Carried over the wire as
   * `forceTier`; deserialized into `automation::commands::CallContext.force_tier`
   * on the Rust side. Today only `"perCall"` has a real effect: the
   * `command_body!` macro upgrades a gate `Allow` into `RequireConsent`
   * for driving calls so the floating overlay fires. Populated by the
   * computer-use plugin's `execute()` callback from the active
   * character's `requireConsent: true` setting (see
   * `lib/claude/computer-use-active-settings.ts`).
   */
  forceTier?: "off" | "whitelist" | "perCall"
  /**
   * Screen-off mode opt-in for this call. Stamped by the computer-use plugin
   * from the active character's `computerUseSettings.screenOffMode`. When
   * true, the Rust plugin command ensures the bundled virtual display is
   * active + primary before dispatching the action so capture stays
   * non-black with the physical monitor off. Deserialized into
   * `automation::commands::CallContext.screen_off_mode`.
   */
  screenOffMode?: boolean
  /**
   * ADR-0020 remote-target — when set, the action runs against the cua
   * desktop sandbox with this connection id instead of the local host.
   * Empty / absent = local. Deserialized into
   * `automation::commands::CallContext.sandbox_connection_id`; the Rust
   * `cua_route` layer dispatches to the `CuaRemoteClient` keyed by this id.
   * Populated by the computer-use plugin from the immutable
   * `SandboxRuntimeRef` resolved before the prompt is sent.
   */
  sandboxConnectionId?: string
  /**
   * ADR-0028 — when set, the native `bash` / `text_editor` Computer Use tools
   * run OS-sandboxed / path-confined instead of unconfined. Deserialized into
   * `CallContext.sandbox_confine`. Populated by the computer-use plugin from
   * the immutable `SandboxRuntimeRef` resolved before the prompt is sent.
   */
  sandboxConfine?: {
    writable?: string[]
    readable?: string[]
    network?: "off" | "on" | "allowlist"
    networkHosts?: string[]
  }
  /**
   * Originating chat session. The Rust gate stores it in
   * `GateContext.session_key` and
   * from there in the consent prompt, so a time-boxed "don't ask again"
   * grant is scoped to one conversation instead of the whole app session.
   */
  sessionKey?: string
  /** Authenticated model message or workflow-step id for revision tokens. */
  turnKey?: string
}
