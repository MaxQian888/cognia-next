/**
 * Renderer-facing client for the desktop automation Tauri command surface.
 *
 * Every call delegates to `transport.call(...)` so the same module works in:
 *   - Tauri desktop (the only place automation actually runs)
 *   - Capacitor mobile (companion HTTP — server-side mirrors the same names)
 *   - Plain web (`WebStubTransport` rejects with UNSUPPORTED_PLATFORM)
 *
 * The `CallContext` argument tags every call with the consumer surface, the
 * plugin id (for plugin-surface calls), and target metadata used by the Rust
 * permission gate. Untagged calls default to `surface: "workflow"` on the
 * Rust side.
 */

import { transport } from "@/lib/tauri"

import type {
  ButtonTransition,
  Capabilities,
  ClickOpts,
  ClickTarget,
  DragOpts,
  ElementInfo,
  ElementRef,
  EventFilter,
  KeyChord,
  Locator,
  MouseButton,
  PatternKind,
  Point,
  Screenshot,
  ScreenshotOpts,
  ScrollOpts,
  ScrollTarget,
  TreeOpts,
  TypeOpts,
  WindowOp,
} from "./types"

/** Tauri event name carrying live UI events from the Rust watcher threads. */
export const UIA_EVENT_NAME = "automation:uia-event"

/** Mirror of Rust `automation::events::UiaEventPayload` (serde camelCase). */
export interface UiaEventPayload {
  subscriptionId: number
  kind: string
  /** Focused element's accessible name — may carry user text; PII-gate before
   * forwarding into workflow payloads. */
  name?: string
  controlType?: string
  processId?: number
  at: number
}

/**
 * Listen for live UI events. Returns the unlisten fn. Kept out of the
 * `desktop` transport object because event listening is Tauri-only (the
 * companion HTTP transport has no event channel).
 */
export async function listenUiaEvents(
  handler: (payload: UiaEventPayload) => void
): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event")
  return listen<UiaEventPayload>(UIA_EVENT_NAME, (event) => handler(event.payload))
}

export type Surface = "workflow" | "computerUse" | "mcp" | "plugin" | "sandbox"

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
   * Populated by the computer-use plugin's `execute()` callback from the
   * per-session resolved `computerUseTarget` (see
   * `lib/claude/computer-use-target-state.ts`).
   */
  sandboxConnectionId?: string
  /**
   * ADR-0028 — when set, the native `bash` / `text_editor` Computer Use tools
   * run OS-sandboxed / path-confined instead of unconfined. Deserialized into
   * `CallContext.sandbox_confine`. Populated by the computer-use plugin's
   * `execute()` callback when the session has the sandbox enabled (see
   * `lib/claude/sandbox-confine-state.ts`).
   */
  sandboxConfine?: {
    writable?: string[]
    readable?: string[]
    network?: "off" | "on" | "allowlist"
    networkHosts?: string[]
  }
  /**
   * Renderer-only session tag for per-session action-mapper state
   * (coordinate scaling, screenshot dedup, consecutive-failure counters —
   * see `lib/automation/anthropic-action-mapper.ts`). Serialized over the
   * wire but ignored by the Rust side (serde tolerates unknown fields).
   * Stamped by the computer-use plugin from the active chat session id.
   */
  sessionKey?: string
}

/**
 * Health snapshot for the screen-off virtual display. Mirrors Rust
 * `automation::virtual_display::VirtualDisplayHealth` (serde camelCase).
 */
export interface VirtualDisplayHealth {
  available: boolean
  installed: boolean
  backend: string
  driverVersion: string
  activeMonitor: string
  lastError: string
}

/** Result of the settings "Test screen-off capture" probe. */
export interface VirtualDisplayProbeResult {
  width: number
  height: number
  nonBlack: boolean
  monitor: string
}

/** Outcome of arming the virtual display before a screen-off action. */
export interface VirtualDisplayArmResult {
  status: "acquired" | "alreadyActive" | "unavailable"
  monitor: string
  error: string
}

