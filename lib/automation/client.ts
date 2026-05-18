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

export type Surface = "workflow" | "computerUse" | "mcp" | "plugin"

export interface CallContext {
  surface?: Surface
  pluginId?: string
  /** Target process name (e.g. `"notepad.exe"`) — used for whitelist gating. */
  processName?: string
  /** Target window title — used for whitelist gating. */
  windowTitle?: string
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

  /** Replace the permission settings. */
  settingsSet(settings: AutomationSettings): Promise<void> {
    return transport.call<void>("automation_settings_set", { settings })
  },

  /** Engage the global kill switch — every in-flight call rejects with KILL_SWITCH_ACTIVE. */
  killSwitch(): Promise<void> {
    return transport.call<void>("automation_kill_switch", {})
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

export interface AutomationSettings {
  enabled: boolean
  defaultTier: Tier
  whitelist: Whitelist
  perSurface: PerSurfacePolicies
  audit: AuditSettings
  redactScreenshots: boolean
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
  }
}
