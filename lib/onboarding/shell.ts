import type { MobileRuntimeMode } from "@/lib/runtime/standalone-mode"
import type { OnboardingShell } from "@cognia/agent-config-types"
import type { Platform } from "@/lib/platform/detect"

/**
 * Resolve which of the four first-run contexts we are in (ADR-0122).
 *
 * The distinction that matters is not "desktop vs mobile" but *where the
 * compute lives*: a paired phone has no local runtime to scan for, because the
 * work runs on the desktop it pairs with. That is why `mobile-paired` and
 * `mobile-standalone` are separate shells rather than one "mobile".
 *
 * Pure, so `OnboardingGate` can call it without a hook and tests can drive
 * every branch without touching `window`. Callers supply the inputs:
 *
 * @param platform  From `detectPlatform()`.
 * @param mobileRuntimeMode The device-local paired/standalone choice, or
 *   `undefined` when the user has not made it yet.
 *
 * `headless` maps to `web`: the brain process has no first-run UI at all, and
 * the gate never renders there — mapping it to a real shell keeps this total
 * rather than forcing every caller to handle a null.
 *
 * An unchosen `mobileRuntimeMode` resolves to `mobile-standalone` rather than
 * `mobile-paired`, because the welcome step's mode fork is what sets it: a
 * phone that has not chosen yet must see the fork, and the standalone sequence
 * is the one that contains it. Resolving to `paired` would route a brand-new
 * phone straight at the pairing screen with no way to pick BYOK.
 */
export function resolveOnboardingShell(
  platform: Platform,
  mobileRuntimeMode: MobileRuntimeMode | undefined
): OnboardingShell {
  if (platform === "tauri") return "tauri"
  if (platform === "mobile") {
    return mobileRuntimeMode === "paired" ? "mobile-paired" : "mobile-standalone"
  }
  return "web"
}

/**
 * Whether this shell can host a local agent runtime at all. Drives the scan
 * step's `availableIn` and the starter-card capability gate: neither a browser
 * nor a phone runs agent CLIs, and a paired phone delegates to its desktop.
 */
export function shellHasLocalRuntime(shell: OnboardingShell): boolean {
  return shell === "tauri"
}