export const desktop = {
  capabilities(): Promise<Capabilities> {
    return transport.call<Capabilities>("desktop_capabilities", {})
  },

  getFocus(ctx?: CallContext): Promise<ElementInfo> {
    return transport.call<ElementInfo>("desktop_get_focus", { ctx })
  },

  readTree(
    root: ElementRef | null,
    opts: TreeOpts = {},
    ctx: CallContext = {}
  ): Promise<ElementInfo[]> {
    return transport.call<ElementInfo[]>("desktop_read_tree", {
      args: { root, opts, ctx },
    })
  },

  find(locator: Locator, ctx: CallContext = {}): Promise<ElementRef | null> {
    return transport.call<ElementRef | null>("desktop_find", {
      args: { locator, ctx },
    })
  },

  screenshot(opts: ScreenshotOpts = {}, ctx: CallContext = {}): Promise<Screenshot> {
    return transport.call<Screenshot>("desktop_screenshot", {
      args: { opts, ctx },
    })
  },

  click(target: ClickTarget, opts: ClickOpts = {}, ctx: CallContext = {}): Promise<void> {
    return transport.call<void>("desktop_click", {
      args: { target, opts, ctx },
    })
  },

  type(text: string, opts: TypeOpts = {}, ctx: CallContext = {}): Promise<void> {
    return transport.call<void>("desktop_type", {
      args: { text, opts, ctx },
    })
  },

  /**
   * Clipboard-paste fast path: Rust saves the current clipboard, writes
   * `text`, sends Ctrl/Cmd+V, then restores the clipboard. Gated +
   * audited as a driving call ("paste"). Prefer over `type` for long or
   * sensitive text — keystrokes never hit per-key hooks. (Plain `type`
   * also upgrades to this path automatically past the configurable
   * `pasteThresholdChars` setting.)
   */
  paste(text: string, ctx: CallContext = {}): Promise<void> {
    return transport.call<void>("desktop_paste", { args: { text, ctx } })
  },

  /**
   * Launch an application (executable path or app name) or focus an
   * existing window by process name. Driving call ("launch_app") — gated
   * + audited.
   */
  launchApp(app: string, action: "launch" | "focus", ctx: CallContext = {}): Promise<void> {
    return transport.call<void>("desktop_launch_app", { args: { app, action, ctx } })
  },

  keys(chord: KeyChord, ctx: CallContext = {}): Promise<void> {
    return transport.call<void>("desktop_keys", {
      args: { chord, ctx },
    })
  },

  invokePattern(
    target: ElementRef,
    pattern: PatternKind,
    patternArgs: unknown = {},
    ctx: CallContext = {}
  ): Promise<unknown> {
    return transport.call<unknown>("desktop_invoke_pattern", {
      args: { target, pattern, args: patternArgs, ctx },
    })
  },

  // ── M5 completion: direct primitives that match Anthropic computer_20251124 ──

  mouseMove(point: Point, ctx: CallContext = {}): Promise<void> {
    return transport.call<void>("desktop_mouse_move", { args: { point, ctx } })
  },

  drag(from: Point, to: Point, opts: DragOpts = {}, ctx: CallContext = {}): Promise<void> {
    return transport.call<void>("desktop_drag", {
      args: { from, to, opts, ctx },
    })
  },

  scroll(target: ScrollTarget, opts: ScrollOpts = {}, ctx: CallContext = {}): Promise<void> {
    return transport.call<void>("desktop_scroll", {
      args: { target, opts, ctx },
    })
  },

  holdKey(chord: KeyChord, durationMs: number, ctx: CallContext = {}): Promise<void> {
    return transport.call<void>("desktop_hold_key", {
      args: { chord, durationMs, ctx },
    })
  },

  mouseButton(
    button: MouseButton,
    transition: ButtonTransition,
    ctx: CallContext = {}
  ): Promise<void> {
    return transport.call<void>("desktop_mouse_button", {
      args: { button, transition, ctx },
    })
  },

  /**
   * Direct WindowOp dispatch — replaces the workflow executor's previous
   * `invokePattern("window", { op: "focus" })` hack. The backend uses
   * `UIWindowPattern.set_window_visual_state` for minimize/maximize/restore
   * and `UITransformPattern` for resize; focus/close use UIElement.set_focus
   * + Alt+F4.
   */
  windowOp(target: ElementRef, op: WindowOp, ctx: CallContext = {}): Promise<void> {
    return transport.call<void>("desktop_window_op", {
      args: { target, op, ctx },
    })
  },

  /**
   * Read the current cursor position in screen coordinates. Read-only call —
   * does not trigger a consent prompt regardless of tier.
   */
  cursorPosition(ctx?: CallContext): Promise<Point> {
    return transport.call<Point>("desktop_cursor_position", { ctx })
  },

  /**
   * Subscribe to live UI events (v1: `focus-changed` on Windows). Read-only
   * observing call. Events arrive on the `automation:uia-event` Tauri event
   * (see {@link UIA_EVENT_NAME} / {@link UiaEventPayload}); the returned
   * subscription id pairs with {@link desktop.unsubscribeEvents}.
   */
  subscribeEvents(filter: EventFilter = {}, ctx: CallContext = {}): Promise<number> {
    return transport.call<number>("desktop_subscribe_events", { filter, ctx })
  },

  /** Stop a live UI-event subscription started by {@link desktop.subscribeEvents}. */
  unsubscribeEvents(sub: number, ctx: CallContext = {}): Promise<void> {
    return transport.call<void>("desktop_unsubscribe", { sub, ctx })
  },

  /**
   * Resolve the topmost UI element at the given screen coordinates.
   * Read-only — used by Inspector's "Pick" affordance after the overlay
   * captures the user's intended target.
   */
  pickAtPoint(point: Point, ctx: CallContext = {}): Promise<ElementInfo> {
    return transport.call<ElementInfo>("desktop_pick_at_point", {
      args: { point, ctx },
    })
  },

  /**
   * ADR-0020 W1 — start a pick session. Records an audit row so the
   * operator can see "user initiated pick at <ts>" alongside the
   * resulting `pick_at_point` call that follows when the cursor lands
   * on the target. The renderer-side affordance uses this in place of
   * the prior bare 3-second countdown so audit captures the pick
   * lifecycle. macOS / Linux land at the same audit row but the
   * follow-up `pickAtPoint` returns UnsupportedPlatform until Wave 2.
   */
  pickSessionStart(ctx: CallContext = {}): Promise<void> {
    return transport.call<void>("desktop_pick_session_start", { args: { ctx } })
  },

  /**
   * ADR-0020 W1 — companion of `pickSessionStart`. Records an audit row
   * tagging the session as cancelled. Safe to call without a matching
   * `start` — the audit row stands on its own.
   */
  pickSessionCancel(ctx: CallContext = {}): Promise<void> {
    return transport.call<void>("desktop_pick_session_cancel", { args: { ctx } })
  },

  /**
   * Reply to a consent-request event raised by `automation:consent-request`.
   * `persist == true` means "always allow this kind of call for the rest of
   * the session". The `prompt` field MUST match the one received in the
   * event payload so the broker can register the session grant against the
   * same tuple.
   */
  consentRespond(args: {
    id: string
    allow: boolean
    persist?: boolean
    prompt?: ConsentPromptPayload
  }): Promise<void> {
    return transport.call<void>("automation_consent_respond", { args })
  },

  /** Snapshot the current in-memory audit ring (capped at 5000). */
  auditSnapshot(): Promise<AuditEntry[]> {
    return transport.call<AuditEntry[]>("automation_audit_snapshot", {})
  },

  /** Read the persisted permission settings. */
  settingsGet(): Promise<AutomationSettings> {
    return transport.call<AutomationSettings>("automation_settings_get", {})
  },

  /** Replace the permission settings. Never resumes an engaged kill switch. */
  settingsSet(settings: AutomationSettings): Promise<void> {
    return transport.call<void>("automation_settings_set", { settings })
  },

  /**
   * Explicit operator toggle of the master enable flag. Enabling is the
   * deliberate "resume" action that releases an engaged kill switch — unlike a
   * bulk `settingsSet`, which never does.
   */
  setEnabled(enabled: boolean): Promise<void> {
    return transport.call<void>("automation_set_enabled", { enabled })
  },

  /** Whether the runtime emergency kill switch is currently engaged. */
  killSwitchEngaged(): Promise<boolean> {
    return transport.call<boolean>("automation_kill_switch_engaged", {})
  },

  /** Engage the global kill switch — every in-flight call rejects with KILL_SWITCH_ACTIVE. */
  killSwitch(): Promise<void> {
    return transport.call<void>("automation_kill_switch", {})
  },

  /**
   * Screen-off (virtual display) — read-only health snapshot for the Settings
   * card status badge. Cheap; safe to poll.
   */
  virtualDisplayHealthProbe(): Promise<VirtualDisplayHealth> {
    return transport.call<VirtualDisplayHealth>("virtual_display_health_probe", {})
  },

  /** Trigger the UAC-elevated bundled virtual-display driver install. */
  virtualDisplaySetup(): Promise<void> {
    return transport.call<void>("virtual_display_setup", {})
  },

  /**
   * One-shot capture probe through the virtual display ("Test screen-off
   * capture" button): acquires, screenshots, checks non-black, releases.
   * Returns a summary — not the image bytes.
   */
  virtualDisplayProbe(): Promise<VirtualDisplayProbeResult> {
    return transport.call<VirtualDisplayProbeResult>("virtual_display_probe", {})
  },

  /**
   * Release the virtual display for a closed chat session (the EXIT signal
   * piggybacked on the session-close path). No-op when nothing is active.
   */
  virtualDisplayRelease(sessionId?: string): Promise<void> {
    return transport.call<void>("virtual_display_release", { args: { sessionId } })
  },

  /**
   * ENTER hook for the live chat path: ensure the virtual display is active +
   * primary before a screen-off computer action. Idempotent (re-arms the idle
   * timer when already active). `status: "unavailable"` means the driver is
   * missing — the caller fails strictly instead of capturing a black frame.
   */
  virtualDisplayArm(): Promise<VirtualDisplayArmResult> {
    return transport.call<VirtualDisplayArmResult>("virtual_display_arm", {})
  },
}

