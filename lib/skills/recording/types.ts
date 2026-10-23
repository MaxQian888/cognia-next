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

import type {
  CaptureScope,
  CaptureTarget,
  RecordedStep,
} from "@cognia/plugin-contract/lib/skills/recording/types"
export type {
  AppLocator,
  AssetId,
  AssetMeta,
  AssetPayload,
  BundleManifest,
  BundleOutcome,
  CaptureScope,
  CaptureTarget,
  InterruptReason,
  LimitKind,
  LimitUsage,
  ProbeState,
  RecordEvent,
  RecordLimits,
  RecordPreflight,
  RecordStartArgs,
  RecordStatus,
  RecordedStep,
  RecorderPhaseNative,
  RecordingBundle,
  RecordingId,
  RecoverableBundle,
  SafeElement,
  StepKind,
  StorageHeadroom,
  TextCapture,
} from "@cognia/plugin-contract/lib/skills/recording/types"

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
