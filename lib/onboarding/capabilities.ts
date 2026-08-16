import type { OnboardingShell } from "@cognia/agent-config-types"
import type { OnboardingCapability } from "./scan"

/**
 * Facts the capability resolver needs. Supplied by the caller rather than read
 * here, so every branch is testable without a Tauri webview or a Dexie row.
 */
export interface CapabilityInput {
  shell: OnboardingShell
  /**
   * Whether an OCR provider is actually reachable. `"auto"` (the default)
   * routes to whatever is available, which on desktop always includes a local
   * engine; a user who pinned a cloud provider needs its credentials present.
   */
  ocrReady: boolean
  /** Whether a native camera / screenshot source exists to feed OCR. */
  hasImageSource: boolean
}

/**
 * Which starter-card capabilities this device can actually deliver.
 *
 * The rule the old tour broke: **only claim what was confirmed**. It pitched
 * OCR, automation, connectors and the digital twin on every machine regardless
 * of whether any of them were configured, which is how a first-run screen ends
 * up describing a product the user does not have.
 *
 * - `fs` — needs a real filesystem. Only the desktop shell has one; a browser
 *   cannot read a directory, and neither phone mode reaches the desktop's disk
 *   from within this flow.
 * - `ocr` — needs both an image source (screenshot on desktop, camera on a
 *   phone) and a reachable OCR provider. Either half missing means the card
 *   would fail after the user picked it, which is worse than not offering it.
 * - `web` — the reader runs anywhere, so it is the one capability every shell
 *   has. That is what makes `summarize-web` the universal fallback card.
 */
export function resolveCapabilities(input: CapabilityInput): OnboardingCapability[] {
  const out: OnboardingCapability[] = []
  if (input.shell === "tauri") out.push("fs")
  if (input.ocrReady && input.hasImageSource) out.push("ocr")
  out.push("web")
  return out
}

/**
 * Whether this shell can produce an image for OCR at all.
 *
 * A paired phone is excluded deliberately: screenshotting happens on the
 * desktop that runs the work, and nothing reports that desktop's capabilities
 * back to the phone — the companion handshake carries authorization scopes,
 * not feature flags. Offering the card here would promise a round trip the
 * flow cannot make.
 */
export function shellHasImageSource(shell: OnboardingShell): boolean {
  return shell === "tauri" || shell === "mobile-standalone"
}