// --- Types mirrored from `src-tauri/src/automation/{audit,permission}.rs` ---
// Defined here rather than in types.ts because they're consumer-side only
// (Tauri command return shapes, not part of the core element/locator model).

/**
 * Payload of the `automation:consent-request` Tauri event. The renderer-side
 * overlay receives this and renders a Allow once / Always allow / Reject
 * floating card. The same `prompt` body must be echoed back to
 * `desktop.consentRespond` so the broker can register a session grant.
 */
export interface ConsentPromptPayload {
  command: string
  surface: Surface
  pluginId: string | null
  processName: string | null
  windowTitle: string | null
  /**
   * What the call will actually do — the shell command for `bash`, a
   * `create <path>` summary for `text_editor`. Present only for shell-class
   * actions; lets the overlay show the operator the real command instead of a
   * bare verb. Absent (`null`/`undefined`) for self-describing actions.
   */
  commandDetail?: string | null
}

/**
 * Full event payload — includes the broker id the renderer must pass back
 * to `desktop.consentRespond`, plus the timeout the broker honors.
 */
export interface ConsentRequestEvent extends ConsentPromptPayload {
  id: string
  timeoutMs: number
}

export type AuditDecision = "allow" | "deny" | "consent"

export interface AuditEntry {
  id: string
  ts: number
  surface: Surface
  pluginId: string | null
  command: string
  processName: string | null
  windowTitle: string | null
  decision: AuditDecision
  reason: string | null
  durationMs: number
  error: string | null
}

