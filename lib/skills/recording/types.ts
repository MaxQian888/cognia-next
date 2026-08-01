/**
 * TypeScript mirror of `crates/cognia-automation/src/automation/record/`.
 *
 * **Source of truth lives on the Rust side.** Field names are camelCase to match
 * the serde `rename_all = "camelCase"` (+ `rename_all_fields`) attributes on the
 * Rust structs/enums. If you change a field here, change it there too.
 *
 * Two things to notice about the shapes below, because both are load-bearing:
 *
 * - **A step carries an `assetId`, never image bytes.** Screenshots live in the
 *   native bundle and are fetched on demand through `readAsset`. A 400-step
 *   recording is hundreds of MB of frames; putting them on the wire — let alone
 *   in a zustand snapshot — is not a size problem so much as a "the renderer now
 *   owns every pixel of your screen" problem.
 * - **A step carries a `SafeElement`, not the automation `ElementInfo`.** No live
 *   backend handle, no unbounded child subtree, no pid.
 */

import type { MonitorInfo, Point, Rect } from "@/lib/automation/types"

/** Opaque screenshot handle. Canonical UUID; never a path or a filename. */
export type AssetId = string
/** Opaque recording handle. Canonical UUID; it names the bundle directory. */
export type RecordingId = string

export type StepKind = "click" | "type" | "scroll" | "outOfScope"

/**
 * What was typed, and whether we are allowed to say.
 *
 * `sensitive` deliberately carries nothing — not the characters, not the length.
 * A length alone is enough to narrow a password.
 */
export type TextCapture =
  { kind: "text"; value: string } | { kind: "sensitive" } | { kind: "keys"; chord: string }

/** The accessibility facts a step is allowed to carry. */
export interface SafeElement {
  name?: string
  controlType?: string
  automationId?: string
  appName?: string
  windowTitle?: string
  bounds?: Rect
}

export interface AssetMeta {
  width: number
  height: number
  byteLen: number
  format: "Png" | "Jpeg"
  capturedAt: number
}

export interface RecordedStep {
  seq: number
  tsMs: number
  kind: StepKind
  point?: Point
  element?: SafeElement
  assetId?: AssetId
  assetMeta?: AssetMeta
  text?: TextCapture
  scrollDy?: number
  /** Local-OCR text read around the interaction when accessibility gave nothing. */
  ocrHint?: string
}

/** The recording's field of view. */
export type CaptureScope =
  | {
      kind: "window"
      windowId: number
      processId: number
      appName: string
      title?: string
    }
  | { kind: "application"; locator: AppLocator }
  | { kind: "desktop" }

export type AppLocator =
  | { kind: "bundleId"; bundleId: string }
  | { kind: "path"; path: string }
  | { kind: "displayName"; displayName: string }

/**
 * One pickable window from `record_list_capture_targets`.
 *
 * The identity fields are exactly what `CaptureScope["kind"] === "window"`
 * requires — the setup screen builds the scope out of a target rather than
 * synthesizing one from a kind, which is what makes window and application
 * scope real rather than a radio button.
 */
export interface CaptureTarget {
  windowId: number
  processId: number
  appName: string
  title: string
  /** The window that currently has focus. The picker preselects it. */
  focused: boolean
  minimized: boolean
}

/**
 * Build the scope a chosen kind + target actually means.
 *
 * Returns `null` when the choice is incomplete — a window or application scope
 * with no target is not a scope, and must never be silently widened to the
 * desktop.
 */
export function scopeForSelection(
  kind: CaptureScope["kind"],
  target: CaptureTarget | null
): CaptureScope | null {
  if (kind === "desktop") return { kind: "desktop" }
  if (!target) return null
  if (kind === "window") {
    return {
      kind: "window",
      windowId: target.windowId,
      processId: target.processId,
      appName: target.appName,
      ...(target.title ? { title: target.title } : {}),
    }
  }
  // Application scope follows every window of the app, so it is keyed by the
  // name the native side matches on, not by the window handle.
  return { kind: "application", locator: { kind: "displayName", displayName: target.appName } }
}

export type LimitKind = "duration" | "steps" | "bundleBytes" | "globalBytes"

export interface LimitUsage {
  kind: LimitKind
  used: number
  limit: number
}

export interface RecordLimits {
  maxDurationMs: number
  maxSteps: number
  maxBundleBytes: number
  maxGlobalBytes: number
}

export interface BundleManifest {
  schemaVersion: number
  recordingId: RecordingId
  startedAt: number
  scope: CaptureScope
  captureScreenshots: boolean
  limits: RecordLimits
  monitors: MonitorInfo[]
  appVersion: string
  platform: "windows" | "macos" | "linux" | "unsupported"
}

export type InterruptReason =
  | "killSwitch"
  | "limitReached"
  | "scopeLost"
  | "permissionLost"
  | "userInterrupt"
  | "appShutdown"
  | "nativeFailure"

/**
 * `open` means neither terminal record was written — the process died before it
 * could. Also recoverable: every step up to that moment is on disk.
 */
export type BundleOutcome = "completed" | "interrupted" | "open"

export interface RecordingBundle {
  manifest: BundleManifest
  /** Tombstoned (undone) steps are already removed. */
  steps: RecordedStep[]
  endedAt?: number
  outcome: BundleOutcome
  interruptReason?: InterruptReason
  /** Actions performed outside scope. A count only — never their content. */
  ignoredCount: number
  totalBytes: number
}

