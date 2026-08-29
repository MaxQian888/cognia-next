import type { Platform } from "@/lib/platform/detect"

export type RuntimeTargetKind = "standalone" | "companion" | "legacy-readonly"
export type CompanionHostKind = "desktop" | "cloud"

interface RuntimeTargetBase {
  /** Stable identifier used by persistence, queues, and diagnostics. */
  id: string
  kind: RuntimeTargetKind
  platform: Extract<Platform, "web" | "mobile">
}

export interface StandaloneRuntimeTarget extends RuntimeTargetBase {
  kind: "standalone"
}

export interface CompanionRuntimeTarget extends RuntimeTargetBase {
  kind: "companion"
  hostKind: CompanionHostKind
}

export interface LegacyReadonlyRuntimeTarget extends RuntimeTargetBase {
  kind: "legacy-readonly"
}

export type RuntimeTarget =
  StandaloneRuntimeTarget | CompanionRuntimeTarget | LegacyReadonlyRuntimeTarget

export interface RuntimeTargetResolutionInput {
  platform: Platform
  mobileRuntimeMode: "paired" | "standalone" | undefined
  webCompanionConfigured: boolean
}

/**
 * Resolve the execution target for shells that are clients of Cognia.
 *
 * Tauri and headless are execution hosts themselves, so they deliberately
 * return `null`. Mobile remains unselected until onboarding persists a mode.
 * An ordinary browser is standalone unless it has an explicit Companion
 * target; that makes BYOK a real Web execution path instead of WebStub.
 */
export function resolveRuntimeTarget(input: RuntimeTargetResolutionInput): RuntimeTarget | null {
  switch (input.platform) {
    case "tauri":
    case "headless":
      return null
    case "mobile":
      if (input.mobileRuntimeMode === "standalone") {
        return { id: "mobile-standalone", kind: "standalone", platform: "mobile" }
      }
      if (input.mobileRuntimeMode === "paired") {
        return {
          id: "mobile-companion",
          kind: "companion",
          platform: "mobile",
          hostKind: "desktop",
        }
      }
      return null
    case "web":
      return input.webCompanionConfigured
        ? {
            id: PLACEHOLDER_WEB_COMPANION_TARGET_ID,
            kind: "companion",
            platform: "web",
            hostKind: "cloud",
          }
        : { id: "web-standalone", kind: "standalone", platform: "web" }
  }
}

/**
 * The id {@link resolveRuntimeTarget} invents for "this browser is configured
 * as a companion, but which Host it talks to is not known yet".
 *
 * It is a **label**, not a target id. A real Web companion target is
 * registered under the Host's own id (`runtimeTargetInput` in
 * `lib/companion/host-orchestration.ts`), and the credential book files its
 * record under that id too. Nothing is ever stored under this string.
 *
 * The distinction is load-bearing because two different things read a runtime
 * target's id: the snapshot, where it only has to name a surface, and
 * `setActiveRuntimeTargetContext`, which is what `companionStorage().load()`
 * resolves a credential *by*. Letting the placeholder reach the second one
 * makes the client look unpaired to itself — the Host record exists, filed
 * under the real id, and the lookup asks for this one.
 */
export const PLACEHOLDER_WEB_COMPANION_TARGET_ID = "web-companion"

/**
 * True for a target id that names a surface rather than a stored target.
 *
 * Callers that route, resolve credentials, or key persistence must refuse it;
 * callers that only display may use it.
 */
export function isPlaceholderRuntimeTargetId(id: string | null | undefined): boolean {
  return id === PLACEHOLDER_WEB_COMPANION_TARGET_ID
}

export function isStandaloneRuntimeTarget(
  target: RuntimeTarget | null
): target is StandaloneRuntimeTarget {
  return target?.kind === "standalone"
}