export type Tier = "off" | "whitelist" | "perCall"

export interface Whitelist {
  processNames: string[]
  windowTitlePatterns: string[]
}

export interface SurfacePolicy {
  tier: Tier
  whitelist?: Whitelist
}

export interface PluginSurfacePolicy extends SurfacePolicy {
  perPluginOverrides: Record<string, SurfacePolicy>
}

export interface PerSurfacePolicies {
  workflow: SurfacePolicy
  computerUse: SurfacePolicy
  mcp: SurfacePolicy
  plugin: PluginSurfacePolicy
}

export interface AuditSettings {
  retentionDays: number
  exportEnabled: boolean
}

/**
 * Screenshot down-scaling applied Rust-side before frames reach vision
 * models. Disabled by default; 1280×800 (WXGA) is the Anthropic-recommended
 * sweet spot for computer-use click accuracy vs token cost.
 */
export interface ScreenshotScalingSettings {
  enabled: boolean
  maxWidth: number
  maxHeight: number
}

export interface AutomationSettings {
  enabled: boolean
  defaultTier: Tier
  whitelist: Whitelist
  perSurface: PerSurfacePolicies
  audit: AuditSettings
  redactScreenshots: boolean
  screenshotScaling: ScreenshotScalingSettings
  /**
   * The action mapper returns "screen unchanged" text instead of a
   * duplicate image when consecutive screenshots hash identically.
   * Default ON.
   */
  screenshotDedup: boolean
  /**
   * `type` calls longer than this many chars transparently use the
   * clipboard-paste fast path. 0 disables. Default 200.
   */
  pasteThresholdChars: number
}

export function defaultAutomationSettings(): AutomationSettings {
  return {
    enabled: false,
    defaultTier: "off",
    whitelist: { processNames: [], windowTitlePatterns: [] },
    perSurface: {
      workflow: { tier: "off" },
      computerUse: { tier: "off" },
      mcp: { tier: "off" },
      plugin: { tier: "off", perPluginOverrides: {} },
    },
    audit: { retentionDays: 30, exportEnabled: true },
    redactScreenshots: false,
    screenshotScaling: { enabled: false, maxWidth: 1280, maxHeight: 800 },
    screenshotDedup: true,
    pasteThresholdChars: 200,
  }
}