export interface RecoverableBundle {
  recordingId: RecordingId
  startedAt: number
  stepCount: number
  totalBytes: number
  outcome: BundleOutcome
  interruptReason?: InterruptReason
  scopeSummary: string
  scopeKind: string
}

export type RecorderPhaseNative = "recording" | "paused"

export interface RecordStatus {
  recording: boolean
  recordingId?: RecordingId
  phase?: RecorderPhaseNative
  stepCount: number
  startedAt?: number
  scope?: CaptureScope
  usage: LimitUsage[]
}

/** Base64 frame, fetched on demand. */
export interface AssetPayload {
  assetId: AssetId
  mimeType: string
  bytes: string
  meta: AssetMeta
}

/** Live progress event emitted on the `record:event` channel during a session. */
export type RecordEvent =
  | {
      type: "started"
      recordingId: RecordingId
      startedAt: number
      scope: CaptureScope
      limits: RecordLimits
    }
  | { type: "step"; step: RecordedStep }
  | { type: "paused"; at: number; stepCount: number }
  | { type: "resumed"; at: number }
  | { type: "undone"; seq: number; stepCount: number }
  | { type: "limitWarning"; usage: LimitUsage }
  | {
      type: "stopped"
      recordingId: RecordingId
      stepCount: number
      endedAt: number
      totalBytes: number
    }
  | {
      type: "interrupted"
      recordingId: RecordingId
      reason: InterruptReason
      stepCount: number
      recoverable: boolean
    }
  | { type: "error"; message: string }

/** Arguments accepted by `record_start`. */
export interface RecordStartArgs {
  /**
   * Caller-supplied so the Dexie row and the native bundle share one identity,
   * and so a reattach after a crash needs no lookup table. Must be a canonical
   * UUID — it names a directory.
   */
  recordingId: RecordingId
  scope: CaptureScope
  captureScreenshots?: boolean
  /** May only tighten the native defaults; the Rust side clamps. */
  limits?: RecordLimits
  maxWidth?: number
  maxHeight?: number
}

export type ProbeState = "ok" | "missing" | "unknown" | "notApplicable"

export interface StorageHeadroom {
  usedBytes: number
  globalLimitBytes: number
  bundleLimitBytes: number
  freeDiskBytes?: number | null
}

export interface RecordPreflight {
  ready: boolean
  /** Stable machine codes; the renderer maps each to localized copy. */
  blockers: string[]
  platform: BundleManifest["platform"]
  platformSupported: boolean
  pluginInstalled: boolean
  pluginEnabled: boolean
  granted: string[]
  missingGrants: string[]
  automationEnabled: boolean
  killSwitchEngaged: boolean
  alreadyRecording: boolean
  accessibility: ProbeState
  inputMonitoring: ProbeState
  screenRecording: ProbeState
  uiAutomation: ProbeState
  ocrBackends: string[]
  ocrAvailable: boolean
  storage: StorageHeadroom
  openBundles: number
}

/** The blocker codes `record_preflight` can report, mirrored from `preflight.rs`. */
export const PREFLIGHT_BLOCKERS = {
  killSwitch: "killSwitchEngaged",
  automationDisabled: "automationDisabled",
  platformUnsupported: "platformUnsupported",
  pluginNotInstalled: "pluginNotInstalled",
  pluginDisabled: "pluginDisabled",
  grantMissing: "grantMissing",
  alreadyRecording: "alreadyRecording",
  storageExhausted: "storageExhausted",
  accessibility: "accessibilityMissing",
  inputMonitoring: "inputMonitoringMissing",
  screenRecording: "screenRecordingMissing",
  uiAutomation: "uiAutomationUnavailable",
} as const

/**
 * A blocker code may be bare (`pluginDisabled`) or carry a detail after a colon
 * (`grantMissing:native:screen`). The i18n key is always the bare prefix.
 */
export function blockerCode(blocker: string): string {
  const colon = blocker.indexOf(":")
  return colon === -1 ? blocker : blocker.slice(0, colon)
}

export function blockerDetail(blocker: string): string | null {
  const colon = blocker.indexOf(":")
  return colon === -1 ? null : blocker.slice(colon + 1)
}

/** Human-facing description of the scope, for the setup and review headers. */
export function scopeSummary(scope: CaptureScope): string {
  switch (scope.kind) {
    case "window":
      return scope.title ? `${scope.appName} — ${scope.title}` : scope.appName
    case "application":
      switch (scope.locator.kind) {
        case "bundleId":
          return scope.locator.bundleId
        case "path":
          return scope.locator.path.split(/[/\\]/).pop() ?? scope.locator.path
        case "displayName":
          return scope.locator.displayName
      }
    case "desktop":
      return ""
  }
}

/**
 * Whether this step has anything an LLM could describe. Drives both the OCR
 * fallback's usefulness and the "needs a manual intent" review blocker.
 */
export function stepIsSemanticallyEmpty(step: RecordedStep): boolean {
  if (step.kind === "outOfScope") return true
  const blank = (value?: string) => !value || value.trim().length === 0
  return (
    blank(step.element?.name) &&
    blank(step.element?.automationId) &&
    blank(step.ocrHint) &&
    (!step.text || step.text.kind === "sensitive")
  )
}
