/**
 * Cross-platform "high-confidence confirmation" helper.
 *
 * Used to gate flips on settings that change the security posture of a
 * conversation — opening Computer Use, turning off the HITL guard,
 * exporting credentials, etc.
 *
 * The function is named `requireBiometric` because that is the original
 * intent (a fingerprint / Face ID step on phones), but the host platforms
 * we ship today don't expose a uniform biometric API:
 *
 *   - Tauri desktop: there is no shipped biometric plugin. We fall back
 *     to `@tauri-apps/plugin-dialog`'s `ask` which produces a native
 *     "Are you sure?" modal that the OS protects against accidental
 *     clicks (focus stealing, default button differs).
 *   - Web / unknown host: `window.confirm` — primitive but synchronous
 *     and screen-readable.
 *
 * In both cases the audit row should include `bioVerified: false` so
 * downstream consumers know this was a soft confirmation rather than a
 * real biometric scan. Promoting this to a true biometric step is a
 * follow-up once the platform plugin lands.
 */

import { isTauri } from "@/lib/tauri"

export interface BiometricPromptOptions {
  /** Title shown on the dialog. */
  title: string
  /** Body / explanation text. */
  message: string
  /** Affirmative button label (defaults to "Confirm"). */
  confirmLabel?: string
  /** Negative button label (defaults to "Cancel"). */
  cancelLabel?: string
}

export interface BiometricPromptResult {
  ok: boolean
  /** True only when a real biometric step ran. Always false today. */
  bioVerified: boolean
  /** Surface for tests / audit logs to know which path executed. */
  via: "tauri-dialog" | "browser-confirm" | "unavailable"
}

export async function requireBiometric(
  options: BiometricPromptOptions
): Promise<BiometricPromptResult> {
  if (isTauri()) {
    try {
      const { ask } = await import("@tauri-apps/plugin-dialog")
      const ok = await ask(options.message, {
        title: options.title,
        kind: "warning",
        okLabel: options.confirmLabel ?? "Confirm",
        cancelLabel: options.cancelLabel ?? "Cancel",
      })
      return { ok: Boolean(ok), bioVerified: false, via: "tauri-dialog" }
    } catch (err) {
      console.warn(
        "[biometric] tauri-plugin-dialog ask() failed:",
        err instanceof Error ? err.message : String(err)
      )
      return { ok: false, bioVerified: false, via: "unavailable" }
    }
  }
  if (typeof window !== "undefined" && typeof window.confirm === "function") {
    const ok = window.confirm(`${options.title}\n\n${options.message}`)
    return { ok, bioVerified: false, via: "browser-confirm" }
  }
  return { ok: false, bioVerified: false, via: "unavailable" }
}
